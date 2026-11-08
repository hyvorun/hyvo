// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A small savings vault for testing Hyvo's Dry Run, with two bugs planted on purpose.
/// @dev Never deploy this anywhere real. `withdraw` overpays, and `rescueFunds` has no owner check.
contract SampleVault {
    address public immutable owner;
    uint256 public feeBps;
    uint256 public totalDeposits;
    uint256 public lastCheckpoint;
    mapping(address => uint256) public balanceOf;

    address[] private _members;
    mapping(address => bool) private _joined;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0, "deposit something");
        balanceOf[msg.sender] += msg.value;
        totalDeposits += msg.value;
        if (!_joined[msg.sender]) {
            _joined[msg.sender] = true;
            _members.push(msg.sender);
        }
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        require(amount > 0 && balanceOf[msg.sender] >= amount, "not enough deposited");
        balanceOf[msg.sender] -= amount;
        totalDeposits -= amount;
        // Planted bug 1: a 10% bonus, paid out of other people's deposits.
        (bool sent,) = msg.sender.call{value: amount + amount / 10}("");
        require(sent, "the vault cannot pay this out");
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Walks every member, so its gas grows with the crowd.
    function checkpoint() external returns (uint256 total) {
        for (uint256 i = 0; i < _members.length; i++) {
            total += balanceOf[_members[i]];
        }
        lastCheckpoint = total;
    }

    function setFee(uint256 newFeeBps) external {
        if (msg.sender != owner) revert NotOwner();
        feeBps = newFeeBps;
    }

    /// @notice Planted bug 2: there is no owner check, so anyone can take the vault's money.
    function rescueFunds(address payable to) external {
        (bool sent,) = to.call{value: address(this).balance}("");
        require(sent, "the vault cannot pay this out");
    }

    /// @notice The invariant: the vault can always pay everyone back.
    function isSolvent() external view returns (bool) {
        return address(this).balance >= totalDeposits;
    }
}
