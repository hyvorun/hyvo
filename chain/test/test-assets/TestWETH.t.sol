// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {TestWETH} from "../../src/test-assets/TestWETH.sol";
import {EthRejecter} from "./utils/Mocks.sol";

contract TestWETHTest is Test {
    TestWETH internal weth;
    address internal alice = makeAddr("alice");

    function setUp() public {
        weth = new TestWETH();
        vm.deal(alice, 10 ether);
    }

    function test_constructor_setsMetadata() public view {
        assertEq(weth.name(), "Wrapped Ether");
        assertEq(weth.symbol(), "WETH");
        assertEq(weth.decimals(), 18);
        assertEq(weth.totalSupply(), 0);
    }

    function test_deposit_wrapsEth() public {
        vm.expectEmit(address(weth));
        emit IERC20.Transfer(address(0), alice, 2 ether);
        vm.expectEmit(address(weth));
        emit TestWETH.Deposit(alice, 2 ether);
        vm.prank(alice);
        weth.deposit{value: 2 ether}();

        assertEq(weth.balanceOf(alice), 2 ether);
        assertEq(weth.totalSupply(), 2 ether);
        assertEq(address(weth).balance, 2 ether);
        assertEq(alice.balance, 8 ether);
    }

    function test_receive_wrapsPlainTransfers() public {
        vm.expectEmit(address(weth));
        emit TestWETH.Deposit(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(weth).call{value: 1 ether}("");

        assertTrue(ok);
        assertEq(weth.balanceOf(alice), 1 ether);
        assertEq(address(weth).balance, 1 ether);
    }

    function test_withdraw_unwrapsToCaller() public {
        vm.startPrank(alice);
        weth.deposit{value: 3 ether}();

        vm.expectEmit(address(weth));
        emit IERC20.Transfer(alice, address(0), 1 ether);
        vm.expectEmit(address(weth));
        emit TestWETH.Withdrawal(alice, 1 ether);
        weth.withdraw(1 ether);
        vm.stopPrank();

        assertEq(weth.balanceOf(alice), 2 ether);
        assertEq(weth.totalSupply(), 2 ether);
        assertEq(address(weth).balance, 2 ether);
        assertEq(alice.balance, 8 ether);
    }

    function test_withdraw_revertsAboveBalance() public {
        vm.startPrank(alice);
        weth.deposit{value: 1 ether}();
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1 ether, 2 ether));
        weth.withdraw(2 ether);
        vm.stopPrank();
    }

    function test_withdraw_revertsWhenCallerRejectsEth() public {
        EthRejecter rejecter = new EthRejecter();
        vm.expectRevert(TestWETH.EthTransferFailed.selector);
        rejecter.wrapAndUnwrap{value: 1 ether}(weth);
    }

    function testFuzz_wethStaysFullyBacked(uint256 depositAmount, uint256 withdrawAmount) public {
        depositAmount = bound(depositAmount, 0, alice.balance);
        withdrawAmount = bound(withdrawAmount, 0, depositAmount);

        vm.startPrank(alice);
        weth.deposit{value: depositAmount}();
        weth.withdraw(withdrawAmount);
        vm.stopPrank();

        assertEq(weth.balanceOf(alice), depositAmount - withdrawAmount);
        assertEq(address(weth).balance, weth.totalSupply());
        assertEq(alice.balance, 10 ether - depositAmount + withdrawAmount);
    }
}
