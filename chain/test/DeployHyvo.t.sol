// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployHyvo} from "../script/DeployHyvo.s.sol";
import {MockToken} from "./utils/PaymentMocks.sol";

contract DeployHyvoTest is Test {
    string internal constant FILE = "deployments/test-deploy.json";
    address internal safe = makeAddr("safe");
    address internal attester = makeAddr("attester");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.setEnv("HYVO_OWNER", vm.toString(safe));
        vm.setEnv("HYVO_ATTESTER", vm.toString(attester));
        vm.setEnv("HYVO_TREASURY", vm.toString(treasury));
        vm.setEnv("HYVO_DEPLOYMENTS_FILE", FILE);
    }

    /// One test function on purpose: forge runs a contract's tests in parallel, and the deploy script
    /// reads the process-wide environment and writes one file.
    function test_deploysConfiguresAndRecordsWithAndWithoutTheHyvoToken() public {
        _deploysConfiguresAndRecordsBothContracts();
        _theHyvoTokenIsOptional();
    }

    function _deploysConfiguresAndRecordsBothContracts() internal {
        MockToken usdg = new MockToken("USDG", 6);
        MockToken hyvo = new MockToken("HYVO", 18);
        vm.setEnv("USDG_ADDRESS", vm.toString(address(usdg)));
        vm.setEnv("HYVO_TOKEN_ADDRESS", vm.toString(address(hyvo)));

        DeployHyvo.Deployment memory d = new DeployHyvo().run();

        assertEq(d.oracle.owner(), safe);
        assertEq(d.oracle.attester(), attester);
        assertEq(d.router.treasury(), treasury);
        assertTrue(d.router.allowedToken(address(usdg)));
        assertTrue(d.router.allowedToken(address(hyvo)));
        assertEq(d.router.owner(), d.deployer); // until the Safe accepts
        assertEq(d.router.pendingOwner(), safe);
        vm.prank(safe);
        d.router.acceptOwnership();
        assertEq(d.router.owner(), safe);

        string memory json = vm.readFile(FILE);
        assertEq(vm.parseJsonAddress(json, ".oracle"), address(d.oracle));
        assertEq(vm.parseJsonAddress(json, ".paymentRouter"), address(d.router));
        assertEq(vm.parseJsonAddress(json, ".usdg"), address(usdg));
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        vm.removeFile(FILE);
    }

    function _theHyvoTokenIsOptional() internal {
        MockToken usdg = new MockToken("USDG", 6);
        vm.setEnv("USDG_ADDRESS", vm.toString(address(usdg)));
        vm.setEnv("HYVO_TOKEN_ADDRESS", vm.toString(address(0)));
        DeployHyvo.Deployment memory d = new DeployHyvo().run();
        assertTrue(d.router.allowedToken(address(usdg)));
        assertFalse(d.router.allowedToken(address(0)));
        vm.removeFile(FILE);
    }
}
