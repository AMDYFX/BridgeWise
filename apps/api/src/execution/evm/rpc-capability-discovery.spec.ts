import {
  ChainRpcCapabilityDiscoveryService,
  ChainIdMismatchError,
  sanitizeEndpoint,
  JsonRpcClient,
} from './rpc-capability-discovery';

describe('ChainRpcCapabilityDiscoveryService', () => {
  let clock = 10_000;
  const now = () => clock;

  beforeEach(() => {
    clock = 10_000;
  });

  describe('sanitizeEndpoint', () => {
    it('redacts basic authentication credentials', () => {
      const sanitized = sanitizeEndpoint('https://admin:superSecret@eth-node.internal:8545');
      expect(sanitized).not.toContain('superSecret');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('redacts api keys in query parameters', () => {
      const sanitized = sanitizeEndpoint('https://mainnet.infura.io/v3?apiKey=abcdef1234567890&token=sec_98765');
      expect(sanitized).not.toContain('abcdef1234567890');
      expect(sanitized).not.toContain('sec_98765');
      expect(sanitized).toContain('apiKey=%5BREDACTED%5D');
    });

    it('redacts path-based API keys', () => {
      const sanitized = sanitizeEndpoint('https://eth-mainnet.alchemyapi.io/v2/abcdef12345678901234567890123456');
      expect(sanitized).not.toContain('abcdef12345678901234567890123456');
      expect(sanitized).toContain('[REDACTED]');
    });
  });

  describe('capability discovery', () => {
    it('discovers modern EVM capabilities for supported chain', async () => {
      const service = new ChainRpcCapabilityDiscoveryService({ now, cacheTtlMs: 30_000 });
      const calls: string[] = [];

      const mockClient: JsonRpcClient = {
        async call(method: string): Promise<unknown> {
          calls.push(method);
          if (method === 'eth_chainId') return '0x1'; // Ethereum Mainnet (1)
          if (method === 'eth_blockNumber') return '0x123456';
          if (method === 'eth_feeHistory') return { oldestBlock: '0x1', baseFeePerGas: ['0x100'] };
          if (method === 'eth_blobBaseFee') return '0x10';
          if (method === 'eth_getBlockByNumber') return { number: '0x123456', hash: '0xabc' };
          if (method === 'eth_call') return '0x00';
          if (method === 'debug_traceCall') return { gas: 1000 };
          return null;
        },
      };

      const profile = await service.discover(1, 'https://eth.rpc.example.com?apiKey=secretKey123', mockClient);

      expect(profile.chainId).toBe(1);
      expect(profile.status).toBe('healthy');
      expect(profile.sanitizedEndpoint).not.toContain('secretKey123');
      expect(profile.capabilities.eip1559).toBe(true);
      expect(profile.capabilities.eip4844).toBe(true);
      expect(profile.capabilities.finalityTags).toBe(true);
      expect(profile.capabilities.debugTrace).toBe(true);
      expect(profile.capabilities.stateOverride).toBe(true);
      expect(profile.blockNumber).toBe(0x123456);

      // Verify cached profile is returned without invoking client again
      const cached = await service.discover(1, 'https://eth.rpc.example.com?apiKey=secretKey123', mockClient);
      expect(cached).toBe(profile);
      expect(calls.filter((c) => c === 'eth_chainId')).toHaveLength(1);
    });

    it('rejects RPC when reported chain ID mismatches expected chain ID', async () => {
      const service = new ChainRpcCapabilityDiscoveryService({ now });
      const mockClient: JsonRpcClient = {
        async call(method: string): Promise<unknown> {
          if (method === 'eth_chainId') return '0x89'; // Polygon (137) instead of Ethereum (1)
          return null;
        },
      };

      await expect(
        service.discover(1, 'https://mismatched-node.example.com', mockClient),
      ).rejects.toThrow(ChainIdMismatchError);

      const cached = service.getCachedProfile(1, 'https://mismatched-node.example.com');
      expect(cached?.status).toBe('chain_mismatch');
    });

    it('deduplicates concurrent discovery requests to the same endpoint', async () => {
      const service = new ChainRpcCapabilityDiscoveryService({ now });
      let chainIdCalls = 0;

      const mockClient: JsonRpcClient = {
        async call(method: string): Promise<unknown> {
          if (method === 'eth_chainId') {
            chainIdCalls++;
            // Small artificial latency
            await new Promise((r) => setTimeout(r, 10));
            return '0xa'; // Optimism (10)
          }
          if (method === 'eth_blockNumber') return '0x100';
          return null;
        },
      };

      const [p1, p2, p3] = await Promise.all([
        service.discover(10, 'https://optimism.io', mockClient),
        service.discover(10, 'https://optimism.io', mockClient),
        service.discover(10, 'https://optimism.io', mockClient),
      ]);

      expect(chainIdCalls).toBe(1);
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
    });

    it('handles unreachable RPC without crashing and records failure status', async () => {
      const service = new ChainRpcCapabilityDiscoveryService({ now });
      const mockClient: JsonRpcClient = {
        async call(): Promise<unknown> {
          throw new Error('ECONNREFUSED connect to 127.0.0.1:8545?token=sensitive_token_99');
        },
      };

      const profile = await service.discover(1, 'http://127.0.0.1:8545?token=sensitive_token_99', mockClient);
      expect(profile.status).toBe('unreachable');
      expect(profile.capabilities.eip1559).toBe(false);
      expect(profile.failureReason).toBeDefined();
      expect(profile.failureReason).not.toContain('sensitive_token_99');
    });

    it('expires cached profiles after cache TTL', async () => {
      const service = new ChainRpcCapabilityDiscoveryService({ now, cacheTtlMs: 5_000 });
      let fetchCount = 0;

      const mockClient: JsonRpcClient = {
        async call(method: string): Promise<unknown> {
          if (method === 'eth_chainId') {
            fetchCount++;
            return '0x1';
          }
          return '0x1';
        },
      };

      await service.discover(1, 'https://rpc.example.com', mockClient);
      expect(fetchCount).toBe(1);

      clock += 4_000;
      expect(service.getCachedProfile(1, 'https://rpc.example.com')).not.toBeNull();

      clock += 2_000; // Total 6_000ms > 5_000ms TTL
      expect(service.getCachedProfile(1, 'https://rpc.example.com')).toBeNull();

      await service.discover(1, 'https://rpc.example.com', mockClient);
      expect(fetchCount).toBe(2);
    });
  });
});
