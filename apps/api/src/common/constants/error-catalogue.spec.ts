import { HttpStatus } from '@nestjs/common';
import { ALL_ERROR_CODES } from './error-codes';
import {
  ERROR_CATALOGUE,
  ErrorCatalogueEntry,
  getAllCatalogueEntries,
  getCatalogueEntry,
  getHttpStatus,
} from './error-catalogue';

describe('Error Catalogue', () => {
  // ── completeness ──────────────────────────────────────────────────────────

  describe('completeness', () => {
    it('has an entry for every code in ALL_ERROR_CODES', () => {
      const catalogueCodes = new Set(Object.keys(ERROR_CATALOGUE));
      const allCodes = Object.values(ALL_ERROR_CODES) as string[];

      const missing = allCodes.filter((c) => !catalogueCodes.has(c));
      expect(missing).toEqual([]);
    });

    it('every entry has the same code as its key', () => {
      const entries = Object.entries(ERROR_CATALOGUE) as [string, ErrorCatalogueEntry][];
      const mismatched = entries.filter(([key, entry]) => key !== entry.code);
      expect(mismatched).toEqual([]);
    });
  });

  // ── entry shape ───────────────────────────────────────────────────────────

  describe('entry shape', () => {
    const allEntries = Object.values(ERROR_CATALOGUE);

    it('every entry has a non-empty title', () => {
      const blank = allEntries.filter((e) => !e.title || e.title.trim() === '');
      expect(blank).toHaveLength(0);
    });

    it('every entry has a non-empty description', () => {
      const blank = allEntries.filter((e) => !e.description || e.description.trim() === '');
      expect(blank).toHaveLength(0);
    });

    it('every httpStatus is a valid HttpStatus value', () => {
      const validStatuses = new Set(Object.values(HttpStatus).filter((v) => typeof v === 'number'));
      const invalid = allEntries.filter((e) => !validStatuses.has(e.httpStatus));
      expect(invalid).toHaveLength(0);
    });

    it('retryHint is one of never | fixed | backoff', () => {
      const valid = new Set(['never', 'fixed', 'backoff']);
      const invalid = allEntries.filter((e) => !valid.has(e.retryHint));
      expect(invalid).toHaveLength(0);
    });

    it('entries with retryHint "fixed" have a retryAfterSeconds value', () => {
      const fixedWithoutDelay = allEntries.filter(
        (e) => e.retryHint === 'fixed' && e.retryAfterSeconds === undefined,
      );
      expect(fixedWithoutDelay).toHaveLength(0);
    });
  });

  // ── getCatalogueEntry ─────────────────────────────────────────────────────

  describe('getCatalogueEntry', () => {
    it('returns the correct entry for a known code', () => {
      const entry = getCatalogueEntry(ALL_ERROR_CODES.UNAUTHORIZED);
      expect(entry.code).toBe(ALL_ERROR_CODES.UNAUTHORIZED);
      expect(entry.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('falls back to INTERNAL_SERVER_ERROR for unknown codes', () => {
      const entry = getCatalogueEntry('TOTALLY_MADE_UP_CODE');
      expect(entry.code).toBe(ALL_ERROR_CODES.INTERNAL_SERVER_ERROR);
    });
  });

  // ── getHttpStatus ─────────────────────────────────────────────────────────

  describe('getHttpStatus', () => {
    it('returns 404 for NOT_FOUND', () => {
      expect(getHttpStatus(ALL_ERROR_CODES.NOT_FOUND)).toBe(HttpStatus.NOT_FOUND);
    });

    it('returns 429 for RATE_LIMIT_EXCEEDED', () => {
      expect(getHttpStatus(ALL_ERROR_CODES.RATE_LIMIT_EXCEEDED)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('returns 500 for unknown codes', () => {
      expect(getHttpStatus('NONEXISTENT')).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  // ── getAllCatalogueEntries ────────────────────────────────────────────────

  describe('getAllCatalogueEntries', () => {
    it('returns an array with the same length as ALL_ERROR_CODES', () => {
      const allCodes = Object.keys(ALL_ERROR_CODES);
      expect(getAllCatalogueEntries()).toHaveLength(allCodes.length);
    });
  });

  // ── spot checks ───────────────────────────────────────────────────────────

  describe('spot checks', () => {
    it('WEBHOOK_URL_NOT_HTTPS has 400 status and retryHint never', () => {
      const e = getCatalogueEntry(ALL_ERROR_CODES.WEBHOOK_URL_NOT_HTTPS);
      expect(e.httpStatus).toBe(HttpStatus.BAD_REQUEST);
      expect(e.retryHint).toBe('never');
    });

    it('RATE_LIMIT_EXCEEDED has retryAfterSeconds', () => {
      const e = getCatalogueEntry(ALL_ERROR_CODES.RATE_LIMIT_EXCEEDED);
      expect(e.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('SIGNATURE_INVALID entry exists and maps to 401', () => {
      const e = getCatalogueEntry(ALL_ERROR_CODES.SIGNATURE_INVALID);
      expect(e.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
    });
  });
});
