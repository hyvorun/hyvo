// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestToken
/// @notice Mintable 18-decimal ERC-20 traded by agents in a per-job anvil world.
/// @dev Test asset for local forks only. The owner (the engine's deployer) seeds balances by minting.
contract TestToken is ERC20, Ownable {
    constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) Ownable(owner_) {}

    /// @notice Mints `amount` base units to `to`.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
