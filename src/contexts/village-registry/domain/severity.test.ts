import { describe, expect, it } from 'vitest';
import { isSeverity, severityChangeRecord } from './severity.js';

// Pure value object: state-based tests are appropriate here (ADR-004 §5).
describe('Severity', () => {
  describe('isSeverity', () => {
    it('FR-VR-3: accepts every defined severity level', () => {
      expect(isSeverity('unaffected')).toBe(true);
      expect(isSeverity('low')).toBe(true);
      expect(isSeverity('moderate')).toBe(true);
      expect(isSeverity('severe')).toBe(true);
      expect(isSeverity('critical')).toBe(true);
    });

    it('FR-VR-3: rejects unknown severity strings', () => {
      expect(isSeverity('catastrophic')).toBe(false);
      expect(isSeverity('')).toBe(false);
    });
  });

  describe('severityChangeRecord', () => {
    const at = new Date('2026-07-28T00:00:00.000Z');

    it('FR-VR-3: records from/to/reason/at when the transition is valid', () => {
      const result = severityChangeRecord('low', 'moderate', 'flood waters rising', at);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ from: 'low', to: 'moderate', reason: 'flood waters rising', at });
      }
    });

    it('FR-VR-3: rejects severity change without reason', () => {
      const result = severityChangeRecord('low', 'moderate', '   ', at);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SEVERITY_REASON_REQUIRED');
    });

    it('FR-VR-3: rejects an unrecognised target severity', () => {
      const result = severityChangeRecord('low', 'catastrophic', 'reason given', at);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SEVERITY_INVALID');
    });
  });
});
