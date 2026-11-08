// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TestWETH} from "../../../src/test-assets/TestWETH.sol";

/// @dev ERC-20 whose `transfer` first makes one armed call (for example back into a pair) and bubbles
///      that call's revert, to prove the pair's reentrancy guard.
contract ReentrantToken is ERC20 {
    address private _target;
    bytes private _data;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev The next `transfer` calls `target` with `data` before moving any tokens.
    function arm(address target, bytes calldata data) external {
        _target = target;
        _data = data;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        address target = _target;
        if (target != address(0)) {
            _target = address(0);
            (bool ok, bytes memory reason) = target.call(_data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        return super.transfer(to, value);
    }
}

/// @dev Has no `receive` or `fallback`, so every plain ETH transfer to it fails.
contract EthRejecter {
    function wrapAndUnwrap(TestWETH weth) external payable {
        weth.deposit{value: msg.value}();
        weth.withdraw(msg.value);
    }
}
