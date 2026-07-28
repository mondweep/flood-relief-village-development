import { describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import {
  type BudgetLedger,
  createBudgetLedger,
  recordRelease,
  recordSpend,
  totalReleased,
  totalSpent,
} from './budget-ledger.js';
import { inr, usd } from '../test-support.js';

// Pure value object: state-based assertions are appropriate here (ADR-004 §5).
const AT = new Date('2026-02-01T00:00:00.000Z');
const ledger = (): BudgetLedger => unwrap(createBudgetLedger(inr(1_000_000)));

describe('FR-FM-2 BudgetLedger', () => {
  describe('creation', () => {
    it('FR-FM-2: starts with no releases and no expenditures', () => {
      const l = ledger();
      expect(l.releases).toEqual([]);
      expect(l.expenditures).toEqual([]);
      expect(totalReleased(l).amountMinor).toBe(0);
      expect(totalSpent(l).amountMinor).toBe(0);
      expect(totalReleased(l).currency).toBe('INR');
    });

    it('FR-FM-2: rejects a zero sanctioned budget', () => {
      const r = createBudgetLedger(inr(0));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SANCTIONED_NOT_POSITIVE');
    });
  });

  describe('releases (released <= sanctioned)', () => {
    it('FR-FM-2: accumulates releases', () => {
      const l = unwrap(recordRelease(unwrap(recordRelease(ledger(), inr(300_000), AT)), inr(200_000), AT));
      expect(totalReleased(l).amountMinor).toBe(500_000);
      expect(l.releases).toHaveLength(2);
    });

    it('FR-FM-2: allows releasing exactly the sanctioned amount', () => {
      expect(recordRelease(ledger(), inr(1_000_000), AT).ok).toBe(true);
    });

    it('FR-FM-2: rejects a release beyond sanctioned with RELEASE_EXCEEDS_SANCTIONED', () => {
      const r = recordRelease(ledger(), inr(1_000_001), AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RELEASE_EXCEEDS_SANCTIONED');
    });

    it('FR-FM-2: rejects a cumulative release beyond sanctioned', () => {
      const first = unwrap(recordRelease(ledger(), inr(900_000), AT));
      const r = recordRelease(first, inr(100_001), AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RELEASE_EXCEEDS_SANCTIONED');
    });

    it('FR-FM-2: rejects a release in a foreign currency', () => {
      const r = recordRelease(ledger(), usd(100), AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CURRENCY_MISMATCH');
    });

    it('FR-FM-2: rejects a zero release', () => {
      const r = recordRelease(ledger(), inr(0), AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('AMOUNT_NOT_POSITIVE');
    });

    it('FR-FM-2: leaves the original ledger untouched (immutability)', () => {
      const original = ledger();
      unwrap(recordRelease(original, inr(1), AT));
      expect(original.releases).toEqual([]);
    });
  });

  describe('expenditures (spent <= released)', () => {
    const released = (): BudgetLedger => unwrap(recordRelease(ledger(), inr(500_000), AT));

    it('FR-FM-2: records an expenditure within released funds', () => {
      const l = unwrap(recordSpend(released(), inr(120_000), 'culvert pipes', AT));
      expect(totalSpent(l).amountMinor).toBe(120_000);
      expect(l.expenditures[0]?.description).toBe('culvert pipes');
    });

    it('FR-FM-2: allows spending exactly the released amount', () => {
      expect(recordSpend(released(), inr(500_000), 'final bill', AT).ok).toBe(true);
    });

    it('FR-FM-2: rejects spending more than released with SPEND_EXCEEDS_RELEASED', () => {
      const r = recordSpend(released(), inr(500_001), 'over the top', AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SPEND_EXCEEDS_RELEASED');
    });

    it('FR-FM-2: rejects cumulative spend beyond released', () => {
      const once = unwrap(recordSpend(released(), inr(400_000), 'labour', AT));
      const r = recordSpend(once, inr(100_001), 'more labour', AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SPEND_EXCEEDS_RELEASED');
    });

    it('FR-FM-2: rejects any spend when nothing is released', () => {
      const r = recordSpend(ledger(), inr(1), 'premature', AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('SPEND_EXCEEDS_RELEASED');
    });

    it('FR-FM-2: rejects an expenditure without a description', () => {
      const r = recordSpend(released(), inr(1_000), '  ', AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EXPENDITURE_NEEDS_DESCRIPTION');
    });

    it('FR-FM-2: rejects a zero expenditure', () => {
      const r = recordSpend(released(), inr(0), 'nothing', AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('AMOUNT_NOT_POSITIVE');
    });

    it('FR-FM-2: rejects an expenditure in a foreign currency', () => {
      const r = recordSpend(released(), usd(10), 'imported steel', AT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('CURRENCY_MISMATCH');
    });

    it('FR-FM-2: trims the stored description', () => {
      const l = unwrap(recordSpend(released(), inr(10), '  gravel  ', AT));
      expect(l.expenditures[0]?.description).toBe('gravel');
    });
  });
});
