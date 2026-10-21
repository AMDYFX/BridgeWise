import { Test, TestingModule } from '@nestjs/testing';
import { RequestSignatureService } from './request-signature.service';
import { CLOCK_SKEW_SECONDS } from './request-signature.constants';

// Helper: current Unix timestamp as string
const nowTs = () => String(Math.floor(Date.now() / 1000));

describe('RequestSignatureService', () => {
  let service: RequestSignatureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RequestSignatureService],
    }).compile();

    service = module.get(RequestSignatureService);
  });

  // ── buildCanonicalString ─────────────────────────────────────────────────

  describe('buildCanonicalString', () => {
    it('joins method, path, timestamp, and body-hash with newlines', () => {
      const canonical = service.buildCanonicalString('POST', '/v1/quotes', '1700000000', '{}');
      const parts = canonical.split('\n');

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('POST');
      expect(parts[1]).toBe('/v1/quotes');
      expect(parts[2]).toBe('1700000000');
      // Part 4 is the SHA-256 hex of '{}'
      expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('normalises method to uppercase', () => {
      const a = service.buildCanonicalString('get', '/health', '1700000000', '');
      const b = service.buildCanonicalString('GET', '/health', '1700000000', '');
      expect(a).toBe(b);
    });

    it('produces different hashes for different bodies', () => {
      const a = service.buildCanonicalString('POST', '/v1/quotes', '1700000000', '{"a":1}');
      const b = service.buildCanonicalString('POST', '/v1/quotes', '1700000000', '{"a":2}');
      expect(a).not.toBe(b);
    });

    it('accepts Buffer bodies', () => {
      const str = service.buildCanonicalString('POST', '/path', '1700000000', '{"x":1}');
      const buf = service.buildCanonicalString('POST', '/path', '1700000000', Buffer.from('{"x":1}'));
      expect(str).toBe(buf);
    });
  });

  // ── buildSignatureHeader ─────────────────────────────────────────────────

  describe('buildSignatureHeader', () => {
    it('returns a value prefixed with "sha256="', () => {
      const sig = service.buildSignatureHeader('POST', '/v1/quotes', nowTs(), '{}', 'secret');
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });

  // ── verify — valid request ───────────────────────────────────────────────

  describe('verify — valid request', () => {
    it('accepts a correctly signed request', () => {
      const secret = 'my-shared-secret';
      const ts = nowTs();
      const body = '{"amount":"100"}';
      const sig = service.buildSignatureHeader('POST', '/v1/bridge', ts, body, secret);

      const result = service.verify('POST', '/v1/bridge', ts, sig, body, secret);
      expect(result.valid).toBe(true);
    });

    it('is case-insensitive for the HTTP method', () => {
      const secret = 'my-secret';
      const ts = nowTs();
      const body = '';
      const sig = service.buildSignatureHeader('get', '/health', ts, body, secret);

      const result = service.verify('GET', '/health', ts, sig, body, secret);
      expect(result.valid).toBe(true);
    });

    it('accepts a Buffer body', () => {
      const secret = 'buffer-secret';
      const ts = nowTs();
      const body = Buffer.from('{"data":"test"}');
      const sig = service.buildSignatureHeader('POST', '/api/data', ts, body, secret);

      const result = service.verify('POST', '/api/data', ts, sig, body, secret);
      expect(result.valid).toBe(true);
    });
  });

  // ── verify — missing headers ─────────────────────────────────────────────

  describe('verify — missing headers', () => {
    it('rejects when timestamp header is missing', () => {
      const result = service.verify('GET', '/path', undefined, 'sha256=abc', '', 'secret');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/timestamp/i);
    });

    it('rejects when signature header is missing', () => {
      const result = service.verify('GET', '/path', nowTs(), undefined, '', 'secret');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/signature/i);
    });
  });

  // ── verify — replay / timestamp attacks ──────────────────────────────────

  describe('verify — replay protection', () => {
    it('rejects requests with a stale timestamp', () => {
      const secret = 'secret';
      const staleTs = String(Math.floor(Date.now() / 1000) - CLOCK_SKEW_SECONDS - 1);
      const sig = service.buildSignatureHeader('GET', '/path', staleTs, '', secret);

      const result = service.verify('GET', '/path', staleTs, sig, '', secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/too old/i);
    });

    it('rejects requests timestamped too far in the future', () => {
      const secret = 'secret';
      const futureTs = String(Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS + 60);
      const sig = service.buildSignatureHeader('GET', '/path', futureTs, '', secret);

      const result = service.verify('GET', '/path', futureTs, sig, '', secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/future/i);
    });

    it('rejects a non-numeric timestamp', () => {
      const result = service.verify('GET', '/path', 'not-a-number', 'sha256=abc', '', 'secret');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/valid unix timestamp/i);
    });
  });

  // ── verify — tampered requests ───────────────────────────────────────────

  describe('verify — tampered requests', () => {
    it('rejects when the body is modified after signing', () => {
      const secret = 'secret';
      const ts = nowTs();
      const sig = service.buildSignatureHeader('POST', '/v1/bridge', ts, '{"amount":100}', secret);

      const result = service.verify('POST', '/v1/bridge', ts, sig, '{"amount":999}', secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/mismatch/i);
    });

    it('rejects when the path is different from the signed path', () => {
      const secret = 'secret';
      const ts = nowTs();
      const body = '{}';
      const sig = service.buildSignatureHeader('GET', '/v1/quotes', ts, body, secret);

      const result = service.verify('GET', '/v1/other', ts, sig, body, secret);
      expect(result.valid).toBe(false);
    });

    it('rejects when the signature prefix is absent', () => {
      const secret = 'secret';
      const ts = nowTs();
      const sig = service.sign(service.buildCanonicalString('GET', '/path', ts, ''), secret);

      // sig is plain hex without "sha256=" prefix
      const result = service.verify('GET', '/path', ts, sig, '', secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/must begin with/i);
    });

    it('rejects when the wrong secret is used', () => {
      const ts = nowTs();
      const sig = service.buildSignatureHeader('POST', '/v1/bridge', ts, '{}', 'correct-secret');

      const result = service.verify('POST', '/v1/bridge', ts, sig, '{}', 'wrong-secret');
      expect(result.valid).toBe(false);
    });

    it('rejects a signature with incorrect hex', () => {
      const ts = nowTs();
      const result = service.verify('GET', '/path', ts, 'sha256=zzzzinvalidhex', '', 'secret');
      expect(result.valid).toBe(false);
    });
  });
});
