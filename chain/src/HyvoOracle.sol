// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title HyvoOracle
/// @notice Public record of Hyvo runs: each run's report hash is committed before the real outcome
///         is known, and can later be resolved with an outcome hash.
/// @dev Holds no funds (no payable function, no receive or fallback), is not upgradeable and makes
///      no external calls. The owner (a Safe multisig) only rotates the attester; the attester (the
///      API Worker's key) commits and resolves. A run id can be committed once.
contract HyvoOracle is Ownable2Step {
    struct Commit {
        bytes32 reportHash; // keccak256 of the canonical run.json (docs/RUN_FORMAT.md)
        bytes32 scenarioHash; // keccak256 of the canonical run.json scenario
        uint64 resolvesAt; // unix seconds after which resolve is allowed; 0 = never resolves
        uint64 committedAt;
        uint64 resolvedAt;
        bytes32 outcomeHash;
    }

    /// @notice The key allowed to commit and resolve.
    address public attester;

    mapping(bytes32 runId => Commit) private _commits;

    event Committed(
        bytes32 indexed runId, bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt, uint256 timestamp
    );
    event Resolved(bytes32 indexed runId, bytes32 outcomeHash, string outcomeURI);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    error NotAttester(address caller);
    error ZeroAddress();
    error ZeroHash();
    error AlreadyCommitted(bytes32 runId);
    error NotCommitted(bytes32 runId);
    error NotResolvable(bytes32 runId);
    error TooEarly(bytes32 runId, uint64 resolvesAt);
    error AlreadyResolved(bytes32 runId);

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester(msg.sender);
        _;
    }

    constructor(address initialOwner, address initialAttester) Ownable(initialOwner) {
        _setAttester(initialAttester);
    }

    /// @notice Records a run's hashes. Each `runId` can be committed once.
    function commit(bytes32 runId, bytes32 reportHash, bytes32 scenarioHash, uint64 resolvesAt)
        external
        onlyAttester
    {
        if (reportHash == bytes32(0) || scenarioHash == bytes32(0)) revert ZeroHash();
        Commit storage entry = _commits[runId];
        if (entry.committedAt != 0) revert AlreadyCommitted(runId);
        entry.reportHash = reportHash;
        entry.scenarioHash = scenarioHash;
        entry.resolvesAt = resolvesAt;
        entry.committedAt = uint64(block.timestamp);
        emit Committed(runId, reportHash, scenarioHash, resolvesAt, block.timestamp);
    }

    /// @notice Records the outcome of a committed run once its resolution time has passed.
    function resolve(bytes32 runId, bytes32 outcomeHash, string calldata outcomeURI) external onlyAttester {
        if (outcomeHash == bytes32(0)) revert ZeroHash();
        Commit storage entry = _commits[runId];
        if (entry.committedAt == 0) revert NotCommitted(runId);
        if (entry.resolvesAt == 0) revert NotResolvable(runId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < entry.resolvesAt) revert TooEarly(runId, entry.resolvesAt);
        if (entry.resolvedAt != 0) revert AlreadyResolved(runId);
        entry.outcomeHash = outcomeHash;
        entry.resolvedAt = uint64(block.timestamp);
        emit Resolved(runId, outcomeHash, outcomeURI);
    }

    /// @notice The commit of `runId` (all fields zero when it was never committed).
    function getCommit(bytes32 runId) external view returns (Commit memory) {
        return _commits[runId];
    }

    /// @notice Rotates the attester key. Owner only.
    function setAttester(address newAttester) external onlyOwner {
        _setAttester(newAttester);
    }

    function _setAttester(address newAttester) private {
        if (newAttester == address(0)) revert ZeroAddress();
        emit AttesterChanged(attester, newAttester);
        attester = newAttester;
    }
}
