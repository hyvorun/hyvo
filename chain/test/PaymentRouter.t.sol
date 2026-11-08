// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {FalseReturningToken, FeeOnTransferToken, MockToken, ReentrantToken} from "./utils/PaymentMocks.sol";

contract PaymentRouterTest is Test {
    PaymentRouter internal router;
    MockToken internal usdg;
    MockToken internal hyvo;
    address internal owner = makeAddr("safe");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");

    bytes32 internal constant ORDER = keccak256("order-1");

    event Paid(bytes32 indexed orderId, address indexed payer, address indexed token, uint256 amount, uint256 timestamp);
    event TokenAllowed(address indexed token, bool allowed);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    function setUp() public {
        router = new PaymentRouter(owner, treasury);
        usdg = new MockToken("USDG", 6);
        hyvo = new MockToken("HYVO", 18);
        vm.startPrank(owner);
        router.setTokenAllowed(address(usdg), true);
        router.setTokenAllowed(address(hyvo), true);
        vm.stopPrank();
        usdg.mint(payer, 1_000e6);
        vm.prank(payer);
        usdg.approve(address(router), type(uint256).max);
    }

    // --- constructor ------------------------------------------------------------------------

    function test_constructorSetsOwnerAndTreasury() public view {
        assertEq(router.owner(), owner);
        assertEq(router.treasury(), treasury);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        new PaymentRouter(owner, address(0));
    }

    // --- pay --------------------------------------------------------------------------------

    function test_payForwardsToTheTreasuryInTheSameCall() public {
        vm.expectEmit(true, true, true, true);
        emit Paid(ORDER, payer, address(usdg), 25e6, block.timestamp);
        vm.prank(payer);
        router.pay(ORDER, address(usdg), 25e6);
        assertEq(usdg.balanceOf(treasury), 25e6);
        assertEq(usdg.balanceOf(payer), 975e6);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertTrue(router.paid(ORDER));
    }

    function test_anOrderCanBePaidOnce() public {
        vm.prank(payer);
        router.pay(ORDER, address(usdg), 1e6);
        address other = makeAddr("other payer");
        usdg.mint(other, 5e6);
        vm.startPrank(other);
        usdg.approve(address(router), 5e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.AlreadyPaid.selector, ORDER));
        router.pay(ORDER, address(usdg), 5e6);
        vm.stopPrank();
    }

    function test_disallowedTokenReverts() public {
        MockToken other = new MockToken("OTHER", 18);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.TokenNotAllowed.selector, address(other)));
        vm.prank(payer);
        router.pay(ORDER, address(other), 1);
    }

    function test_zeroAmountReverts() public {
        vm.expectRevert(PaymentRouter.ZeroAmount.selector);
        vm.prank(payer);
        router.pay(ORDER, address(usdg), 0);
    }

    function test_missingAllowanceReverts() public {
        address poor = makeAddr("no allowance");
        usdg.mint(poor, 10e6);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 10e6)
        );
        vm.prank(poor);
        router.pay(ORDER, address(usdg), 10e6);
        assertFalse(router.paid(ORDER)); // the failed call left no trace
    }

    function test_insufficientBalanceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, payer, 1_000e6, 1_001e6)
        );
        vm.prank(payer);
        router.pay(ORDER, address(usdg), 1_001e6);
    }

    function test_feeOnTransferTokenIsRefused() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        vm.prank(owner);
        router.setTokenAllowed(address(fee), true);
        fee.mint(payer, 100e18);
        vm.startPrank(payer);
        fee.approve(address(router), 100e18);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.AmountNotReceived.selector, 100e18, 99e18));
        router.pay(ORDER, address(fee), 100e18);
        vm.stopPrank();
    }

    function test_tokenReturningFalseIsRefused() public {
        FalseReturningToken bad = new FalseReturningToken();
        vm.prank(owner);
        router.setTokenAllowed(address(bad), true);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad)));
        vm.prank(payer);
        router.pay(ORDER, address(bad), 1);
    }

    function test_reentrancyIsBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        vm.prank(owner);
        router.setTokenAllowed(address(evil), true);
        evil.arm(router);
        evil.mint(payer, 10e18);
        vm.startPrank(payer);
        evil.approve(address(router), 10e18);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        router.pay(ORDER, address(evil), 1e18);
        vm.stopPrank();
    }

    function test_rejectsEther() public {
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(router).balance, 0);
    }

    // --- owner functions --------------------------------------------------------------------

    function test_ownerAllowsAndDisallowsTokens() public {
        vm.expectEmit(true, false, false, true);
        emit TokenAllowed(address(usdg), false);
        vm.prank(owner);
        router.setTokenAllowed(address(usdg), false);
        assertFalse(router.allowedToken(address(usdg)));
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.TokenNotAllowed.selector, address(usdg)));
        vm.prank(payer);
        router.pay(ORDER, address(usdg), 1e6);
    }

    function test_setTokenAllowedIsOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        vm.prank(payer);
        router.setTokenAllowed(address(usdg), false);
    }

    function test_setTokenAllowedRejectsZero() public {
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        vm.prank(owner);
        router.setTokenAllowed(address(0), true);
    }

    function test_ownerChangesTheTreasury() public {
        address next = makeAddr("next treasury");
        vm.expectEmit(true, true, false, false);
        emit TreasuryChanged(treasury, next);
        vm.prank(owner);
        router.setTreasury(next);
        vm.prank(payer);
        router.pay(ORDER, address(usdg), 3e6);
        assertEq(usdg.balanceOf(next), 3e6);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_setTreasuryIsOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        vm.prank(payer);
        router.setTreasury(payer);
    }

    function test_setTreasuryRejectsZeroAndTheRouterItself() public {
        vm.startPrank(owner);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.setTreasury(address(0));
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.InvalidTreasury.selector, address(router)));
        router.setTreasury(address(router));
        vm.stopPrank();
    }

    function test_ownershipMovesInTwoSteps() public {
        address nextSafe = makeAddr("next safe");
        vm.prank(owner);
        router.transferOwnership(nextSafe);
        assertEq(router.pendingOwner(), nextSafe);
        vm.prank(nextSafe);
        router.acceptOwnership();
        assertEq(router.owner(), nextSafe);
    }

    // --- fuzz -------------------------------------------------------------------------------

    function testFuzz_payKeepsTheRouterEmpty(bytes32 orderId, uint256 amount) public {
        amount = bound(amount, 1, 1_000e6);
        vm.prank(payer);
        router.pay(orderId, address(usdg), amount);
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(treasury), amount);
        assertTrue(router.paid(orderId));
    }
}

