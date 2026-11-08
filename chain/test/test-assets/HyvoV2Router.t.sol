// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {HyvoV2Pair} from "../../src/test-assets/HyvoV2Pair.sol";
import {HyvoV2Router} from "../../src/test-assets/HyvoV2Router.sol";
import {HyvoV2Fixture} from "./utils/HyvoV2Fixture.sol";
import {EthRejecter} from "./utils/Mocks.sol";

/// @dev Router behaviour that does not depend on where WETH sits in the pair.
contract HyvoV2RouterTest is HyvoV2Fixture {
    HyvoV2Pair internal pairWithoutWeth;

    function setUp() public override {
        super.setUp();
        pairWithoutWeth = new HyvoV2Pair(address(lowToken), address(highToken), DEFAULT_FEE_BPS);
    }

    // constructor and receive

    function test_constructor_storesWeth() public view {
        assertEq(router.weth(), address(weth));
    }

    function test_constructor_revertsOnZeroWeth() public {
        vm.expectRevert(HyvoV2Router.ZeroAddress.selector);
        new HyvoV2Router(address(0));
    }

    function test_receive_acceptsEthFromWeth() public {
        vm.deal(address(weth), 1 ether);
        vm.prank(address(weth));
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(router).balance, 1 ether);
    }

    function test_receive_revertsForOtherSenders() public {
        (bool ok, bytes memory reason) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(HyvoV2Router.OnlyWeth.selector));
    }

    // getAmountOut

    /// @dev Shared with the engine's replay: 1 ETH into 100 ETH / 1,000,000 tokens and 10,000 tokens back.
    function test_getAmountOut_matchesReferenceVectors() public view {
        assertEq(router.getAmountOut(1e18, 100e18, 1_000_000e18, 30), 9871580343970612988504);
        assertEq(router.getAmountOut(1e18, 100e18, 1_000_000e18, 0), 9900990099009900990099);
        assertEq(router.getAmountOut(1e18, 100e18, 1_000_000e18, 1000), 8919722497522299306243);
        assertEq(router.getAmountOut(10_000e18, 1_000_000e18, 100e18, 30), 987158034397061298);
    }

    function test_getAmountOut_roundsDownToZeroForDust() public view {
        assertEq(router.getAmountOut(1, 1_000_000e18, 100e18, 30), 0);
    }

    function test_getAmountOut_revertsOnZeroAmountIn() public {
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        router.getAmountOut(0, 1e18, 1e18, 30);
    }

    function test_getAmountOut_revertsOnAnEmptyReserve() public {
        vm.expectRevert(HyvoV2Router.InsufficientLiquidity.selector);
        router.getAmountOut(1e18, 0, 1e18, 30);
        vm.expectRevert(HyvoV2Router.InsufficientLiquidity.selector);
        router.getAmountOut(1e18, 1e18, 0, 30);
    }

    function test_getAmountOut_revertsOnFeeAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(HyvoV2Router.FeeTooHigh.selector, uint16(1001)));
        router.getAmountOut(1e18, 1e18, 1e18, 1001);
    }

    // pairs without WETH

    function test_quoteBuy_revertsForPairWithoutWeth() public {
        vm.expectRevert(HyvoV2Router.PairWithoutWeth.selector);
        router.quoteBuy(address(pairWithoutWeth), 1 ether);
    }

    function test_quoteSell_revertsForPairWithoutWeth() public {
        vm.expectRevert(HyvoV2Router.PairWithoutWeth.selector);
        router.quoteSell(address(pairWithoutWeth), 1e18);
    }

    function test_addLiquidityETH_revertsForPairWithoutWeth() public {
        vm.expectRevert(HyvoV2Router.PairWithoutWeth.selector);
        router.addLiquidityETH{value: 1 ether}(address(pairWithoutWeth), 1e18, address(this));
    }

    function test_swapExactETHForTokens_revertsForPairWithoutWeth() public {
        vm.expectRevert(HyvoV2Router.PairWithoutWeth.selector);
        router.swapExactETHForTokens{value: 1 ether}(address(pairWithoutWeth), 0, address(this), block.timestamp);
    }

    function test_swapExactTokensForETH_revertsForPairWithoutWeth() public {
        vm.expectRevert(HyvoV2Router.PairWithoutWeth.selector);
        router.swapExactTokensForETH(address(pairWithoutWeth), 1e18, 0, address(this), block.timestamp);
    }
}

