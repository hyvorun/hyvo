// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HyvoV2Pair} from "../../src/test-assets/HyvoV2Pair.sol";
import {HyvoV2Router} from "../../src/test-assets/HyvoV2Router.sol";
import {TestToken} from "../../src/test-assets/TestToken.sol";
import {HyvoV2Fixture, ReferenceMath} from "./utils/HyvoV2Fixture.sol";
import {HyvoV2Handler} from "./utils/HyvoV2Handler.sol";

/// @dev Fuzzed properties of the swap and liquidity math, over both token orders, fees from 0 to 1000 bps,
///      reserves from 1e9 units up to 1e27 wei / 1e33 token units, and trades from 1 unit up to the same
///      sizes, spread across orders of magnitude.
contract HyvoV2PropertiesTest is HyvoV2Fixture {
    uint256 internal constant MIN_RESERVE = 1e9;
    uint256 internal constant MAX_ETH = 1e27;
    uint256 internal constant MAX_TOKENS = 1e33;

    address internal trader = makeAddr("trader");
    address internal lp = makeAddr("lp");

    // (a) A swap outputs exactly getAmountOut for the reserves before it.

    function testFuzz_buyOutputsExactlyGetAmountOut(
        bool wethIsToken0,
        uint256 feeSeed,
        uint256 ethSeed,
        uint256 tokenSeed,
        uint256 ethIn
    ) public {
        (uint16 fee, uint256 ethReserve, uint256 tokenReserve) = _fuzzedPool(wethIsToken0, feeSeed, ethSeed, tokenSeed);
        ethIn = _boundLog(ethIn, 1, MAX_ETH);
        uint256 expected = ReferenceMath.amountOut(ethIn, ethReserve, tokenReserve, fee);
        assertEq(router.getAmountOut(ethIn, ethReserve, tokenReserve, fee), expected);
        assertEq(router.quoteBuy(address(pair), ethIn), expected);
        vm.deal(trader, ethIn);

        if (expected == 0) vm.expectRevert(abi.encodeWithSelector(HyvoV2Router.InsufficientOutput.selector, 0, 0));
        vm.prank(trader);
        uint256 amountOut = router.swapExactETHForTokens{value: ethIn}(address(pair), 0, trader, block.timestamp);
        if (expected == 0) return;

        assertEq(amountOut, expected);
        assertEq(token.balanceOf(trader), expected);
        _assertReservesWethToken(ethReserve + ethIn, tokenReserve - expected);
    }

    function testFuzz_sellOutputsExactlyGetAmountOut(
        bool wethIsToken0,
        uint256 feeSeed,
        uint256 ethSeed,
        uint256 tokenSeed,
        uint256 tokensIn
    ) public {
        (uint16 fee, uint256 ethReserve, uint256 tokenReserve) = _fuzzedPool(wethIsToken0, feeSeed, ethSeed, tokenSeed);
        tokensIn = _boundLog(tokensIn, 1, MAX_TOKENS);
        uint256 expected = ReferenceMath.amountOut(tokensIn, tokenReserve, ethReserve, fee);
        assertEq(router.getAmountOut(tokensIn, tokenReserve, ethReserve, fee), expected);
        assertEq(router.quoteSell(address(pair), tokensIn), expected);
        _giveTokensWithAllowance(trader, tokensIn);

        if (expected == 0) vm.expectRevert(abi.encodeWithSelector(HyvoV2Router.InsufficientOutput.selector, 0, 0));
        vm.prank(trader);
        uint256 amountOut = router.swapExactTokensForETH(address(pair), tokensIn, 0, trader, block.timestamp);
        if (expected == 0) return;

        assertEq(amountOut, expected);
        assertEq(trader.balance, expected);
        _assertReservesWethToken(ethReserve - expected, tokenReserve + tokensIn);
    }

    /// @dev getAmountOut is the largest output the pair accepts, so the formula is exact, not just safe.
    function testFuzz_pairRefusesOneUnitMoreThanGetAmountOut(
        bool zeroForOne,
        uint256 feeSeed,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 amountIn
    ) public {
        uint16 fee = uint16(bound(feeSeed, 0, 1000));
        reserveIn = _boundLog(reserveIn, MIN_RESERVE, MAX_TOKENS);
        reserveOut = _boundLog(reserveOut, MIN_RESERVE, MAX_TOKENS);
        amountIn = _boundLog(amountIn, 1, MAX_TOKENS);
        (TestToken tokenIn, TestToken tokenOut) = zeroForOne ? (lowToken, highToken) : (highToken, lowToken);
        HyvoV2Pair plain = new HyvoV2Pair(address(lowToken), address(highToken), fee);
        tokenIn.mint(address(plain), reserveIn);
        tokenOut.mint(address(plain), reserveOut);
        plain.mint(lp);

        uint256 amountOut = ReferenceMath.amountOut(amountIn, reserveIn, reserveOut, fee);
        tokenIn.mint(address(plain), amountIn);

        // One more unit fails the K check, or the reserve bound when it would empty the pool.
        vm.expectRevert(
            amountOut + 1 < reserveOut ? HyvoV2Pair.KInvariant.selector : HyvoV2Pair.InsufficientLiquidity.selector
        );
        _swapOut(plain, zeroForOne, amountOut + 1);
        if (amountOut == 0) return;

        _swapOut(plain, zeroForOne, amountOut);
        assertEq(tokenOut.balanceOf(trader), amountOut);
    }

    // (b) K = reserve0 * reserve1 never decreases across swaps.

    function testFuzz_kNeverDecreasesAcrossSwaps(
        bool wethIsToken0,
        uint256 feeSeed,
        uint256 ethSeed,
        uint256 tokenSeed,
        uint256[8] calldata steps
    ) public {
        (,, uint256 tokenReserve) = _fuzzedPool(wethIsToken0, feeSeed, ethSeed, tokenSeed);
        _giveTokensWithAllowance(trader, tokenReserve);

        uint256 k = _k();
        for (uint256 i; i < steps.length; ++i) {
            _swapFromSeed(steps[i]);
            uint256 kAfter = _k();
            assertGe(kAfter, k, "K decreased");
            k = kAfter;
        }
    }

    // (c) Buying and selling straight back never returns more ETH than was spent.

    function testFuzz_buyThenSellNeverReturnsMoreEth(
        bool wethIsToken0,
        uint256 feeSeed,
        uint256 ethSeed,
        uint256 tokenSeed,
        uint256 ethIn
    ) public {
        _fuzzedPool(wethIsToken0, feeSeed, ethSeed, tokenSeed);
        ethIn = _boundLog(ethIn, 1, MAX_ETH);
        uint256 tokensOut = router.quoteBuy(address(pair), ethIn);
        if (tokensOut == 0) return; // such a buy reverts, see testFuzz_buyOutputsExactlyGetAmountOut

        vm.deal(trader, ethIn);
        vm.startPrank(trader);
        router.swapExactETHForTokens{value: ethIn}(address(pair), tokensOut, trader, block.timestamp);
        uint256 ethBack = router.quoteSell(address(pair), tokensOut);
        if (ethBack > 0) {
            token.approve(address(router), tokensOut);
            router.swapExactTokensForETH(address(pair), tokensOut, ethBack, trader, block.timestamp);
        }
        vm.stopPrank();

        assertLe(ethBack, ethIn);
        assertEq(trader.balance, ethBack);
    }

    // (d) Minting and burning the same shares never returns more than was deposited.

    function testFuzz_firstMintBurnRoundTrip(uint256 amount0, uint256 amount1) public {
        amount0 = _boundLog(amount0, 1e6, MAX_TOKENS);
        amount1 = _boundLog(amount1, 1e6, MAX_TOKENS);
        HyvoV2Pair plain = new HyvoV2Pair(address(lowToken), address(highToken), DEFAULT_FEE_BPS);
        uint256 liquidity = _mintOrExpectRevert(plain, amount0, amount1, Math.sqrt(amount0 * amount1) - 1000);

        (bool burned, uint256 out0, uint256 out1) = _burnOrExpectRevert(plain, liquidity);

        // Everything comes back except the share of the locked MINIMUM_LIQUIDITY.
        assertTrue(burned);
        assertEq(out0, liquidity * amount0 / (liquidity + 1000));
        assertEq(out1, liquidity * amount1 / (liquidity + 1000));
        (uint112 reserve0, uint112 reserve1,) = plain.getReserves();
        assertEq(reserve0, amount0 - out0);
        assertEq(reserve1, amount1 - out1);
        assertEq(plain.totalSupply(), 1000);
        assertEq(plain.balanceOf(DEAD), 1000);
    }

    function testFuzz_laterMintBurnRoundTripNeverReturnsMore(
        uint256 reserve0,
        uint256 reserve1,
        uint256 amount0,
        uint256 amount1
    ) public {
        reserve0 = _boundLog(reserve0, 1e6, MAX_TOKENS);
        reserve1 = _boundLog(reserve1, 1e6, MAX_TOKENS);
        amount0 = _boundLog(amount0, 1, MAX_TOKENS);
        amount1 = _boundLog(amount1, 1, MAX_TOKENS);
        HyvoV2Pair plain = new HyvoV2Pair(address(lowToken), address(highToken), DEFAULT_FEE_BPS);
        _mintOrExpectRevert(plain, reserve0, reserve1, Math.sqrt(reserve0 * reserve1) - 1000);
        uint256 supply = plain.totalSupply();
        uint256 shares0 = amount0 * supply / reserve0;
        uint256 shares1 = amount1 * supply / reserve1;

        uint256 liquidity = _mintOrExpectRevert(plain, amount0, amount1, Math.min(shares0, shares1));
        if (liquidity == 0) return;
        (bool burned, uint256 out0, uint256 out1) = _burnOrExpectRevert(plain, liquidity);
        if (!burned) return;

        // On a side that set the share count, rounding loses less than one share's worth plus one unit.
        assertLe(out0, amount0);
        assertLe(out1, amount1);
        if (liquidity == shares0) assertLe(amount0 - out0, reserve0 / supply + 1);
        if (liquidity == shares1) assertLe(amount1 - out1, reserve1 / supply + 1);
    }

    // helpers

    /// @dev Like `bound`, but first picks an order of magnitude, so dust trades, tiny pools and whale
    ///      trades are all common instead of nearly every value landing near `max`.
    function _boundLog(uint256 seed, uint256 min, uint256 max) internal pure returns (uint256) {
        uint256 shift = (seed >> 248) % (Math.log2(max / min) + 1);
        return bound(seed, min, Math.max(min, max >> shift));
    }

    /// @dev Deploys a WETH pair with a fuzzed token order and fee, seeded with fuzzed reserves.
    function _fuzzedPool(bool wethIsToken0, uint256 feeSeed, uint256 ethSeed, uint256 tokenSeed)
        internal
        returns (uint16 fee, uint256 ethReserve, uint256 tokenReserve)
    {
        fee = uint16(bound(feeSeed, 0, 1000));
        ethReserve = _boundLog(ethSeed, MIN_RESERVE, MAX_ETH);
        tokenReserve = _boundLog(tokenSeed, MIN_RESERVE, MAX_TOKENS);
        _useWethPair(wethIsToken0, fee);
        _seed(ethReserve, tokenReserve);
    }

    function _giveTokensWithAllowance(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(router), type(uint256).max);
    }

    /// @dev Buys when the low bit of `seed` is clear and sells otherwise; the other bits size the trade.
    function _swapFromSeed(uint256 seed) internal {
        if (seed & 1 == 0) {
            uint256 ethIn = _boundLog(seed >> 1, 1, MAX_ETH);
            if (router.quoteBuy(address(pair), ethIn) == 0) return;
            vm.deal(trader, trader.balance + ethIn);
            vm.prank(trader);
            router.swapExactETHForTokens{value: ethIn}(address(pair), 0, trader, block.timestamp);
        } else {
            uint256 balance = token.balanceOf(trader);
            if (balance == 0) return;
            uint256 tokensIn = _boundLog(seed >> 1, 1, balance);
            if (router.quoteSell(address(pair), tokensIn) == 0) return;
            vm.prank(trader);
            router.swapExactTokensForETH(address(pair), tokensIn, 0, trader, block.timestamp);
        }
    }

    function _swapOut(HyvoV2Pair target, bool zeroForOne, uint256 amountOut) internal {
        if (zeroForOne) target.swap(0, amountOut, trader);
        else target.swap(amountOut, 0, trader);
    }

    /// @dev Deposits both amounts into `target` and mints to `lp`, expecting `expected` shares; when
    ///      `expected` is zero it expects the mint to revert and returns zero.
    function _mintOrExpectRevert(HyvoV2Pair target, uint256 amount0, uint256 amount1, uint256 expected)
        internal
        returns (uint256 liquidity)
    {
        lowToken.mint(address(target), amount0);
        highToken.mint(address(target), amount1);
        if (expected == 0) vm.expectRevert(HyvoV2Pair.InsufficientLiquidityMinted.selector);
        liquidity = target.mint(lp);
        assertEq(liquidity, expected);
    }

    /// @dev Sends `liquidity` shares from `lp` back to `target` and burns them; when a pro-rata amount
    ///      rounds to zero it expects the burn to revert and returns `burned = false`.
    function _burnOrExpectRevert(HyvoV2Pair target, uint256 liquidity)
        internal
        returns (bool burned, uint256 out0, uint256 out1)
    {
        uint256 supply = target.totalSupply();
        uint256 expected0 = liquidity * IERC20(target.token0()).balanceOf(address(target)) / supply;
        uint256 expected1 = liquidity * IERC20(target.token1()).balanceOf(address(target)) / supply;
        vm.prank(lp);
        assertTrue(target.transfer(address(target), liquidity));

        burned = expected0 > 0 && expected1 > 0;
        if (!burned) vm.expectRevert(HyvoV2Pair.InsufficientLiquidityBurned.selector);
        (out0, out1) = target.burn(lp);
        if (!burned) return (false, 0, 0);
        assertEq(out0, expected0);
        assertEq(out1, expected1);
    }
}

