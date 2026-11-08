// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HyvoV2Pair} from "../../src/test-assets/HyvoV2Pair.sol";
import {TestToken} from "../../src/test-assets/TestToken.sol";
import {HyvoV2Fixture, ReferenceMath} from "./utils/HyvoV2Fixture.sol";
import {ReentrantToken} from "./utils/Mocks.sol";

/// @dev Pair-level tests on a plain token/token pair: tokens are sent to the pair directly, as a
///      router would, before calling mint, burn or swap.
contract HyvoV2PairTest is HyvoV2Fixture {
    /// @dev getAmountOut(1e18, 10e18, 20e18, 30), and the reverse direction getAmountOut(2e18, 20e18, 10e18, 30).
    uint112 internal constant OUT_1E18_TOKEN0_IN = 1813221787760298263;
    uint112 internal constant OUT_2E18_TOKEN1_IN = 906610893880149131;

    TestToken internal token0;
    TestToken internal token1;
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    function setUp() public override {
        super.setUp();
        token0 = lowToken;
        token1 = highToken;
        pair = new HyvoV2Pair(address(token1), address(token0), DEFAULT_FEE_BPS);
    }

    // constructor

    function test_constructor_sortsTokens() public {
        HyvoV2Pair reversed = new HyvoV2Pair(address(token0), address(token1), DEFAULT_FEE_BPS);
        assertEq(pair.token0(), address(token0));
        assertEq(pair.token1(), address(token1));
        assertEq(reversed.token0(), address(token0));
        assertEq(reversed.token1(), address(token1));
    }

    function test_constructor_setsFeeAndLpMetadata() public view {
        assertEq(pair.feeBps(), DEFAULT_FEE_BPS);
        assertEq(pair.name(), "Hyvo V2 LP");
        assertEq(pair.symbol(), "HYVO-V2-LP");
        assertEq(pair.decimals(), 18);
        assertEq(pair.MINIMUM_LIQUIDITY(), 1000);
        assertEq(pair.totalSupply(), 0);
    }

    function test_constructor_acceptsFeeFromZeroToMax() public {
        assertEq(new HyvoV2Pair(address(token0), address(token1), 0).feeBps(), 0);
        assertEq(new HyvoV2Pair(address(token0), address(token1), 1000).feeBps(), 1000);
    }

    function test_constructor_revertsOnIdenticalTokens() public {
        vm.expectRevert(HyvoV2Pair.IdenticalTokens.selector);
        new HyvoV2Pair(address(token0), address(token0), DEFAULT_FEE_BPS);
    }

    function test_constructor_revertsOnZeroToken() public {
        vm.expectRevert(HyvoV2Pair.ZeroAddress.selector);
        new HyvoV2Pair(address(0), address(token1), DEFAULT_FEE_BPS);
        vm.expectRevert(HyvoV2Pair.ZeroAddress.selector);
        new HyvoV2Pair(address(token1), address(0), DEFAULT_FEE_BPS);
    }

    function test_constructor_revertsOnFeeAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(HyvoV2Pair.FeeTooHigh.selector, uint16(1001)));
        new HyvoV2Pair(address(token0), address(token1), 1001);
    }

    // getReserves

    function test_getReserves_startEmpty() public view {
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = pair.getReserves();
        assertEq(reserve0, 0);
        assertEq(reserve1, 0);
        assertEq(blockTimestampLast, 0);
    }

    function test_getReserves_recordsUpdateTimeModulo2To32() public {
        _addLiquidity(1e18, 1e18, lp);
        (,, uint32 blockTimestampLast) = pair.getReserves();
        assertEq(blockTimestampLast, 1_800_000_000);

        vm.warp(uint256(type(uint32).max) + 6);
        pair.sync();
        (,, blockTimestampLast) = pair.getReserves();
        assertEq(blockTimestampLast, 5);
    }

    // mint

    function test_mint_firstDepositLocksMinimumLiquidity() public {
        _deposit(1e18, 4e18);

        vm.expectEmit(address(pair));
        emit IERC20.Transfer(address(0), DEAD, 1000);
        vm.expectEmit(address(pair));
        emit IERC20.Transfer(address(0), lp, 2e18 - 1000);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Sync(1e18, 4e18);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Mint(address(this), 1e18, 4e18);
        uint256 liquidity = pair.mint(lp);

        assertEq(liquidity, 2e18 - 1000);
        assertEq(pair.balanceOf(lp), liquidity);
        assertEq(pair.balanceOf(DEAD), 1000);
        assertEq(pair.totalSupply(), 2e18);
        _assertReserves(1e18, 4e18);
    }

    function test_mint_laterDepositMintsTheSmallerProRataShare() public {
        _addLiquidity(1e18, 4e18, lp);

        // 0.5e18 token0 is worth 1e18 shares and 4e18 token1 is worth 2e18; the smaller share is minted
        // and the extra token1 stays in the pool.
        uint256 liquidity = _addLiquidity(0.5e18, 4e18, trader);

        assertEq(liquidity, 1e18);
        assertEq(pair.balanceOf(trader), 1e18);
        assertEq(pair.totalSupply(), 3e18);
        _assertReserves(1.5e18, 8e18);
    }

    function test_mint_acceptsTheSmallestFirstDeposit() public {
        assertEq(_addLiquidity(1001, 1001, lp), 1);
    }

    function test_mint_revertsWhenFirstDepositIsTooSmall() public {
        _deposit(1000, 1000);
        vm.expectRevert(HyvoV2Pair.InsufficientLiquidityMinted.selector);
        pair.mint(lp);
    }

    function test_mint_revertsWhenNothingWasDeposited() public {
        _addLiquidity(1e18, 1e18, lp);
        vm.expectRevert(HyvoV2Pair.InsufficientLiquidityMinted.selector);
        pair.mint(lp);
    }

    function test_mint_revertsWhenABalanceOverflows112Bits() public {
        _deposit(uint256(type(uint112).max) + 1, 1e18);
        vm.expectRevert(HyvoV2Pair.Overflow.selector);
        pair.mint(lp);
    }

    // burn

    function test_burn_returnsProRataShare() public {
        uint256 liquidity = _addLiquidity(1e18, 4e18, lp);
        vm.prank(lp);
        assertTrue(pair.transfer(address(pair), liquidity));

        // The burned share is (2e18 - 1000) / 2e18 of each balance.
        uint256 amount0 = 1e18 - 500;
        uint256 amount1 = 4e18 - 2000;
        vm.expectEmit(address(pair));
        emit IERC20.Transfer(address(pair), address(0), liquidity);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Sync(500, 2000);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Burn(address(this), amount0, amount1, lp);
        (uint256 out0, uint256 out1) = pair.burn(lp);

        assertEq(out0, amount0);
        assertEq(out1, amount1);
        assertEq(token0.balanceOf(lp), amount0);
        assertEq(token1.balanceOf(lp), amount1);
        assertEq(pair.balanceOf(address(pair)), 0);
        assertEq(pair.totalSupply(), 1000);
        _assertReserves(500, 2000);
    }

    function test_burn_revertsWithoutSharesInThePair() public {
        vm.expectRevert(HyvoV2Pair.InsufficientLiquidityBurned.selector);
        pair.burn(lp);

        _addLiquidity(1e18, 1e18, lp);
        vm.expectRevert(HyvoV2Pair.InsufficientLiquidityBurned.selector);
        pair.burn(lp);
    }

    function test_burn_revertsWhenTheShareRoundsToZero() public {
        // sqrt(1e18 * 1e6) = 1e12 shares, so one share is worth 1e-6 units of token1.
        _addLiquidity(1e18, 1e6, lp);
        vm.prank(lp);
        assertTrue(pair.transfer(address(pair), 1));

        vm.expectRevert(HyvoV2Pair.InsufficientLiquidityBurned.selector);
        pair.burn(lp);
    }

    // swap

    function test_swap_token0InForToken1Out() public {
        _addLiquidity(10e18, 20e18, lp);
        assertEq(ReferenceMath.amountOut(1e18, 10e18, 20e18, DEFAULT_FEE_BPS), OUT_1E18_TOKEN0_IN);
        token0.mint(address(pair), 1e18);

        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Sync(11e18, 20e18 - OUT_1E18_TOKEN0_IN);
        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Swap(address(this), 1e18, 0, 0, OUT_1E18_TOKEN0_IN, trader);
        pair.swap(0, OUT_1E18_TOKEN0_IN, trader);

        assertEq(token1.balanceOf(trader), OUT_1E18_TOKEN0_IN);
        _assertReserves(11e18, 20e18 - OUT_1E18_TOKEN0_IN);
    }

    function test_swap_token1InForToken0Out() public {
        _addLiquidity(10e18, 20e18, lp);
        assertEq(ReferenceMath.amountOut(2e18, 20e18, 10e18, DEFAULT_FEE_BPS), OUT_2E18_TOKEN1_IN);
        token1.mint(address(pair), 2e18);

        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Swap(address(this), 0, 2e18, OUT_2E18_TOKEN1_IN, 0, trader);
        pair.swap(OUT_2E18_TOKEN1_IN, 0, trader);

        assertEq(token0.balanceOf(trader), OUT_2E18_TOKEN1_IN);
        _assertReserves(10e18 - OUT_2E18_TOKEN1_IN, 22e18);
    }

    function test_swap_appliesTheConfiguredFee() public {
        uint16[3] memory fees = [uint16(0), 30, 1000];
        for (uint256 i; i < fees.length; ++i) {
            pair = new HyvoV2Pair(address(token0), address(token1), fees[i]);
            _addLiquidity(10e18, 20e18, lp);
            uint256 amountOut = ReferenceMath.amountOut(1e18, 10e18, 20e18, fees[i]);
            token0.mint(address(pair), 1e18);

            vm.expectRevert(HyvoV2Pair.KInvariant.selector);
            pair.swap(0, amountOut + 1, trader);
            pair.swap(0, amountOut, trader);
            _assertReserves(11e18, 20e18 - amountOut);
        }
    }

    function test_swap_revertsWithoutOutput() public {
        _addLiquidity(10e18, 20e18, lp);
        vm.expectRevert(HyvoV2Pair.InsufficientOutputAmount.selector);
        pair.swap(0, 0, trader);
    }

    function test_swap_revertsWhenOutputReachesTheReserve() public {
        _addLiquidity(10e18, 20e18, lp);
        vm.expectRevert(HyvoV2Pair.InsufficientLiquidity.selector);
        pair.swap(10e18, 0, trader);
        vm.expectRevert(HyvoV2Pair.InsufficientLiquidity.selector);
        pair.swap(0, 20e18, trader);
    }

    function test_swap_revertsWhenRecipientIsAPairToken() public {
        _addLiquidity(10e18, 20e18, lp);
        token0.mint(address(pair), 1e18);
        vm.expectRevert(HyvoV2Pair.InvalidTo.selector);
        pair.swap(0, 1, address(token0));
        vm.expectRevert(HyvoV2Pair.InvalidTo.selector);
        pair.swap(0, 1, address(token1));
    }

    function test_swap_revertsWithoutInput() public {
        _addLiquidity(10e18, 20e18, lp);
        vm.expectRevert(HyvoV2Pair.InsufficientInputAmount.selector);
        pair.swap(0, 1, trader);
    }

    function test_swap_revertsOneUnitAboveGetAmountOut() public {
        _addLiquidity(10e18, 20e18, lp);
        token0.mint(address(pair), 1e18);
        vm.expectRevert(HyvoV2Pair.KInvariant.selector);
        pair.swap(0, OUT_1E18_TOKEN0_IN + 1, trader);
    }

    function test_swap_revertsWhenABalanceOverflows112Bits() public {
        _addLiquidity(10e18, 20e18, lp);
        token0.mint(address(pair), uint256(type(uint112).max) - 10e18 + 1);
        vm.expectRevert(HyvoV2Pair.Overflow.selector);
        pair.swap(0, 1, trader);
    }

    // sync

    function test_sync_setsReservesToBalances() public {
        _addLiquidity(10e18, 20e18, lp);
        token1.mint(address(pair), 5e18);
        _assertReserves(10e18, 20e18);

        vm.expectEmit(address(pair));
        emit HyvoV2Pair.Sync(10e18, 25e18);
        pair.sync();
        _assertReserves(10e18, 25e18);
    }

    function test_sync_revertsWhenABalanceOverflows112Bits() public {
        token1.mint(address(pair), uint256(type(uint112).max) + 1);
        vm.expectRevert(HyvoV2Pair.Overflow.selector);
        pair.sync();
    }

    // reentrancy

    function test_burn_blocksReentrantCalls() public {
        (ReentrantToken evil, HyvoV2Pair evilPair) = _evilPair();
        bytes[4] memory reentries = _reentries();
        for (uint256 i; i < reentries.length; ++i) {
            evil.arm(address(evilPair), reentries[i]);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            evilPair.burn(address(this));
        }
    }

    function test_swap_blocksReentrantCalls() public {
        (ReentrantToken evil, HyvoV2Pair evilPair) = _evilPair();
        bool evilIsToken0 = evilPair.token0() == address(evil);
        bytes[4] memory reentries = _reentries();
        for (uint256 i; i < reentries.length; ++i) {
            evil.arm(address(evilPair), reentries[i]);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            evilPair.swap(evilIsToken0 ? 1e17 : 0, evilIsToken0 ? 0 : 1e17, address(this));
        }
    }

    // helpers

    function _deposit(uint256 amount0, uint256 amount1) internal {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
    }

    function _addLiquidity(uint256 amount0, uint256 amount1, address to) internal returns (uint256) {
        _deposit(amount0, amount1);
        return pair.mint(to);
    }

    function _assertReserves(uint256 expected0, uint256 expected1) internal view {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(reserve0, expected0, "reserve0");
        assertEq(reserve1, expected1, "reserve1");
    }

    /// @dev A seeded pair of `ReentrantToken` and token0, with half of the LP shares sent back to the
    ///      pair so that `burn` has something to burn.
    function _evilPair() internal returns (ReentrantToken evil, HyvoV2Pair evilPair) {
        evil = new ReentrantToken();
        evilPair = new HyvoV2Pair(address(evil), address(token0), DEFAULT_FEE_BPS);
        evil.mint(address(evilPair), 10e18);
        token0.mint(address(evilPair), 10e18);
        uint256 liquidity = evilPair.mint(address(this));
        assertTrue(evilPair.transfer(address(evilPair), liquidity / 2));
    }

    /// @dev One call into each guarded pair function.
    function _reentries() internal view returns (bytes[4] memory) {
        return [
            abi.encodeCall(HyvoV2Pair.mint, (address(this))),
            abi.encodeCall(HyvoV2Pair.burn, (address(this))),
            abi.encodeCall(HyvoV2Pair.swap, (0, 1, address(this))),
            abi.encodeCall(HyvoV2Pair.sync, ())
        ];
    }
}
