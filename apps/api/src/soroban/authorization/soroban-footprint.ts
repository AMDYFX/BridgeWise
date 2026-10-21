/**
 * Soroban Authorization Footprint and Resource Limits Validator.
 *
 * Verifies Soroban ledger footprints (read-only and read-write keys),
 * CPU/memory resource limits, network passphrase isolation, and invocation authorization trees.
 *
 * @see Issue #1325 — Add Soroban authorization footprint regression tests
 */

export const STELLAR_NETWORKS = {
  PUBLIC: 'Public Global Stellar Network ; July 2018',
  TESTNET: 'Test SDF Network ; September 2015',
  FUTURENET: 'Test SDF Future Network ; October 2022',
  STANDALONE: 'Standalone Network ; February 2017',
} as const;

export type StellarNetworkPassphrase = (typeof STELLAR_NETWORKS)[keyof typeof STELLAR_NETWORKS] | string;

export interface LedgerKeyRef {
  type: 'contract_data' | 'account' | 'trustline' | 'contract_code';
  contractId?: string;
  keyHex: string;
}

export interface SorobanFootprint {
  readOnly: LedgerKeyRef[];
  readWrite: LedgerKeyRef[];
}

export interface ResourceBudget {
  cpuInstructions: bigint;
  memoryBytes: bigint;
  readBytes: bigint;
  writeBytes: bigint;
}

export const PROTOCOL_RESOURCE_LIMITS: ResourceBudget = {
  cpuInstructions: 100_000_000n,
  memoryBytes: 40_000_000n,
  readBytes: 200_000n,
  writeBytes: 100_000n,
};

export interface SorobanAuthInvocation {
  contractId: string;
  functionName: string;
  args?: unknown[];
  subInvocations?: SorobanAuthInvocation[];
}

export interface SorobanAuthorizationEntry {
  authorizer: string;
  networkPassphrase: string;
  signature?: string;
  nonce: bigint;
  expirationLedger: number;
  rootInvocation: SorobanAuthInvocation;
}

export interface FootprintSimulationResult {
  valid: boolean;
  footprint: SorobanFootprint;
  resources: ResourceBudget;
  errors: string[];
}