/// @dev Stateful: random sequences of buys, sells, deposits and withdrawals by three actors.
abstract contract HyvoV2InvariantTest is HyvoV2Fixture {
    HyvoV2Handler internal handler;

    function _wethIsToken0() internal pure virtual returns (bool);

    function setUp() public override {
        super.setUp();
        _useWethPair(_wethIsToken0(), DEFAULT_FEE_BPS);
        _seed(100 ether, 1_000_000e18);
        handler = new HyvoV2Handler(router, pair, token);
        token.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    function invariant_kNeverDecreasesAcrossSwaps() public view {
        assertFalse(handler.kDecreased(), "a swap lowered K");
    }

    function invariant_swapOutputsMatchGetAmountOut() public view {
        assertFalse(handler.outputMismatch(), "a swap paid out something other than getAmountOut");
    }

    function invariant_reservesEqualBalances() public view {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(reserve0, IERC20(pair.token0()).balanceOf(address(pair)));
        assertEq(reserve1, IERC20(pair.token1()).balanceOf(address(pair)));
    }

    function invariant_routerHoldsNothing() public view {
        _assertRouterHoldsNothing();
    }

    function invariant_wethIsFullyBacked() public view {
        assertEq(address(weth).balance, weth.totalSupply());
    }

    /// @dev Guards against a vacuous campaign: every run must have executed swaps.
    function afterInvariant() public view {
        assertGt(handler.swapCount(), 0, "no swaps executed");
    }
}

contract HyvoV2InvariantWethToken0Test is HyvoV2InvariantTest {
    function _wethIsToken0() internal pure override returns (bool) {
        return true;
    }
}

contract HyvoV2InvariantWethToken1Test is HyvoV2InvariantTest {
    function _wethIsToken0() internal pure override returns (bool) {
        return false;
    }
}
