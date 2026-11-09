// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HyvoV2Pair} from "../../src/test-assets/HyvoV2Pair.sol";
import {TestWETH} from "../../src/test-assets/TestWETH.sol";

/// @dev The three Uniswap V2 Router02 functions that SellCheck.checkV2 calls, over HyvoV2Pair, written the
///      way UniswapV2Router02 writes them: the "SupportingFeeOnTransferTokens" swaps read what reached the
///      pair, and a failed `transferFrom` reverts with TransferHelper's message, as on the real router.
contract MockV2Router02 {
    address public immutable WETH;
    mapping(address => mapping(address => address)) public pairFor;

    constructor(address weth_) {
        WETH = weth_;
    }

    receive() external payable {
        require(msg.sender == WETH, "only WETH");
    }

    function register(HyvoV2Pair pair) external {
        address token0 = pair.token0();
        address token1 = pair.token1();
        pairFor[token0][token1] = address(pair);
        pairFor[token1][token0] = address(pair);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "UniswapV2Library: INVALID_PATH");
        HyvoV2Pair pair = _pair(path[0], path[1]);
        (uint256 reserveIn, uint256 reserveOut) = _reserves(pair, path[0]);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _amountOut(amountIn, reserveIn, reserveOut, pair.feeBps());
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable {
        // A deadline is a block-time bound by design, as on Router02.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= deadline, "UniswapV2Router: EXPIRED");
        require(path.length == 2 && path[0] == WETH, "UniswapV2Router: INVALID_PATH");
        HyvoV2Pair pair = _pair(path[0], path[1]);
        TestWETH(payable(WETH)).deposit{value: msg.value}();
        require(IERC20(WETH).transfer(address(pair), msg.value), "WETH transfer");
        uint256 balanceBefore = IERC20(path[1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(pair, path[0], to);
        require(
            IERC20(path[1]).balanceOf(to) - balanceBefore >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
        );
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        // A deadline is a block-time bound by design, as on Router02.
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= deadline, "UniswapV2Router: EXPIRED");
        require(path.length == 2 && path[1] == WETH, "UniswapV2Router: INVALID_PATH");
        HyvoV2Pair pair = _pair(path[0], path[1]);
        _safeTransferFrom(path[0], msg.sender, address(pair), amountIn);
        _swapSupportingFeeOnTransferTokens(pair, path[0], address(this));
        uint256 amountOut = IERC20(WETH).balanceOf(address(this));
        require(amountOut >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        TestWETH(payable(WETH)).withdraw(amountOut);
        (bool sent,) = to.call{value: amountOut}("");
        require(sent, "TransferHelper: ETH_TRANSFER_FAILED");
    }

    function _swapSupportingFeeOnTransferTokens(HyvoV2Pair pair, address input, address to) private {
        (uint256 reserveIn, uint256 reserveOut) = _reserves(pair, input);
        uint256 amountIn = IERC20(input).balanceOf(address(pair)) - reserveIn;
        uint256 amountOut = _amountOut(amountIn, reserveIn, reserveOut, pair.feeBps());
        (uint256 amount0Out, uint256 amount1Out) =
            input == pair.token0() ? (uint256(0), amountOut) : (amountOut, uint256(0));
        pair.swap(amount0Out, amount1Out, to);
    }

    function _pair(address a, address b) private view returns (HyvoV2Pair) {
        address pair = pairFor[a][b];
        require(pair != address(0), "no pair");
        return HyvoV2Pair(pair);
    }

    function _reserves(HyvoV2Pair pair, address input) private view returns (uint256 reserveIn, uint256 reserveOut) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        (reserveIn, reserveOut) = input == pair.token0() ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint16 feeBps)
        private
        pure
        returns (uint256)
    {
        require(amountIn > 0, "UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "UniswapV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * (10_000 - feeBps);
        return amountInWithFee * reserveOut / (reserveIn * 10_000 + amountInWithFee);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TransferHelper: TRANSFER_FROM_FAILED");
    }
}

/// @dev Takes 5% of every transfer for a tax wallet, buys and sells included.
contract TaxedToken is ERC20 {
    address public constant TAX_WALLET = address(0x7A7);
    uint256 public constant TAX_BPS = 500;

    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 tax = value * TAX_BPS / 10_000;
        super._update(from, TAX_WALLET, tax);
        super._update(from, to, value - tax);
    }
}

/// @dev No tax, but once `blockSells` is on nothing may be sent into the pair: buys work, sells revert.
contract SellBlockedToken is ERC20 {
    address public pair;
    bool public blockSells;

    constructor() ERC20("Blocked", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPair(address pair_, bool blockSells_) external {
        pair = pair_;
        blockSells = blockSells_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blockSells && to == pair) revert("sell blocked");
        super._update(from, to, value);
    }
}

/// @dev A Pons-v2-style bonding curve quoted in native ETH, with the integer math of PonsV2BondingCurve: the
///      fee, the creator tax and the snipe tax come off the quote leg (the ETH paid in on a buy, the ETH paid
///      out on a sell), and the rest is priced on constant-product reserves.
contract MockPonsCurve {
    uint256 private constant BPS = 10_000;

    IERC20 public immutable token;
    uint256 public immutable feeBps;
    uint256 public immutable creatorTaxBps;
    uint256 public snipeTaxBps;
    uint256 private _quoteReserve;
    uint256 private _tokenReserve;

    constructor(IERC20 token_, uint256 feeBps_, uint256 creatorTaxBps_, uint256 virtualQuote, uint256 tokens) {
        token = token_;
        feeBps = feeBps_;
        creatorTaxBps = creatorTaxBps_;
        _quoteReserve = virtualQuote;
        _tokenReserve = tokens;
    }

    function setSnipeTax(uint256 bps) external {
        snipeTaxBps = bps;
    }

    function currentSnipeTaxBps(address) external view returns (uint256) {
        return snipeTaxBps;
    }

    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve) {
        return (_quoteReserve, _tokenReserve);
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 out) {
        require(msg.value == quoteIn, "value");
        uint256 snipe = snipeTaxBps;
        if (snipe != 0) {
            uint256 maxSnipe = BPS - feeBps - creatorTaxBps - 100;
            if (snipe > maxSnipe) snipe = maxSnipe;
        }
        uint256 net = quoteIn - quoteIn * feeBps / BPS - quoteIn * creatorTaxBps / BPS - quoteIn * snipe / BPS;
        out = net * _tokenReserve / (_quoteReserve + net);
        require(out >= minTokensOut, "SlippageExceeded");
        _quoteReserve += net;
        _tokenReserve -= out;
        require(token.transfer(recipient, out), "transfer");
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut) {
        uint256 gross = tokensIn * _quoteReserve / (_tokenReserve + tokensIn);
        require(token.transferFrom(msg.sender, address(this), tokensIn), "transferFrom");
        quoteOut = gross - gross * feeBps / BPS - gross * creatorTaxBps / BPS;
        require(quoteOut >= minQuoteOut, "SlippageExceeded");
        _quoteReserve -= gross;
        _tokenReserve += tokensIn;
        (bool sent,) = recipient.call{value: quoteOut}("");
        require(sent, "ETH transfer");
    }
}
