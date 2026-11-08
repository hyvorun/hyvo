// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";
import {HyvoOracle} from "../src/HyvoOracle.sol";

contract HyvoOracleTest is Test {
    HyvoOracle internal oracle;
    address internal owner = makeAddr("safe");
    address internal attester = makeAddr("attester");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant RUN = bytes32(uint256(0x0190f3a1b2c3d4e5f60718293a4b5c6d));
    bytes32 internal constant REPORT = keccak256("report");
    bytes32 internal constant SCENARIO = keccak256("scenario");
    bytes32 internal constant OUTCOME = keccak256("outcome");

    event Committed(
        bytes32 indexed runId, bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint256 timestamp
    );
    event Resolved(bytes32 indexed runId, bytes32 outcomeHash, string outcomeURI);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new HyvoOracle(owner, attester);
    }

    // --- constructor ------------------------------------------------------------------------

    function test_constructorSetsOwnerAndAttester() public view {
        assertEq(oracle.owner(), owner);
        assertEq(oracle.attester(), attester);
    }

    function test_constructorEmitsAttesterChanged() public {
        vm.expectEmit(true, true, false, false);
        emit AttesterChanged(address(0), attester);
        new HyvoOracle(owner, attester);
    }

    function test_constructorRejectsZeroAttester() public {
        vm.expectRevert(HyvoOracle.ZeroAddress.selector);
        new HyvoOracle(owner, address(0));
    }

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new HyvoOracle(address(0), attester);
    }

    // --- commit -----------------------------------------------------------------------------

    function test_commitStoresEveryField() public {
        vm.prank(attester);
        oracle.commit(RUN, REPORT, SCENARIO, 1_900_000_000);
        HyvoOracle.Commit memory c = oracle.getCommit(RUN);
        assertEq(c.reportHash, REPORT);
        assertEq(c.scenarioHash, SCENARIO);
        assertEq(c.resolvesAt, 1_900_000_000);
        assertEq(c.committedAt, 1_800_000_000);
        assertEq(c.resolvedAt, 0);
        assertEq(c.outcomeHash, bytes32(0));
    }

    function test_commitEmitsCommitted() public {
        vm.expectEmit(true, false, false, true);
        emit Committed(RUN, REPORT, SCENARIO, 0, 1_800_000_000);
        vm.prank(attester);
        oracle.commit(RUN, REPORT, SCENARIO, 0);
    }

    function test_commitTwiceReverts() public {
        vm.startPrank(attester);
        oracle.commit(RUN, REPORT, SCENARIO, 0);
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.AlreadyCommitted.selector, RUN));
        oracle.commit(RUN, keccak256("other"), SCENARIO, 0);
        vm.stopPrank();
    }

    function test_commitByNonAttesterReverts() public {
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.NotAttester.selector, stranger));
        vm.prank(stranger);
        oracle.commit(RUN, REPORT, SCENARIO, 0);
    }

    function test_commitByOwnerReverts() public {
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.NotAttester.selector, owner));
        vm.prank(owner);
        oracle.commit(RUN, REPORT, SCENARIO, 0);
    }

    function test_commitRejectsZeroReportHash() public {
        vm.expectRevert(HyvoOracle.ZeroHash.selector);
        vm.prank(attester);
        oracle.commit(RUN, bytes32(0), SCENARIO, 0);
    }

    function test_commitRejectsZeroScenarioHash() public {
        vm.expectRevert(HyvoOracle.ZeroHash.selector);
        vm.prank(attester);
        oracle.commit(RUN, REPORT, bytes32(0), 0);
    }

    function test_unknownRunHasAnEmptyCommit() public view {
        HyvoOracle.Commit memory c = oracle.getCommit(RUN);
        assertEq(c.committedAt, 0);
        assertEq(c.reportHash, bytes32(0));
    }

    // --- resolve ----------------------------------------------------------------------------

    function _commitResolvable(uint64 resolvesAt) internal {
        vm.prank(attester);
        oracle.commit(RUN, REPORT, SCENARIO, resolvesAt);
    }

    function test_resolveAfterResolvesAt() public {
        _commitResolvable(1_800_000_100);
        vm.warp(1_800_000_100);
        vm.expectEmit(true, false, false, true);
        emit Resolved(RUN, OUTCOME, "ipfs://outcome");
        vm.prank(attester);
        oracle.resolve(RUN, OUTCOME, "ipfs://outcome");
        HyvoOracle.Commit memory c = oracle.getCommit(RUN);
        assertEq(c.outcomeHash, OUTCOME);
        assertEq(c.resolvedAt, 1_800_000_100);
    }

    function test_resolveBeforeResolvesAtReverts() public {
        _commitResolvable(1_800_000_100);
        vm.warp(1_800_000_099);
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.TooEarly.selector, RUN, uint64(1_800_000_100)));
        vm.prank(attester);
        oracle.resolve(RUN, OUTCOME, "");
    }

    function test_resolveOfUncommittedRunReverts() public {
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.NotCommitted.selector, RUN));
        vm.prank(attester);
        oracle.resolve(RUN, OUTCOME, "");
    }

    function test_resolveOfRunWithoutResolutionTimeReverts() public {
        _commitResolvable(0);
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.NotResolvable.selector, RUN));
        vm.prank(attester);
        oracle.resolve(RUN, OUTCOME, "");
    }

    function test_resolveTwiceReverts() public {
        _commitResolvable(1_800_000_000);
        vm.startPrank(attester);
        oracle.resolve(RUN, OUTCOME, "");
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.AlreadyResolved.selector, RUN));
        oracle.resolve(RUN, keccak256("other"), "");
        vm.stopPrank();
    }

    function test_resolveRejectsZeroOutcome() public {
        _commitResolvable(1_800_000_000);
        vm.expectRevert(HyvoOracle.ZeroHash.selector);
        vm.prank(attester);
        oracle.resolve(RUN, bytes32(0), "");
    }

    function test_resolveByNonAttesterReverts() public {
        _commitResolvable(1_800_000_000);
        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.NotAttester.selector, stranger));
        vm.prank(stranger);
        oracle.resolve(RUN, OUTCOME, "");
    }

    // --- attester rotation and ownership ----------------------------------------------------

    function test_ownerRotatesTheAttester() public {
        address next = makeAddr("next attester");
        vm.expectEmit(true, true, false, false);
        emit AttesterChanged(attester, next);
        vm.prank(owner);
        oracle.setAttester(next);
        assertEq(oracle.attester(), next);

        vm.expectRevert(abi.encodeWithSelector(HyvoOracle.NotAttester.selector, attester));
        vm.prank(attester);
        oracle.commit(RUN, REPORT, SCENARIO, 0);

        vm.prank(next);
        oracle.commit(RUN, REPORT, SCENARIO, 0);
        assertEq(oracle.getCommit(RUN).reportHash, REPORT);
    }

    function test_setAttesterIsOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attester));
        vm.prank(attester);
        oracle.setAttester(stranger);
    }

    function test_setAttesterRejectsZero() public {
        vm.expectRevert(HyvoOracle.ZeroAddress.selector);
        vm.prank(owner);
        oracle.setAttester(address(0));
    }

    function test_ownershipMovesInTwoSteps() public {
        address nextSafe = makeAddr("next safe");
        vm.prank(owner);
        oracle.transferOwnership(nextSafe);
        assertEq(oracle.owner(), owner); // pending until accepted

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nextSafe));
        vm.prank(nextSafe);
        oracle.setAttester(stranger);

        vm.prank(nextSafe);
        oracle.acceptOwnership();
        assertEq(oracle.owner(), nextSafe);
        vm.prank(nextSafe);
        oracle.setAttester(stranger);
        assertEq(oracle.attester(), stranger);
    }

    function test_rejectsEther() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(oracle).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(oracle).balance, 0);
    }

    // --- fuzz -------------------------------------------------------------------------------

    function testFuzz_commitRecordsAnyRun(bytes32 runId, bytes32 report, bytes32 scenario, uint64 resolvesAt)
        public
    {
        vm.assume(report != bytes32(0) && scenario != bytes32(0));
        vm.prank(attester);
        oracle.commit(runId, report, scenario, resolvesAt);
        HyvoOracle.Commit memory c = oracle.getCommit(runId);
        assertEq(c.reportHash, report);
        assertEq(c.scenarioHash, scenario);
        assertEq(c.resolvesAt, resolvesAt);
        assertEq(c.committedAt, block.timestamp);
    }

    function testFuzz_resolveRespectsTheResolutionTime(uint64 resolvesAt, uint64 at) public {
        resolvesAt = uint64(bound(resolvesAt, 1, type(uint64).max - 1));
        at = uint64(bound(at, 0, type(uint64).max - 1));
        _commitResolvable(resolvesAt);
        vm.warp(at);
        vm.prank(attester);
        if (at < resolvesAt) {
            vm.expectRevert(abi.encodeWithSelector(HyvoOracle.TooEarly.selector, RUN, resolvesAt));
            oracle.resolve(RUN, OUTCOME, "");
        } else {
            oracle.resolve(RUN, OUTCOME, "");
            assertEq(oracle.getCommit(RUN).resolvedAt, at);
        }
    }
}
