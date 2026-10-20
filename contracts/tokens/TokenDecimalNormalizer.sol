// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TokenDecimalNormalizer
/// @notice Validates and normalizes token amounts between chains that represent
///         the same economic asset with different decimal precisions (e.g. USDC
///         is 7 on Stellar and 6 on Ethereum).
///
/// @dev This contract is the on-chain enforcement point for decimal normalization
///      and is intended to be inherited or called by bridge router and vault
///      contracts that handle cross-chain token amounts.
///
/// # Decimal configuration surface
///
/// The owner registers `ChainTokenConfig` entries that map a (chainId, tokenId)
/// pair to a decimal count. Amounts moving through the bridge MUST be validated
/// against the registered config for both the source and destination chains
/// before any lock/mint/burn operation is accepted.
///
/// # Chain-specific failure behaviour
///
/// - Amounts whose precision exceeds the destination decimal count are rejected
///   with `PrecisionLoss` unless the caller explicitly requests floor-truncation
///   via the `normalizeDown` helper.
/// - Amounts that would overflow uint128 after scale-up are rejected with
///   `ScaleOverflow`.
/// - Calls to `normalize` with unregistered chain/token pairs revert with
///   `UnknownDecimalConfig`.
///
/// # Idempotency
///
/// `normalize` is a pure calculation that performs no state mutations.  Calling
/// it multiple times with the same inputs always produces the same output,
/// making it safe to call from off-chain simulation paths.
///
/// # Gas / upgrade notes
///
/// Config entries are stored in a `mapping` keyed by a tightly packed `bytes32`
/// derived from `(chainId, tokenId)`.  Adding new entries costs one cold SSTORE
/// (~20 000 gas); lookups cost one cold SLOAD (~2 100 gas).  The contract uses
/// no proxy pattern; upgrades require redeployment and re-registration of
/// configs.  The router that calls this contract should be upgradeable and
/// point to the new normalizer address via its own admin setter.
contract TokenDecimalNormalizer {
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /// @notice Decimal metadata for a single (chain, token) pair.
    struct ChainTokenConfig {
        uint8  decimals;
        bool   registered;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Owner address — authorized to register and update configs.
    address public owner;

    /// @notice Packed mapping: configKey(chainId, tokenId) → ChainTokenConfig.
    mapping(bytes32 => ChainTokenConfig) private _configs;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted when a (chainId, tokenId) decimal config is set or updated.
    event DecimalConfigRegistered(
        uint32 indexed chainId,
        bytes32 indexed tokenId,
        uint8 decimals
    );

    /// @notice Emitted when ownership is transferred.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    /// @notice Caller is not the contract owner.
    error Unauthorized();

    /// @notice No decimal config is registered for the given (chainId, tokenId).
    error UnknownDecimalConfig(uint32 chainId, bytes32 tokenId);

    /// @notice Source and destination decimal counts are identical — normalization
    ///         is a no-op and the caller should use the amount as-is.
    error SameDecimals(uint8 decimals);

    /// @notice The source amount has precision that cannot be represented at
    ///         destination scale without truncation (and the caller did not opt in).
    error PrecisionLoss(uint256 residual, uint8 srcDecimals, uint8 dstDecimals);

    /// @notice The rescaled amount would overflow uint128.
    error ScaleOverflow(uint256 amount, uint8 srcDecimals, uint8 dstDecimals);

    /// @notice `decimals` is out of the valid range [0, 38].
    error InvalidDecimals(uint8 decimals);

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(address _owner) {
        require(_owner != address(0), "TokenDecimalNormalizer: zero owner");
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Register (or update) the decimal precision for `tokenId` on `chainId`.
    /// @param chainId The numeric chain identifier (e.g. 1 = Ethereum mainnet).
    /// @param tokenId An arbitrary 32-byte token identifier (e.g. keccak256 of
    ///                the symbol, or the EVM address left-padded to 32 bytes).
    /// @param decimals Number of decimal places the token uses on `chainId`.
    function registerDecimalConfig(
        uint32 chainId,
        bytes32 tokenId,
        uint8 decimals
    ) external {
        if (msg.sender != owner) revert Unauthorized();
        if (decimals > 38) revert InvalidDecimals(decimals);

        _configs[_configKey(chainId, tokenId)] = ChainTokenConfig({
            decimals: decimals,
            registered: true
        });

        emit DecimalConfigRegistered(chainId, tokenId, decimals);
    }

    /// @notice Transfer ownership to `newOwner`.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        require(newOwner != address(0), "TokenDecimalNormalizer: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Return the registered decimal count for `tokenId` on `chainId`.
    /// @dev Reverts with `UnknownDecimalConfig` when no config has been set.
    function getDecimals(uint32 chainId, bytes32 tokenId) external view returns (uint8) {
        ChainTokenConfig storage cfg = _configs[_configKey(chainId, tokenId)];
        if (!cfg.registered) revert UnknownDecimalConfig(chainId, tokenId);
        return cfg.decimals;
    }

    /// @notice Return `true` when a config is registered for the given pair.
    function hasDecimalConfig(uint32 chainId, bytes32 tokenId) external view returns (bool) {
        return _configs[_configKey(chainId, tokenId)].registered;
    }

    // -----------------------------------------------------------------------
    // Normalization — pure calculation helpers
    // -----------------------------------------------------------------------

    /// @notice Rescale `amount` from `srcDecimals` precision to `dstDecimals`
    ///         precision. Reverts on precision loss or overflow.
    /// @param amount      Base-unit amount at source precision.
    /// @param srcDecimals Decimal count of the source chain token.
    /// @param dstDecimals Decimal count of the destination chain token.
    /// @return normalized Base-unit amount at destination precision.
    function normalize(
        uint256 amount,
        uint8 srcDecimals,
        uint8 dstDecimals
    ) public pure returns (uint256 normalized) {
        if (srcDecimals > 38) revert InvalidDecimals(srcDecimals);
        if (dstDecimals > 38) revert InvalidDecimals(dstDecimals);
        if (srcDecimals == dstDecimals) revert SameDecimals(srcDecimals);

        if (dstDecimals > srcDecimals) {
            // Scale up: multiply
            uint256 factor = 10 ** uint256(dstDecimals - srcDecimals);
            // Overflow check: if amount > type(uint128).max / factor, revert
            if (amount > type(uint128).max / factor) {
                revert ScaleOverflow(amount, srcDecimals, dstDecimals);
            }
            normalized = amount * factor;
        } else {
            // Scale down: divide — check for precision loss
            uint256 factor = 10 ** uint256(srcDecimals - dstDecimals);
            uint256 residual = amount % factor;
            if (residual != 0) {
                revert PrecisionLoss(residual, srcDecimals, dstDecimals);
            }
            normalized = amount / factor;
        }
    }

    /// @notice Rescale `amount` from `srcDecimals` to `dstDecimals`, truncating
    ///         any residual precision (floor division). Returns the normalized
    ///         amount and the truncated residual.
    /// @dev    Use this variant only when the caller has explicitly accepted that
    ///         some value may be lost (e.g. when issuing a dust-free wrapped token).
    function normalizeDown(
        uint256 amount,
        uint8 srcDecimals,
        uint8 dstDecimals
    ) public pure returns (uint256 normalized, uint256 truncated) {
        if (srcDecimals > 38) revert InvalidDecimals(srcDecimals);
        if (dstDecimals > 38) revert InvalidDecimals(dstDecimals);
        if (srcDecimals == dstDecimals) revert SameDecimals(srcDecimals);

        if (dstDecimals > srcDecimals) {
            uint256 factor = 10 ** uint256(dstDecimals - srcDecimals);
            if (amount > type(uint128).max / factor) {
                revert ScaleOverflow(amount, srcDecimals, dstDecimals);
            }
            normalized = amount * factor;
            truncated = 0;
        } else {
            uint256 factor = 10 ** uint256(srcDecimals - dstDecimals);
            truncated = amount % factor;
            normalized = amount / factor;
        }
    }

    /// @notice Validate that `amount` has no sub-unit precision relative to
    ///         `dstDecimals` — i.e., the amount is exactly representable at
    ///         destination scale without any residual.
    /// @return valid `true` when the amount is losslessly representable.
    function isExactlyRepresentable(
        uint256 amount,
        uint8 srcDecimals,
        uint8 dstDecimals
    ) external pure returns (bool valid) {
        if (srcDecimals <= dstDecimals) return true;
        uint256 factor = 10 ** uint256(srcDecimals - dstDecimals);
        return (amount % factor) == 0;
    }

    /// @notice Convenience: normalize `amount` using registered chain configs.
    /// @dev Reverts with `UnknownDecimalConfig` when either config is missing.
    function normalizeForRoute(
        uint256 amount,
        uint32 srcChainId,
        bytes32 srcTokenId,
        uint32 dstChainId,
        bytes32 dstTokenId
    ) external view returns (uint256 normalized) {
        ChainTokenConfig storage srcCfg = _configs[_configKey(srcChainId, srcTokenId)];
        if (!srcCfg.registered) revert UnknownDecimalConfig(srcChainId, srcTokenId);

        ChainTokenConfig storage dstCfg = _configs[_configKey(dstChainId, dstTokenId)];
        if (!dstCfg.registered) revert UnknownDecimalConfig(dstChainId, dstTokenId);

        if (srcCfg.decimals == dstCfg.decimals) return amount;
        return normalize(amount, srcCfg.decimals, dstCfg.decimals);
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _configKey(uint32 chainId, bytes32 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(chainId, tokenId));
    }
}
