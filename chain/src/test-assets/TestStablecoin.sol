// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestStablecoin
/// @notice A 6-decimal, owner-mintable stand-in for USDG on local chains (payments end-to-end tests).
/// @dev Test asset only; never deployed to a public network.
contract TestStablecoin is ERC20, Ownable {
    constructor(address owner_) ERC20("Test Global Dollar", "tUSDG") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
