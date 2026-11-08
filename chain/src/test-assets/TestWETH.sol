// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestWETH
/// @notice WETH9-compatible wrapped ether for a per-job anvil world. Every WETH is backed by one ETH
///         held by this contract.
/// @dev Unlike WETH9, deposits and withdrawals also emit ERC-20 `Transfer` events (mint and burn).
contract TestWETH is ERC20 {
    /// @notice `dst` wrapped `wad` wei of ETH.
    event Deposit(address indexed dst, uint256 wad);
    /// @notice `src` unwrapped `wad` wei of WETH.
    event Withdrawal(address indexed src, uint256 wad);

    /// @notice Sending the unwrapped ETH to the caller failed.
    error EthTransferFailed();

    constructor() ERC20("Wrapped Ether", "WETH") {}

    /// @notice Plain ETH transfers are wrapped for the sender.
    receive() external payable {
        deposit();
    }

    /// @notice Wraps `msg.value` ETH into WETH for the caller.
    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Burns `wad` WETH from the caller and sends the same amount of ETH back to it.
    function withdraw(uint256 wad) external {
        _burn(msg.sender, wad);
        emit Withdrawal(msg.sender, wad);
        (bool sent,) = msg.sender.call{value: wad}("");
        if (!sent) revert EthTransferFailed();
    }
}
