// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HyvoV2Pair} from "../../../src/test-assets/HyvoV2Pair.sol";
import {HyvoV2Router} from "../../../src/test-assets/HyvoV2Router.sol";
import {TestToken} from "../../../src/test-assets/TestToken.sol";
import {ReferenceMath} from "./HyvoV2Fixture.sol";

/// @dev Invariant-test handler: random actors buy, sell, add and remove liquidity through the router.
///      Every swap is checked against the reference formula and the constant product; a failure sets a
///      flag that the invariant functions assert on (a revert inside a handler would be discarded).
///      The handler must own `token` so it can fund deposits.
contract HyvoV2Handler is CommonBase, StdCheats, StdUtils {
    HyvoV2Router internal immutable router;
    HyvoV2Pair internal immutable pair;
    TestToken internal immutable token;
    bool internal immutable wethIsToken0;
    address[] internal actors;

    uint256 public swapCount;
    bool public kDecreased;
    bool public outputMismatch;

    constructor(HyvoV2Router router_, HyvoV2Pair pair_, TestToken token_) {
        router = router_;
        pair = pair_;
        token = token_;
        wethIsToken0 = pair_.token0() == router_.weth();
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
    }

    function buy(uint256 actorSeed, uint256 ethIn) external {
        address actor = _actor(actorSeed);
        ethIn = bound(ethIn, 1, 1_000 ether);
        (uint256 reserveWeth, uint256 reserveToken) = _reserves();
        uint256 expected = ReferenceMath.amountOut(ethIn, reserveWeth, reserveToken, pair.feeBps());
        if (expected == 0) return;

        uint256 kBefore = _k();
        vm.deal(actor, actor.balance + ethIn);
        vm.prank(actor);
        uint256 amountOut = router.swapExactETHForTokens{value: ethIn}(address(pair), 0, actor, block.timestamp);
        _recordSwap(kBefore, amountOut, expected);
    }

    function sell(uint256 actorSeed, uint256 shareBps) external {
        address actor = _actor(actorSeed);
        uint256 tokensIn = token.balanceOf(actor) * bound(shareBps, 1, 10_000) / 10_000;
        if (tokensIn == 0) return;
        (uint256 reserveWeth, uint256 reserveToken) = _reserves();
        uint256 expected = ReferenceMath.amountOut(tokensIn, reserveToken, reserveWeth, pair.feeBps());
        if (expected == 0) return;

        uint256 kBefore = _k();
        vm.startPrank(actor);
        token.approve(address(router), tokensIn);
        uint256 amountOut = router.swapExactTokensForETH(address(pair), tokensIn, 0, actor, block.timestamp);
        vm.stopPrank();
        _recordSwap(kBefore, amountOut, expected);
    }

    /// @dev Deposits at the current pool ratio.
    function addLiquidity(uint256 actorSeed, uint256 ethAmount) external {
        address actor = _actor(actorSeed);
        ethAmount = bound(ethAmount, 1 gwei, 100 ether);
        (uint256 reserveWeth, uint256 reserveToken) = _reserves();
        uint256 tokenAmount = ethAmount * reserveToken / reserveWeth;
        uint256 supply = pair.totalSupply();
        if (Math.min(ethAmount * supply / reserveWeth, tokenAmount * supply / reserveToken) == 0) return;

        token.mint(actor, tokenAmount);
        vm.deal(actor, actor.balance + ethAmount);
        vm.startPrank(actor);
        token.approve(address(router), tokenAmount);
        router.addLiquidityETH{value: ethAmount}(address(pair), tokenAmount, actor);
        vm.stopPrank();
    }

    function removeLiquidity(uint256 actorSeed, uint256 shareBps) external {
        address actor = _actor(actorSeed);
        uint256 liquidity = pair.balanceOf(actor) * bound(shareBps, 1, 10_000) / 10_000;
        if (liquidity == 0) return;
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        uint256 supply = pair.totalSupply();
        if (liquidity * reserve0 / supply == 0 || liquidity * reserve1 / supply == 0) return;

        vm.startPrank(actor);
        require(pair.transfer(address(pair), liquidity), "LP transfer failed");
        pair.burn(actor);
        vm.stopPrank();
    }

    function _recordSwap(uint256 kBefore, uint256 amountOut, uint256 expected) private {
        ++swapCount;
        if (_k() < kBefore) kDecreased = true;
        if (amountOut != expected) outputMismatch = true;
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    function _reserves() private view returns (uint256 reserveWeth, uint256 reserveToken) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        return wethIsToken0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function _k() private view returns (uint256) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        return uint256(reserve0) * reserve1;
    }
}
