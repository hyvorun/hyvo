// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PaymentRouter} from "../../src/PaymentRouter.sol";

/// @dev A plain mintable ERC-20 with configurable decimals.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% of every transfer, so the receiver gets less than the amount sent.
contract FeeOnTransferToken is MockToken {
    constructor() MockToken("FEE", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Returns false from transferFrom instead of reverting.
contract FalseReturningToken is MockToken {
    constructor() MockToken("FALSE", 18) {}

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev Calls back into PaymentRouter.pay while a transfer is in progress.
contract ReentrantToken is MockToken {
    PaymentRouter public router;

    constructor() MockToken("REENTER", 18) {}

    function arm(PaymentRouter router_) external {
        router = router_;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (address(router) != address(0)) {
            router.pay(keccak256("reentered"), address(this), 1);
        }
        return super.transferFrom(from, to, value);
    }
}