/// @dev Random pay calls by several payers in two tokens, including duplicates and refused calls.
contract PaymentHandler is Test {
    PaymentRouter internal router;
    MockToken[2] internal tokens;
    address[3] internal payers;
    mapping(address => uint256) public paidTotal; // ghost: sum of successful payments per token
    uint256 public calls;

    constructor(PaymentRouter router_, MockToken a, MockToken b) {
        router = router_;
        tokens = [a, b];
        for (uint256 i; i < 3; i++) {
            payers[i] = makeAddr(string.concat("payer", vm.toString(i)));
            a.mint(payers[i], 1e30);
            b.mint(payers[i], 1e30);
            vm.startPrank(payers[i]);
            a.approve(address(router_), type(uint256).max);
            b.approve(address(router_), type(uint256).max);
            vm.stopPrank();
        }
    }

    function pay(uint256 payerSeed, uint256 tokenSeed, uint8 orderSeed, uint256 amount) external {
        calls++;
        address who = payers[payerSeed % 3];
        MockToken token = tokens[tokenSeed % 2];
        bytes32 orderId = bytes32(uint256(orderSeed)); // few ids, so duplicates happen
        amount = bound(amount, 0, 1e24);
        vm.prank(who);
        try router.pay(orderId, address(token), amount) {
            paidTotal[address(token)] += amount;
        } catch {}
    }
}

contract PaymentRouterInvariantTest is StdInvariant, Test {
    PaymentRouter internal router;
    MockToken internal usdg;
    MockToken internal hyvo;
    PaymentHandler internal handler;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        router = new PaymentRouter(address(this), treasury);
        usdg = new MockToken("USDG", 6);
        hyvo = new MockToken("HYVO", 18);
        router.setTokenAllowed(address(usdg), true);
        router.setTokenAllowed(address(hyvo), true);
        handler = new PaymentHandler(router, usdg, hyvo);
        targetContract(address(handler));
    }

    function invariant_routerNeverHoldsTokens() public view {
        assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(hyvo.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function invariant_treasuryReceivesExactlyWhatWasPaid() public view {
        assertEq(usdg.balanceOf(treasury), handler.paidTotal(address(usdg)));
        assertEq(hyvo.balanceOf(treasury), handler.paidTotal(address(hyvo)));
    }
}
