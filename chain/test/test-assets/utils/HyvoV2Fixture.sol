// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HyvoV2Pair} from "../../../src/test-assets/HyvoV2Pair.sol";
import {HyvoV2Router} from "../../../src/test-assets/HyvoV2Router.sol";
import {TestToken} from "../../../src/test-assets/TestToken.sol";
import {TestWETH} from "../../../src/test-assets/TestWETH.sol";

/// @dev Independent copy of the swap formula that the engine replays (see `HyvoV2Router.getAmountOut`).
library ReferenceMath {
    function amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (10_000 - feeBps);
        return amountInWithFee * reserveOut / (reserveIn * 10_000 + amountInWithFee);
    }
}

/// @dev Shared world for the test-asset suites: WETH at a fixed address, one token below it and one
///      above it (so both token orders inside a WETH pair are covered), and the router. This contract
///      owns both tokens and can mint freely.
abstract contract HyvoV2Fixture is Test {
    address internal constant WETH_ADDRESS = 0x8888888888888888888888888888888888888888;
    address internal constant TOKEN_BELOW_WETH = 0x1111111111111111111111111111111111111111;
    address internal constant TOKEN_ABOVE_WETH = 0x9999999999999999999999999999999999999999;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 internal constant DEFAULT_FEE_BPS = 30;

    TestWETH internal weth;
    TestToken internal lowToken;
    TestToken internal highToken;
    HyvoV2Router internal router;

    /// @dev The WETH pair under test and its non-WETH token, set by `_useWethPair`.
    HyvoV2Pair internal pair;
    TestToken internal token;

    function setUp() public virtual {
        deployCodeTo("TestWETH.sol:TestWETH", WETH_ADDRESS);
        deployCodeTo("TestToken.sol:TestToken", abi.encode("Low Test", "LOW", address(this)), TOKEN_BELOW_WETH);
        deployCodeTo("TestToken.sol:TestToken", abi.encode("High Test", "HIGH", address(this)), TOKEN_ABOVE_WETH);
        weth = TestWETH(payable(WETH_ADDRESS));
        lowToken = TestToken(TOKEN_BELOW_WETH);
        highToken = TestToken(TOKEN_ABOVE_WETH);
        router = new HyvoV2Router(address(weth));
        vm.warp(1_800_000_000);
    }

    /// @dev Deploys a fresh WETH pair whose token0 is WETH (`wethIsToken0`) or the token.
    function _useWethPair(bool wethIsToken0, uint16 feeBps) internal {
        token = wethIsToken0 ? highToken : lowToken;
        pair = new HyvoV2Pair(address(token), address(weth), feeBps);
    }

    /// @dev Adds liquidity to the WETH pair through the router; this contract receives the LP shares.
    function _seed(uint256 ethAmount, uint256 tokenAmount) internal returns (uint256 liquidity) {
        token.mint(address(this), tokenAmount);
        token.approve(address(router), tokenAmount);
        vm.deal(address(this), address(this).balance + ethAmount);
        return router.addLiquidityETH{value: ethAmount}(address(pair), tokenAmount, address(this));
    }

    /// @dev Reserves of the WETH pair as (WETH, token).
    function _reservesWethToken() internal view returns (uint256 reserveWeth, uint256 reserveToken) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        return pair.token0() == address(weth) ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function _assertReservesWethToken(uint256 expectedWeth, uint256 expectedToken) internal view {
        (uint256 reserveWeth, uint256 reserveToken) = _reservesWethToken();
        assertEq(reserveWeth, expectedWeth, "WETH reserve");
        assertEq(reserveToken, expectedToken, "token reserve");
        assertEq(weth.balanceOf(address(pair)), expectedWeth, "pair WETH balance");
        assertEq(token.balanceOf(address(pair)), expectedToken, "pair token balance");
    }

    function _assertRouterHoldsNothing() internal view {
        assertEq(address(router).balance, 0, "router ETH");
        assertEq(weth.balanceOf(address(router)), 0, "router WETH");
        assertEq(token.balanceOf(address(router)), 0, "router token");
    }

    /// @dev The constant product of the WETH pair's reserves.
    function _k() internal view returns (uint256) {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        return uint256(reserve0) * reserve1;
    }
}
