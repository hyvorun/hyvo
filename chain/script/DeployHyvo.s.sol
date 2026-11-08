// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {HyvoOracle} from "../src/HyvoOracle.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// @notice Deploys HyvoOracle and PaymentRouter and writes their addresses to
///         deployments/<chainId>.json (or $HYVO_DEPLOYMENTS_FILE).
/// @dev Environment:
///      HYVO_OWNER          Safe multisig that owns both contracts (accepts the router's ownership)
///      HYVO_ATTESTER       address of the Worker's attester key (the key itself stays a Wrangler secret)
///      HYVO_TREASURY       where payments go
///      USDG_ADDRESS        payment token (docs/OPEN_ITEMS.md item 4)
///      HYVO_TOKEN_ADDRESS  optional second payment token, once launched
///      Run: forge script script/DeployHyvo.s.sol --rpc-url $RPC --broadcast (with a deployer key)
contract DeployHyvo is Script {
    struct Deployment {
        HyvoOracle oracle;
        PaymentRouter router;
        address deployer;
    }

    function run() external returns (Deployment memory d) {
        address owner = vm.envAddress("HYVO_OWNER");
        address attester = vm.envAddress("HYVO_ATTESTER");
        address treasury = vm.envAddress("HYVO_TREASURY");
        address usdg = vm.envAddress("USDG_ADDRESS");
        address hyvoToken = vm.envOr("HYVO_TOKEN_ADDRESS", address(0));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d.deployer = deployer;
        d.oracle = new HyvoOracle(owner, attester);
        // The deployer owns the router only long enough to allow the payment tokens.
        d.router = new PaymentRouter(deployer, treasury);
        d.router.setTokenAllowed(usdg, true);
        if (hyvoToken != address(0)) d.router.setTokenAllowed(hyvoToken, true);
        if (owner != deployer) d.router.transferOwnership(owner); // the Safe then calls acceptOwnership()
        vm.stopBroadcast();

        _write(d, owner, attester, treasury, usdg, hyvoToken);
    }

    function _write(
        Deployment memory d,
        address owner,
        address attester,
        address treasury,
        address usdg,
        address hyvoToken
    ) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "block", block.number);
        vm.serializeAddress(key, "deployer", d.deployer);
        vm.serializeAddress(key, "owner", owner);
        vm.serializeAddress(key, "attester", attester);
        vm.serializeAddress(key, "treasury", treasury);
        vm.serializeAddress(key, "usdg", usdg);
        vm.serializeAddress(key, "hyvoToken", hyvoToken);
        vm.serializeAddress(key, "paymentRouter", address(d.router));
        string memory json = vm.serializeAddress(key, "oracle", address(d.oracle));
        string memory path =
            vm.envOr("HYVO_DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(json, path);
    }
}
