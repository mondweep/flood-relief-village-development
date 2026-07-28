import { describe, expect, it } from 'vitest';
import { addMoney, asId, geoPoint, gte, isUuid, money, ok, err, unwrap } from './index.js';

// Shared kernel value objects are pure: state-based tests are appropriate here (ADR-004 §5).
describe('shared kernel', () => {
  describe('Result', () => {
    it('ok carries the value', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
      expect(unwrap(r)).toBe(42);
    });

    it('err carries code and message, and unwrap throws', () => {
      const r = err('SOME_CODE', 'boom');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SOME_CODE');
      expect(() => unwrap(r)).toThrow(/SOME_CODE/);
    });
  });

  describe('ids', () => {
    it('accepts valid UUIDs and brands them', () => {
      const raw = '3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
      expect(isUuid(raw)).toBe(true);
      expect(asId<'VillageId'>(raw)).toBe(raw);
    });

    it('rejects non-UUID strings', () => {
      expect(isUuid('village-1')).toBe(false);
      expect(() => asId('village-1')).toThrow(/invalid id/);
    });
  });

  describe('Money', () => {
    it('creates integer minor-unit money', () => {
      const m = unwrap(money(150_00, 'INR'));
      expect(m.amountMinor).toBe(15000);
      expect(m.currency).toBe('INR');
    });

    it('rejects fractional, negative and bad-currency amounts', () => {
      expect(money(10.5).ok).toBe(false);
      expect(money(-1).ok).toBe(false);
      expect(money(1, 'rupees').ok).toBe(false);
    });

    it('adds same-currency money and rejects mixed currency', () => {
      const a = unwrap(money(100));
      const b = unwrap(money(250));
      expect(unwrap(addMoney(a, b)).amountMinor).toBe(350);
      expect(addMoney(a, unwrap(money(1, 'USD'))).ok).toBe(false);
      expect(gte(b, a)).toBe(true);
    });
  });

  describe('GeoPoint', () => {
    it('accepts valid coordinates and rejects out-of-range ones', () => {
      expect(geoPoint(26.2, 92.9).ok).toBe(true);
      expect(geoPoint(91, 0).ok).toBe(false);
      expect(geoPoint(0, 181).ok).toBe(false);
      expect(geoPoint(Number.NaN, 0).ok).toBe(false);
    });
  });
});
