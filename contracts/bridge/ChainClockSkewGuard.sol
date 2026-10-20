// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ChainClockSkewGuard
/// @notice On-chain enforcement of cross-chain message timestamp freshness.
///
/// @dev Cross-chain messages carry a `messageTimestamp` sourced from the
///      source-chain block time. This contract validates that timestamp against
///      `block.timestamp` on the destination chain, rejecting messages whose
///      apparent clock skew exceeds a configured tolerance.
///
/// # Configuration surface
///
/// Each chain-pair (identified by `sourceChainId`) may have its own tolerance.
/// The owner registers per-chain tolerances via `setTolerance`. A global
/// fallback tolerance is set in the constructor and can be updated by the owner.
///
/// # Chain-specific failure behaviour
///
/// - `MessageTooOld`     — block.timestamp - messageTimestamp > effectiveTolerance.
///                         Reject the message. Do NOT retry without operator review.
/// - `MessageFromFuture` — messageTimestamp > block.timestamp + futureDrift.
///                         The source chain's time is implausibly far ahead.
///                         Hold for re-check; do NOT drop.
/// - `ZeroTimestamp`     — messageTimestamp == 0. Always rejected.
///
/// # Idempotency
///
/// `assertFresh` performs only view-level reads plus an in-memory arithmetic
/// check; it never writes state. It is safe to call multiple times with the
/// same arguments.
///
/// # Gas / upgrade notes
///
/// Per-chain tolerance entries consume one SSTORE (~20 000 gas) each. The
/// `assertFresh` call costs one cold SLOAD (~2 100 gas) per check. The
/// contract has no proxy pattern; upgrade requires redeployment. The bridge
/// router that calls this guard should route through an upgradeable proxy and
/// update its guard reference via an owner setter.
contract ChainClockSkewGuard {
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct ChainTolerance {
        uint64 toleranceSecs;   // Maximum allowed age of message timestamp
        uint64 futureDriftSecs; // Maximum allowed future drift
        bool   registered;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    address public owner;

    /// @notice Global fallback tolerance used when no per-chain entry exists.
    uint64 public defaultToleranceSecs;

    /// @notice Global fallback future-drift limit.
    uint64 public defaultFutureDriftSecs;

    /// @notice Per source-chain tolerance overrides.
    mapping(uint32 => ChainTolerance) private _chainTolerances;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ToleranceSet(uint32 indexed sourceChainId, uint64 toleranceSecs, uint64 futureDriftSecs);
    event DefaultToleranceSet(uint64 toleranceSecs, uint64 futureDriftSecs);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error Unauthorized();
    error ZeroTimestamp();

    /// @notice Message timestamp is older than the effective tolerance.
    /// @param messageTimestamp  The timestamp embedded in the message.
    /// @param blockTimestamp    Current block.timestamp.
    /// @param ageSecs           Computed age (blockTimestamp - messageTimestamp).
    /// @param toleranceSecs     Effective tolerance that was exceeded.
    error MessageTooOld(
        uint64 messageTimestamp,
        uint64 blockTimestamp,
        uint64 ageSecs,
        uint64 toleranceSecs
    );

    /// @notice Message timestamp is implausibly far in the future.
    /// @param messageTimestamp  The timestamp embedded in the message.
    /// @param blockTimestamp    Current block.timestamp.
    /// @param driftSecs         How far ahead the message timestamp is.
    /// @param futureDriftSecs   Allowed future drift that was exceeded.
    error MessageFromFuture(
        uint64 messageTimestamp,
        uint64 blockTimestamp,
        uint64 driftSecs,
        uint64 futureDriftSecs
    );

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(
        address _owner,
        uint64 _defaultToleranceSecs,
        uint64 _defaultFutureDriftSecs
    ) {
        require(_owner != address(0), "ChainClockSkewGuard: zero owner");
        require(_defaultToleranceSecs > 0, "ChainClockSkewGuard: zero tolerance");
        owner = _owner;
        defaultToleranceSecs = _defaultToleranceSecs;
        defaultFutureDriftSecs = _defaultFutureDriftSecs;
        emit OwnershipTransferred(address(0), _owner);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Register or update a per-chain tolerance.
    function setTolerance(
        uint32 sourceChainId,
        uint64 toleranceSecs,
        uint64 futureDriftSecs
    ) external {
        if (msg.sender != owner) revert Unauthorized();
        require(toleranceSecs > 0, "ChainClockSkewGuard: zero tolerance");
        _chainTolerances[sourceChainId] = ChainTolerance({
            toleranceSecs: toleranceSecs,
            futureDriftSecs: futureDriftSecs,
            registered: true
        });
        emit ToleranceSet(sourceChainId, toleranceSecs, futureDriftSecs);
    }

    /// @notice Update the global fallback tolerance.
    function setDefaultTolerance(
        uint64 toleranceSecs,
        uint64 futureDriftSecs
    ) external {
        if (msg.sender != owner) revert Unauthorized();
        require(toleranceSecs > 0, "ChainClockSkewGuard: zero tolerance");
        defaultToleranceSecs = toleranceSecs;
        defaultFutureDriftSecs = futureDriftSecs;
        emit DefaultToleranceSet(toleranceSecs, futureDriftSecs);
    }

    /// @notice Transfer ownership.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        require(newOwner != address(0), "ChainClockSkewGuard: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Return the effective tolerance for `sourceChainId`, falling back
    ///         to the default when no per-chain entry is registered.
    function getEffectiveTolerance(uint32 sourceChainId)
        external
        view
        returns (uint64 toleranceSecs, uint64 futureDriftSecs)
    {
        ChainTolerance storage ct = _chainTolerances[sourceChainId];
        if (ct.registered) {
            return (ct.toleranceSecs, ct.futureDriftSecs);
        }
        return (defaultToleranceSecs, defaultFutureDriftSecs);
    }

    /// @notice Return `true` when `messageTimestamp` is within the effective
    ///         tolerance for `sourceChainId`. Does NOT revert — use when you
    ///         want to branch rather than revert.
    function isFresh(uint64 messageTimestamp, uint32 sourceChainId)
        external
        view
        returns (bool)
    {
        if (messageTimestamp == 0) return false;
        (uint64 toleranceSecs, uint64 futureDriftSecs) = _resolvedTolerance(sourceChainId);
        uint64 now_ = uint64(block.timestamp);

        // Future check
        if (messageTimestamp > now_ && (messageTimestamp - now_) > futureDriftSecs) {
            return false;
        }
        // Age check
        if (now_ >= messageTimestamp && (now_ - messageTimestamp) > toleranceSecs) {
            return false;
        }
        return true;
    }

    // -----------------------------------------------------------------------
    // Enforcement — reverts on violation
    // -----------------------------------------------------------------------

    /// @notice Assert that `messageTimestamp` is within the clock skew tolerance
    ///         for `sourceChainId`. Reverts if the check fails.
    /// @param messageTimestamp  Unix timestamp (seconds) embedded in the message.
    /// @param sourceChainId     Numeric chain ID of the source chain.
    function assertFresh(uint64 messageTimestamp, uint32 sourceChainId) external view {
        if (messageTimestamp == 0) revert ZeroTimestamp();

        (uint64 toleranceSecs, uint64 futureDriftSecs) = _resolvedTolerance(sourceChainId);
        uint64 now_ = uint64(block.timestamp);

        if (messageTimestamp > now_) {
            uint64 driftSecs = messageTimestamp - now_;
            if (driftSecs > futureDriftSecs) {
                revert MessageFromFuture(messageTimestamp, now_, driftSecs, futureDriftSecs);
            }
        } else {
            uint64 ageSecs = now_ - messageTimestamp;
            if (ageSecs > toleranceSecs) {
                revert MessageTooOld(messageTimestamp, now_, ageSecs, toleranceSecs);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _resolvedTolerance(uint32 sourceChainId)
        internal
        view
        returns (uint64 toleranceSecs, uint64 futureDriftSecs)
    {
        ChainTolerance storage ct = _chainTolerances[sourceChainId];
        if (ct.registered) {
            return (ct.toleranceSecs, ct.futureDriftSecs);
        }
        return (defaultToleranceSecs, defaultFutureDriftSecs);
    }
}
