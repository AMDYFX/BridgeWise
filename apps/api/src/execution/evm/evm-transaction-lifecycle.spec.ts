import {
  EvmTransactionLifecycleManager,
  InvalidLifecycleTransitionError,
  LifecycleVersionConflictError,
  InvalidReplacementError,
} from './evm-transaction-lifecycle';

describe('EvmTransactionLifecycleManager', () => {
  let clock = 1_000;
  const now = () => clock;
  let manager: EvmTransactionLifecycleManager;

  const validHash1 = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const validHash2 = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  beforeEach(() => {
    clock = 1_000;
    manager = new EvmTransactionLifecycleManager(now);
  });

  describe('happy path lifecycle', () => {
    it('progresses from prepared -> submitted -> in_mempool -> mined -> confirmed', () => {
      const tx = manager.prepare({
        id: 'tx-1',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 5,
        gasConfig: { gasPrice: 20_000_000_000n, gasLimit: 21_000n },
        requiredConfirmations: 3,
      });

      expect(tx.state).toBe('prepared');
      expect(tx.version).toBe(1);

      // Transition to submitted
      clock = 1_500;
      const submitted = manager.markSubmitted('tx-1', validHash1, 1);
      expect(submitted.state).toBe('submitted');
      expect(submitted.version).toBe(2);
      expect(submitted.txHash).toBe(validHash1);

      // Transition to mempool
      clock = 2_000;
      const mempool = manager.markMempool('tx-1', 2);
      expect(mempool.state).toBe('in_mempool');
      expect(mempool.version).toBe(3);

      // Transition to mined (depth 1 < required 3)
      clock = 5_000;
      const mined = manager.recordMined('tx-1', 100, '0xblockhash100', 3);
      expect(mined.state).toBe('mined');
      expect(mined.confirmations).toBe(1);
      expect(mined.version).toBe(4);

      // Advance depth to 2 (still < 3)
      const depth2 = manager.advanceConfirmations('tx-1', 101, 4);
      expect(depth2.state).toBe('mined');
      expect(depth2.confirmations).toBe(2);

      // Advance depth to 3 (reaches requiredConfirmations -> confirmed)
      const confirmed = manager.advanceConfirmations('tx-1', 102, 5);
      expect(confirmed.state).toBe('confirmed');
      expect(confirmed.confirmations).toBe(3);
    });
  });

  describe('concurrency and optimistic locking', () => {
    it('prevents concurrent conflicting transitions via version conflict check', () => {
      manager.prepare({
        id: 'tx-conc',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 0,
        gasConfig: { gasLimit: 21_000n },
      });

      // First actor submits
      manager.markSubmitted('tx-conc', validHash1, 1);

      // Second actor attempts to submit or cancel with stale version 1
      expect(() => manager.cancel('tx-conc', 1)).toThrow(LifecycleVersionConflictError);
    });

    it('rejects illegal state transitions', () => {
      manager.prepare({
        id: 'tx-invalid',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 1,
        gasConfig: { gasLimit: 21_000n },
      });

      // prepared cannot transition directly to confirmed or mined without being submitted
      expect(() => manager.recordMined('tx-invalid', 50, '0xhash', 1)).toThrow(
        InvalidLifecycleTransitionError,
      );
    });
  });

  describe('replacement and speedup', () => {
    it('enforces minimum 10% gas price bump and links original and replacement transactions', () => {
      manager.prepare({
        id: 'tx-stuck',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 7,
        gasConfig: { gasPrice: 100n, gasLimit: 21_000n },
      });
      manager.markSubmitted('tx-stuck', validHash1, 1);

      // Attempting replacement with < 10% bump (e.g., 105n < 110n)
      expect(() =>
        manager.replace(
          'tx-stuck',
          'tx-speedup',
          { gasPrice: 105n, gasLimit: 21_000n },
          2,
        ),
      ).toThrow(InvalidReplacementError);

      // Valid replacement with 15% bump (115n)
      const { original, replacement } = manager.replace(
        'tx-stuck',
        'tx-speedup',
        { gasPrice: 115n, gasLimit: 21_000n },
        2,
      );

      expect(original.state).toBe('replaced');
      expect(original.replacementTxId).toBe('tx-speedup');
      expect(replacement.state).toBe('prepared');
      expect(replacement.nonce).toBe(7); // Preserves exact same nonce
      expect(replacement.gasConfig.gasPrice).toBe(115n);
    });
  });

  describe('chain reorg handling', () => {
    it('transitions mined transaction to reorg_detected if block hash differs', () => {
      manager.prepare({
        id: 'tx-reorg',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 10,
        gasConfig: { gasLimit: 21_000n },
        requiredConfirmations: 2,
      });
      manager.markSubmitted('tx-reorg', validHash1, 1);
      manager.recordMined('tx-reorg', 500, '0xcanonicalHash', 2);

      // Check same block hash -> no reorg
      const noReorg = manager.detectReorg('tx-reorg', '0xcanonicalHash', 3);
      expect(noReorg.state).toBe('mined');

      // Check different block hash -> reorg detected
      const reorged = manager.detectReorg('tx-reorg', '0xforkedBlockHash', 3);
      expect(reorged.state).toBe('reorg_detected');
      expect(reorged.confirmations).toBe(0);
    });
  });

  describe('timeout detection and reversion', () => {
    it('transitions to timed_out when submitted tx exceeds timeout threshold', () => {
      manager.prepare({
        id: 'tx-timeout',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 12,
        gasConfig: { gasLimit: 21_000n },
      });
      clock = 1_000;
      manager.markSubmitted('tx-timeout', validHash1, 1);

      clock = 10_000;
      // Below 15,000 timeout threshold
      const notTimedOut = manager.checkTimeout('tx-timeout', 15_000, 2);
      expect(notTimedOut.state).toBe('submitted');

      clock = 20_000; // 19,000 elapsed > 15,000 threshold
      const timedOut = manager.checkTimeout('tx-timeout', 15_000, 2);
      expect(timedOut.state).toBe('timed_out');
    });

    it('records reverted transaction with reason', () => {
      manager.prepare({
        id: 'tx-rev',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 15,
        gasConfig: { gasLimit: 21_000n },
      });
      manager.markSubmitted('tx-rev', validHash1, 1);
      manager.recordMined('tx-rev', 777, '0xblock', 2);

      const reverted = manager.markReverted('tx-rev', 777, 'execution reverted: SlippageExceeded', 3);
      expect(reverted.state).toBe('reverted');
    });
  });

  describe('redaction of sensitive fields', () => {
    it('redacts private keys and auth tokens in metadata and event history', () => {
      manager.prepare({
        id: 'tx-sec',
        chainId: 1,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        nonce: 20,
        gasConfig: { gasLimit: 21_000n },
        metadata: {
          bridge: 'stargate',
          privateKey: '0xabcdef0123456789abcdef0123456789',
          authToken: 'secret_token_123',
        },
      });

      const tx = manager.get('tx-sec');
      expect(tx?.metadata?.privateKey).toBe('[REDACTED]');
      expect(tx?.metadata?.authToken).toBe('[REDACTED]');
      expect(tx?.metadata?.bridge).toBe('stargate');
      expect(JSON.stringify(tx)).not.toContain('0xabcdef0123456789abcdef0123456789');
    });
  });
});
