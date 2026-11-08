// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PaymentRouter
/// @notice Pays for a Hyvo order: moves the payer's tokens straight to the treasury in the same
///         call and emits `Paid`, which the API matches to the order.
/// @dev Never holds funds: tokens go from the payer to the treasury with `transferFrom`, there is no
///      payable function, receive or fallback, and the treasury can never be this contract. Only
///      owner-allowed tokens (USDG and the Hyvo token) are accepted; each order id is paid once.
///      Tokens that deliver less than `amount` (fee-on-transfer) are refused, so `Paid.amount` is
///      always what the treasury received.
contract PaymentRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where every payment goes.
    address public treasury;

    /// @notice Tokens accepted by `pay`.
    mapping(address token => bool) public allowedToken;

    /// @notice Order ids already paid.
    mapping(bytes32 orderId => bool) public paid;

    event Paid(bytes32 indexed orderId, address indexed payer, address indexed token, uint256 amount, uint256 timestamp);
    event TokenAllowed(address indexed token, bool allowed);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    error ZeroAddress();
    error InvalidTreasury(address treasury);
    error TokenNotAllowed(address token);
    error ZeroAmount();
    error AlreadyPaid(bytes32 orderId);
    error AmountNotReceived(uint256 expected, uint256 received);

    constructor(address initialOwner, address initialTreasury) Ownable(initialOwner) {
        _setTreasury(initialTreasury);
    }

    /// @notice Pays `amount` of `token` for `orderId`; the caller must have approved this contract.
    function pay(bytes32 orderId, address token, uint256 amount) external nonReentrant {
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        if (paid[orderId]) revert AlreadyPaid(orderId);
        paid[orderId] = true;

        address to = treasury;
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(msg.sender, to, amount);
        uint256 received = IERC20(token).balanceOf(to) - before;
        if (received != amount) revert AmountNotReceived(amount, received);

        emit Paid(orderId, msg.sender, token, amount, block.timestamp);
    }

    /// @notice Allows or disallows a payment token. Owner only.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice Changes the treasury. Owner only.
    function setTreasury(address newTreasury) external onlyOwner {
        _setTreasury(newTreasury);
    }

    function _setTreasury(address newTreasury) private {
        if (newTreasury == address(0)) revert ZeroAddress();
        if (newTreasury == address(this)) revert InvalidTreasury(newTreasury);
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }
}
