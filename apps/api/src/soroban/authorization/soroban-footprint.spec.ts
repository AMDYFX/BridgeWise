import {
  SorobanFootprintValidator,
  SorobanFootprint,
  ResourceBudget,
  SorobanAuthorizationEntry,
  NetworkPassphraseMismatchError,
  ResourceLimitExceededError,
  STELLAR_NETWORKS,
} from './soroban-footprint';

describe('SorobanFootprintValidator regression tests', () => {
  let validator: SorobanFootprintValidator;

  const validKey1 = {
    type: 'contract_data' as const,
    contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CWL5GZAIBWKGCA3',
    keyHex: '0000000100000002',
  };

  const validKey2 = {
    type: 'contract_data' as const,
    contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CWL5GZAIBWKGCA3',
    keyHex: '0000000100000003',
  };

  const validKey3 = {
    type: 'account' as const,
    keyHex: 'aabbccdd11223344',
  };

  beforeEach(() => {
    validator = new SorobanFootprintValidator(STELLAR_NETWORKS.TESTNET);
  });

  describe('footprint structure validation', () => {
    it('passes valid disjoint readOnly and readWrite footprints', () => {
      const footprint: SorobanFootprint = {
        readOnly: [validKey1],
        readWrite: [validKey2],
      };

      const result = validator.validateFootprintStructure(footprint);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects footprint when key exists in both readOnly and readWrite sets', () => {
      const footprint: SorobanFootprint = {
        readOnly: [validKey1],
        readWrite: [validKey1],
      };

      const result = validator.validateFootprintStructure(footprint);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('both readOnly and readWrite');
    });

    it('rejects duplicate keys within the same set', () => {
      const footprint: SorobanFootprint = {
        readOnly: [validKey1, validKey1],
        readWrite: [],
      };

      const result = validator.validateFootprintStructure(footprint);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Duplicate readOnly key');
    });

    it('rejects non-hex key data', () => {
      const footprint: SorobanFootprint = {
        readOnly: [{ type: 'account', keyHex: 'not-a-valid-hex-key!' }],
        readWrite: [],
      };

      const result = validator.validateFootprintStructure(footprint);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid hex');
    });
  });

  describe('concurrent footprint collision detection', () => {
    it('detects no conflict between disjoint footprints', () => {
      const a: SorobanFootprint = {
        readOnly: [validKey1],
        readWrite: [validKey2],
      };
      const b: SorobanFootprint = {
        readOnly: [validKey3],
        readWrite: [],
      };

      const check = validator.checkFootprintConflict(a, b);
      expect(check.conflict).toBe(false);
    });

    it('detects conflict when one transaction writes to a key read by another', () => {
      const a: SorobanFootprint = {
        readOnly: [validKey1],
        readWrite: [],
      };
      const b: SorobanFootprint = {
        readOnly: [],
        readWrite: [validKey1],
      };

      const check = validator.checkFootprintConflict(a, b);
      expect(check.conflict).toBe(true);
      expect(check.conflictingKey).toContain('0000000100000002');
    });

    it('detects conflict when both transactions write to the same key', () => {
      const a: SorobanFootprint = {
        readOnly: [],
        readWrite: [validKey2],
      };
      const b: SorobanFootprint = {
        readOnly: [],
        readWrite: [validKey2],
      };

      const check = validator.checkFootprintConflict(a, b);
      expect(check.conflict).toBe(true);
    });
  });

  describe('resource budget and limits', () => {
    it('accepts resource consumption within bounds', () => {
      const budget: ResourceBudget = {
        cpuInstructions: 5_000_000n,
        memoryBytes: 1_000_000n,
        readBytes: 10_000n,
        writeBytes: 5_000n,
      };
      expect(() => validator.validateResourceBudget(budget)).not.toThrow();
    });

    it('rejects transaction exceeding maximum CPU instructions', () => {
      const budget: ResourceBudget = {
        cpuInstructions: 100_000_001n, // Exceeds 100M limit
        memoryBytes: 1000n,
        readBytes: 1000n,
        writeBytes: 1000n,
      };
      expect(() => validator.validateResourceBudget(budget)).toThrow(ResourceLimitExceededError);
    });

    it('rejects transaction exceeding memory limit', () => {
      const budget: ResourceBudget = {
        cpuInstructions: 1000n,
        memoryBytes: 40_000_001n, // Exceeds 40MB limit
        readBytes: 1000n,
        writeBytes: 1000n,
      };
      expect(() => validator.validateResourceBudget(budget)).toThrow(ResourceLimitExceededError);
    });
  });

  describe('network passphrase isolation and authorization', () => {
    const validEntry: SorobanAuthorizationEntry = {
      authorizer: 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CWL5GZAIBWKGCA3',
      networkPassphrase: STELLAR_NETWORKS.TESTNET,
      nonce: 10n,
      expirationLedger: 500,
      rootInvocation: {
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CWL5GZAIBWKGCA3',
        functionName: 'bridge_transfer',
        args: [],
      },
    };

    it('passes valid authorization entry on correct network', () => {
      const res = validator.validateAuthorization(validEntry, 400); // Current ledger 400 < 500
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('rejects authorization signed for different network (e.g. Mainnet passphrase on Testnet)', () => {
      const mainnetEntry = {
        ...validEntry,
        networkPassphrase: STELLAR_NETWORKS.PUBLIC,
      };
      expect(() => validator.validateAuthorization(mainnetEntry, 400)).toThrow(
        NetworkPassphraseMismatchError,
      );
    });

    it('rejects expired authorization where expirationLedger <= currentLedger', () => {
      const expiredEntry = { ...validEntry, expirationLedger: 300 };
      const res = validator.validateAuthorization(expiredEntry, 400);
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Authorization expired');
    });

    it('rejects malformed rootInvocation', () => {
      const badEntry = {
        ...validEntry,
        rootInvocation: { contractId: '', functionName: '' },
      };
      const res = validator.validateAuthorization(badEntry, 400);
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Malformed rootInvocation');
    });
  });
});