/// @dev Quotes, liquidity and swaps against a seeded 100 ETH / 1,000,000 token pair. Runs once with WETH
///      as token0 and once with WETH as token1.
abstract contract HyvoV2RouterSwapTest is HyvoV2Fixture {
    uint256 internal constant ETH_RESERVE = 100 ether;
    uint256 internal constant TOKEN_RESERVE = 1_000_000e18;
    /// @dev Outputs for 1 ETH in and 10,000 tokens in at the seeded reserves and the default fee.
    uint256 internal constant BUY_1_ETH_OUT = 9871580343970612988504;
    uint256 internal constant SELL_10K_TOKENS_OUT = 987158034397061298;

    address internal trader = makeAddr("trader");
    address internal recipient = makeAddr("recipient");

    function _wethIsToken0() internal pure virtual returns (bool);

    function setUp() public override {
        super.setUp();
        _useWethPair(_wethIsToken0(), DEFAULT_FEE_BPS);
        _seed(ETH_RESERVE, TOKEN_RESERVE);
        vm.deal(trader, 1_000 ether);
    }

    function test_setUp_placesWethAtTheConfiguredIndex() public view {
        assertEq(pair.token0() == address(weth), _wethIsToken0());
    }

    // quotes

    function test_quoteBuy_spendsWethReserveForTokens() public view {
        assertEq(router.quoteBuy(address(pair), 1 ether), BUY_1_ETH_OUT);
    }

    function test_quoteSell_spendsTokenReserveForWeth() public view {
        assertEq(router.quoteSell(address(pair), 10_000e18), SELL_10K_TOKENS_OUT);
    }

    function test_quotes_revertOnZeroAmount() public {
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        router.quoteBuy(address(pair), 0);
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        router.quoteSell(address(pair), 0);
    }

    function test_quotes_revertOnAnEmptyPair() public {
        _useWethPair(_wethIsToken0(), DEFAULT_FEE_BPS);
        vm.expectRevert(HyvoV2Router.InsufficientLiquidity.selector);
        router.quoteBuy(address(pair), 1 ether);
        vm.expectRevert(HyvoV2Router.InsufficientLiquidity.selector);
        router.quoteSell(address(pair), 1e18);
    }

    // addLiquidityETH

    function test_addLiquidityETH_firstDepositMintsToRecipient() public {
        _useWethPair(_wethIsToken0(), DEFAULT_FEE_BPS);
        token.mint(trader, 4e18);

        vm.startPrank(trader);
        token.approve(address(router), 4e18);
        uint256 liquidity = router.addLiquidityETH{value: 1 ether}(address(pair), 4e18, recipient);
        vm.stopPrank();

        assertEq(liquidity, 2e18 - 1000);
        assertEq(pair.balanceOf(recipient), liquidity);
        assertEq(pair.balanceOf(DEAD), 1000);
        assertEq(token.balanceOf(trader), 0);
        assertEq(trader.balance, 999 ether);
        _assertReservesWethToken(1 ether, 4e18);
        _assertRouterHoldsNothing();
    }

    function test_addLiquidityETH_laterDepositAtThePoolRatio() public {
        uint256 supply = pair.totalSupply();
        token.mint(trader, 10_000e18);

        vm.startPrank(trader);
        token.approve(address(router), 10_000e18);
        uint256 liquidity = router.addLiquidityETH{value: 1 ether}(address(pair), 10_000e18, trader);
        vm.stopPrank();

        assertEq(liquidity, supply / 100);
        _assertReservesWethToken(ETH_RESERVE + 1 ether, TOKEN_RESERVE + 10_000e18);
        _assertRouterHoldsNothing();
    }

    function test_addLiquidityETH_revertsOnZeroAmounts() public {
        vm.startPrank(trader);
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        router.addLiquidityETH{value: 1 ether}(address(pair), 0, trader);
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        router.addLiquidityETH(address(pair), 1e18, trader);
        vm.stopPrank();
    }

    function test_addLiquidityETH_revertsWithoutAllowance() public {
        token.mint(trader, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 1e18)
        );
        vm.prank(trader);
        router.addLiquidityETH{value: 1 ether}(address(pair), 1e18, trader);
    }

    // swapExactETHForTokens

    function test_swapExactETHForTokens_outputsTheQuote() public {
        (uint256 amount0In, uint256 amount1In) = _byTokenIndex(1 ether, 0);
        (uint256 amount0Out, uint256 amount1Out) = _byTokenIndex(0, BUY_1_ETH_OUT);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Swap(address(router), amount0In, amount1In, amount0Out, amount1Out, recipient);

        vm.prank(trader);
        uint256 amountOut =
            router.swapExactETHForTokens{value: 1 ether}(address(pair), BUY_1_ETH_OUT, recipient, block.timestamp);

        assertEq(amountOut, BUY_1_ETH_OUT);
        assertEq(token.balanceOf(recipient), amountOut);
        assertEq(trader.balance, 999 ether);
        _assertReservesWethToken(ETH_RESERVE + 1 ether, TOKEN_RESERVE - amountOut);
        _assertRouterHoldsNothing();
    }

    function test_swapExactETHForTokens_revertsAfterTheDeadline() public {
        vm.expectRevert(HyvoV2Router.Expired.selector);
        vm.prank(trader);
        router.swapExactETHForTokens{value: 1 ether}(address(pair), 0, trader, block.timestamp - 1);
    }

    function test_swapExactETHForTokens_revertsOnZeroValue() public {
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        vm.prank(trader);
        router.swapExactETHForTokens(address(pair), 0, trader, block.timestamp);
    }

    function test_swapExactETHForTokens_revertsBelowTheMinimumOutput() public {
        vm.expectRevert(
            abi.encodeWithSelector(HyvoV2Router.InsufficientOutput.selector, BUY_1_ETH_OUT, BUY_1_ETH_OUT + 1)
        );
        vm.prank(trader);
        router.swapExactETHForTokens{value: 1 ether}(address(pair), BUY_1_ETH_OUT + 1, trader, block.timestamp);
    }

    function test_swapExactETHForTokens_revertsOnZeroOutput() public {
        _useWethPair(_wethIsToken0(), DEFAULT_FEE_BPS);
        _seed(1_000 ether, 1e9); // one wei buys less than one token unit
        vm.expectRevert(abi.encodeWithSelector(HyvoV2Router.InsufficientOutput.selector, 0, 0));
        vm.prank(trader);
        router.swapExactETHForTokens{value: 1}(address(pair), 0, trader, block.timestamp);
    }

    function test_swapExactETHForTokens_revertsWhenRecipientIsAPairToken() public {
        vm.expectRevert(HyvoV2Pair.InvalidTo.selector);
        vm.prank(trader);
        router.swapExactETHForTokens{value: 1 ether}(address(pair), 0, address(token), block.timestamp);
    }

    // swapExactTokensForETH

    function test_swapExactTokensForETH_outputsTheQuote() public {
        token.mint(trader, 10_000e18);
        (uint256 amount0In, uint256 amount1In) = _byTokenIndex(0, 10_000e18);
        (uint256 amount0Out, uint256 amount1Out) = _byTokenIndex(SELL_10K_TOKENS_OUT, 0);

        vm.startPrank(trader);
        token.approve(address(router), 10_000e18);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Swap(address(router), amount0In, amount1In, amount0Out, amount1Out, address(router));
        uint256 amountOut =
            router.swapExactTokensForETH(address(pair), 10_000e18, SELL_10K_TOKENS_OUT, recipient, block.timestamp);
        vm.stopPrank();

        assertEq(amountOut, SELL_10K_TOKENS_OUT);
        assertEq(recipient.balance, amountOut);
        assertEq(token.balanceOf(trader), 0);
        _assertReservesWethToken(ETH_RESERVE - amountOut, TOKEN_RESERVE + 10_000e18);
        _assertRouterHoldsNothing();
    }

    function test_swapExactTokensForETH_revertsAfterTheDeadline() public {
        vm.expectRevert(HyvoV2Router.Expired.selector);
        vm.prank(trader);
        router.swapExactTokensForETH(address(pair), 1e18, 0, trader, block.timestamp - 1);
    }

    function test_swapExactTokensForETH_revertsOnZeroAmount() public {
        vm.expectRevert(HyvoV2Router.ZeroAmount.selector);
        vm.prank(trader);
        router.swapExactTokensForETH(address(pair), 0, 0, trader, block.timestamp);
    }

    function test_swapExactTokensForETH_revertsBelowTheMinimumOutput() public {
        _giveTokensWithAllowance(trader, 10_000e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                HyvoV2Router.InsufficientOutput.selector, SELL_10K_TOKENS_OUT, SELL_10K_TOKENS_OUT + 1
            )
        );
        vm.prank(trader);
        router.swapExactTokensForETH(address(pair), 10_000e18, SELL_10K_TOKENS_OUT + 1, trader, block.timestamp);
    }

    function test_swapExactTokensForETH_revertsOnZeroOutput() public {
        _giveTokensWithAllowance(trader, 1);
        vm.expectRevert(abi.encodeWithSelector(HyvoV2Router.InsufficientOutput.selector, 0, 0));
        vm.prank(trader);
        router.swapExactTokensForETH(address(pair), 1, 0, trader, block.timestamp);
    }

    function test_swapExactTokensForETH_revertsWithoutAllowance() public {
        token.mint(trader, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 1e18)
        );
        vm.prank(trader);
        router.swapExactTokensForETH(address(pair), 1e18, 0, trader, block.timestamp);
    }

    function test_swapExactTokensForETH_revertsWhenRecipientRejectsEth() public {
        _giveTokensWithAllowance(trader, 1e18);
        address rejecter = address(new EthRejecter());
        vm.expectRevert(HyvoV2Router.EthTransferFailed.selector);
        vm.prank(trader);
        router.swapExactTokensForETH(address(pair), 1e18, 0, rejecter, block.timestamp);
    }

    function _giveTokensWithAllowance(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(router), amount);
    }

    /// @dev Orders a (WETH amount, token amount) pair as (token0 amount, token1 amount).
    function _byTokenIndex(uint256 wethAmount, uint256 tokenAmount) internal pure returns (uint256, uint256) {
        return _wethIsToken0() ? (wethAmount, tokenAmount) : (tokenAmount, wethAmount);
    }
}

contract HyvoV2RouterSwapWethToken0Test is HyvoV2RouterSwapTest {
    function _wethIsToken0() internal pure override returns (bool) {
        return true;
    }
}

contract HyvoV2RouterSwapWethToken1Test is HyvoV2RouterSwapTest {
    function _wethIsToken0() internal pure override returns (bool) {
        return false;
    }
}
