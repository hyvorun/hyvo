// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HyvoV2Pair} from "./HyvoV2Pair.sol";
import {TestWETH} from "./TestWETH.sol";

/// @title HyvoV2Router
/// @notice Single-hop ETH <-> token swaps, and ETH liquidity, through one HyvoV2Pair that holds WETH.
/// @dev Every swap outputs exactly `getAmountOut(amountIn, reserveIn, reserveOut, pair.feeBps())` for the
///      pair's reserves before the swap; the engine replays recorded swaps with the same integer formula.
///      The router holds no balance between calls.
contract HyvoV2Router {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint16 private constant MAX_FEE_BPS = 1000;

    /// @notice The wrapped-ether token that every routed pair must contain.
    address public immutable weth;

    /// @notice The WETH address is zero.
    error ZeroAddress();
    /// @notice `block.timestamp` is past the deadline.
    error Expired();
    /// @notice An input amount is zero.
    error ZeroAmount();
    /// @notice A reserve is zero, so the pool has no price yet.
    error InsufficientLiquidity();
    /// @notice The fee is above 1000 bps (10%), the highest a pair accepts.
    error FeeTooHigh(uint16 feeBps);
    /// @notice The swap would output zero, or less than `amountOutMin`.
    error InsufficientOutput(uint256 amountOut, uint256 amountOutMin);
    /// @notice Neither token of the pair is WETH.
    error PairWithoutWeth();
    /// @notice ETH was sent by an address other than WETH.
    error OnlyWeth();
    /// @notice Sending ETH to the recipient failed.
    error EthTransferFailed();

    /// @dev A pair's tokens and reserves seen from the WETH side.
    struct Market {
        address token;
        uint256 reserveWeth;
        uint256 reserveToken;
        uint16 feeBps;
        bool wethIsToken0;
    }

    constructor(address weth_) {
        if (weth_ == address(0)) revert ZeroAddress();
        weth = weth_;
    }

    /// @notice Accepts ETH only from WETH, while unwrapping swap proceeds.
    receive() external payable {
        if (msg.sender != weth) revert OnlyWeth();
    }

    /// @notice Output of swapping `amountIn` into a pool with `reserveIn`/`reserveOut` and an input fee of
    ///         `feeBps`, rounded down:
    ///         `amountInWithFee = amountIn * (10000 - feeBps)`,
    ///         `amountOut = amountInWithFee * reserveOut / (reserveIn * 10000 + amountInWithFee)`.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint16 feeBps)
        public
        pure
        returns (uint256)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        uint256 amountInWithFee = amountIn * (BPS - feeBps);
        return amountInWithFee * reserveOut / (reserveIn * BPS + amountInWithFee);
    }

    /// @notice Tokens that `swapExactETHForTokens` would output for `ethIn` wei at the current reserves.
    function quoteBuy(address pair, uint256 ethIn) external view returns (uint256 tokensOut) {
        Market memory market = _market(pair);
        return getAmountOut(ethIn, market.reserveWeth, market.reserveToken, market.feeBps);
    }

    /// @notice Wei that `swapExactTokensForETH` would output for `tokensIn` at the current reserves.
    function quoteSell(address pair, uint256 tokensIn) external view returns (uint256 ethOut) {
        Market memory market = _market(pair);
        return getAmountOut(tokensIn, market.reserveToken, market.reserveWeth, market.feeBps);
    }

    /// @notice Deposits `amountToken` (pulled from the caller) and `msg.value` (wrapped to WETH) into `pair`
    ///         and mints the LP shares to `to`.
    /// @dev Amounts are deposited as given. After the first deposit, any amount above the pool ratio stays
    ///      in the pool, so later deposits should match the current ratio.
    function addLiquidityETH(address pair, uint256 amountToken, address to)
        external
        payable
        returns (uint256 liquidity)
    {
        if (amountToken == 0 || msg.value == 0) revert ZeroAmount();
        Market memory market = _market(pair);
        IERC20(market.token).safeTransferFrom(msg.sender, pair, amountToken);
        _wrapTo(pair, msg.value);
        return HyvoV2Pair(pair).mint(to);
    }

    /// @notice Swaps exactly `msg.value` wei for tokens, sent to `to`.
    function swapExactETHForTokens(address pair, uint256 amountOutMin, address to, uint256 deadline)
        external
        payable
        returns (uint256 amountOut)
    {
        _checkDeadline(deadline);
        Market memory market = _market(pair);
        amountOut = getAmountOut(msg.value, market.reserveWeth, market.reserveToken, market.feeBps);
        _checkOutput(amountOut, amountOutMin);

        _wrapTo(pair, msg.value);
        (uint256 amount0Out, uint256 amount1Out) =
            market.wethIsToken0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        HyvoV2Pair(pair).swap(amount0Out, amount1Out, to);
    }

    /// @notice Swaps exactly `amountIn` tokens (pulled from the caller) for ETH, sent to `to`.
    function swapExactTokensForETH(address pair, uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        _checkDeadline(deadline);
        Market memory market = _market(pair);
        amountOut = getAmountOut(amountIn, market.reserveToken, market.reserveWeth, market.feeBps);
        _checkOutput(amountOut, amountOutMin);

        IERC20(market.token).safeTransferFrom(msg.sender, pair, amountIn);
        (uint256 amount0Out, uint256 amount1Out) =
            market.wethIsToken0 ? (amountOut, uint256(0)) : (uint256(0), amountOut);
        HyvoV2Pair(pair).swap(amount0Out, amount1Out, address(this));
        TestWETH(payable(weth)).withdraw(amountOut);
        (bool sent,) = to.call{value: amountOut}("");
        if (!sent) revert EthTransferFailed();
    }

    function _market(address pair) private view returns (Market memory market) {
        HyvoV2Pair pool = HyvoV2Pair(pair);
        address token0 = pool.token0();
        address token1 = pool.token1();
        (uint112 reserve0, uint112 reserve1,) = pool.getReserves();
        if (token0 == weth) {
            market = Market(token1, reserve0, reserve1, pool.feeBps(), true);
        } else if (token1 == weth) {
            market = Market(token0, reserve1, reserve0, pool.feeBps(), false);
        } else {
            revert PairWithoutWeth();
        }
    }

    function _wrapTo(address pair, uint256 amount) private {
        TestWETH(payable(weth)).deposit{value: amount}();
        IERC20(weth).safeTransfer(pair, amount);
    }

    function _checkDeadline(uint256 deadline) private view {
        // A deadline is a block-time bound by design.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired();
    }

    function _checkOutput(uint256 amountOut, uint256 amountOutMin) private pure {
        if (amountOut == 0 || amountOut < amountOutMin) revert InsufficientOutput(amountOut, amountOutMin);
    }
}