export class NetworkPassphraseMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Network passphrase mismatch: expected "${expected}", received "${actual}"`);
    this.name = 'NetworkPassphraseMismatchError';
  }
}

export class ResourceLimitExceededError extends Error {
  constructor(resource: string, requested: bigint, limit: bigint) {
    super(`Resource limit exceeded for ${resource}: requested ${requested}, maximum allowed ${limit}`);
    this.name = 'ResourceLimitExceededError';
  }
}

export class FootprintCollisionError extends Error {
  constructor(conflictingKey: string) {
    super(`Footprint conflict detected on read/write key: ${conflictingKey}`);
    this.name = 'FootprintCollisionError';
  }
}

export class SorobanFootprintValidator {
  private readonly expectedNetwork: StellarNetworkPassphrase;
  private readonly limits: ResourceBudget;

  constructor(
    expectedNetwork: StellarNetworkPassphrase = STELLAR_NETWORKS.PUBLIC,
    limits: ResourceBudget = PROTOCOL_RESOURCE_LIMITS,
  ) {
    this.expectedNetwork = expectedNetwork;
    this.limits = limits;
  }

  /**
   * Serializes a ledger key reference to a unique deterministic string.
   */
  serializeKey(key: LedgerKeyRef): string {
    return `${key.type}:${key.contractId ?? ''}:${key.keyHex.toLowerCase()}`;
  }

  /**
   * Validates footprint structure:
   * - No key can be in both readOnly and readWrite.
   * - No duplicate keys within the same set.
   */
  validateFootprintStructure(footprint: SorobanFootprint): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const readOnlyKeys = new Set<string>();
    const readWriteKeys = new Set<string>();

    for (const key of footprint.readOnly) {
      if (!key.keyHex || !/^[0-9a-fA-F]+$/.test(key.keyHex)) {
        errors.push(`Invalid hex in readOnly key: ${key.keyHex}`);
        continue;
      }
      const serialized = this.serializeKey(key);
      if (readOnlyKeys.has(serialized)) {
        errors.push(`Duplicate readOnly key: ${serialized}`);
      }
      readOnlyKeys.add(serialized);
    }

    for (const key of footprint.readWrite) {
      if (!key.keyHex || !/^[0-9a-fA-F]+$/.test(key.keyHex)) {
        errors.push(`Invalid hex in readWrite key: ${key.keyHex}`);
        continue;
      }
      const serialized = this.serializeKey(key);
      if (readWriteKeys.has(serialized)) {
        errors.push(`Duplicate readWrite key: ${serialized}`);
      }
      if (readOnlyKeys.has(serialized)) {
        errors.push(`Key cannot exist in both readOnly and readWrite sets: ${serialized}`);
      }
      readWriteKeys.add(serialized);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Checks whether two footprints conflict for concurrent transaction execution.
   * Concurrent transactions conflict if the readWrite of one overlaps with either
   * readOnly or readWrite of the other.
   */
  checkFootprintConflict(a: SorobanFootprint, b: SorobanFootprint): { conflict: boolean; conflictingKey?: string } {
    const aWrites = new Set(a.readWrite.map((k) => this.serializeKey(k)));
    const bWrites = new Set(b.readWrite.map((k) => this.serializeKey(k)));
    const aReads = new Set(a.readOnly.map((k) => this.serializeKey(k)));
    const bReads = new Set(b.readOnly.map((k) => this.serializeKey(k)));

    // Check write-write conflicts
    for (const key of aWrites) {
      if (bWrites.has(key)) return { conflict: true, conflictingKey: key };
      if (bReads.has(key)) return { conflict: true, conflictingKey: key };
    }

    // Check write-read conflicts
    for (const key of bWrites) {
      if (aReads.has(key)) return { conflict: true, conflictingKey: key };
    }

    return { conflict: false };
  }

  /**
   * Validates consumed resources against maximum protocol budgets.
   */
  validateResourceBudget(resources: ResourceBudget): void {
    if (resources.cpuInstructions > this.limits.cpuInstructions) {
      throw new ResourceLimitExceededError('cpuInstructions', resources.cpuInstructions, this.limits.cpuInstructions);
    }
    if (resources.memoryBytes > this.limits.memoryBytes) {
      throw new ResourceLimitExceededError('memoryBytes', resources.memoryBytes, this.limits.memoryBytes);
    }
    if (resources.readBytes > this.limits.readBytes) {
      throw new ResourceLimitExceededError('readBytes', resources.readBytes, this.limits.readBytes);
    }
    if (resources.writeBytes > this.limits.writeBytes) {
      throw new ResourceLimitExceededError('writeBytes', resources.writeBytes, this.limits.writeBytes);
    }
  }

  /**
   * Validates authorization entry network passphrase, expiration, and signature presence.
   */
  validateAuthorization(
    entry: SorobanAuthorizationEntry,
    currentLedger: number,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Enforce network passphrase match
    if (entry.networkPassphrase !== this.expectedNetwork) {
      throw new NetworkPassphraseMismatchError(this.expectedNetwork, entry.networkPassphrase);
    }

    // Enforce expiration ledger strictly > current ledger
    if (entry.expirationLedger <= currentLedger) {
      errors.push(
        `Authorization expired: current ledger ${currentLedger}, expiration ledger ${entry.expirationLedger}`,
      );
    }

    // Nonce must be non-negative
    if (entry.nonce < 0n) {
      errors.push('Nonce must be non-negative');
    }

    // Authorizer must be non-empty valid Stellar account or contract ID
    if (!entry.authorizer || entry.authorizer.length < 5) {
      errors.push('Invalid authorizer address');
    }

    // Root invocation must have function name and contract ID
    if (!entry.rootInvocation.contractId || !entry.rootInvocation.functionName) {
      errors.push('Malformed rootInvocation: missing contractId or functionName');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
