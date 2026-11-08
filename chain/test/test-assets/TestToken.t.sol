// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {TestToken} from "../../src/test-assets/TestToken.sol";

contract TestTokenTest is Test {
    TestToken internal token;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        token = new TestToken("Hyvo Test", "HYVX", owner);
    }

    function test_constructor_setsMetadataAndOwner() public view {
        assertEq(token.name(), "Hyvo Test");
        assertEq(token.symbol(), "HYVX");
        assertEq(token.decimals(), 18);
        assertEq(token.owner(), owner);
        assertEq(token.totalSupply(), 0);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TestToken("Hyvo Test", "HYVX", address(0));
    }

    function test_mint_creditsRecipient() public {
        vm.expectEmit(address(token));
        emit IERC20.Transfer(address(0), alice, 5e18);
        vm.prank(owner);
        token.mint(alice, 5e18);

        assertEq(token.balanceOf(alice), 5e18);
        assertEq(token.totalSupply(), 5e18);
    }

    function test_mint_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1);
    }

    function test_mint_revertsToZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        vm.prank(owner);
        token.mint(address(0), 1);
    }

    function test_mint_followsOwnershipTransfer() public {
        vm.prank(owner);
        token.transferOwnership(alice);

        vm.prank(alice);
        token.mint(alice, 1);
        assertEq(token.balanceOf(alice), 1);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        token.mint(owner, 1);
    }

    function testFuzz_mint_addsToBalanceAndSupply(address to, uint256 first, uint256 second) public {
        vm.assume(to != address(0));
        first = bound(first, 0, type(uint128).max);
        second = bound(second, 0, type(uint128).max);

        vm.startPrank(owner);
        token.mint(to, first);
        token.mint(to, second);
        vm.stopPrank();

        assertEq(token.balanceOf(to), first + second);
        assertEq(token.totalSupply(), first + second);
    }
}
