import { describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { aidEvent, isSuspectedDuplicate } from './aid-event.js';

// Pure VO: state-based tests (ADR-004 §5).
describe('AidEvent', () => {
  it('FR-BR-2: creates an aid event with kind, provider and timestamp', () => {
    const at = new Date('2026-07-01T00:00:00Z');
    const event = unwrap(aidEvent('food', 'Red Cross', at));

    expect(event.kind).toBe('food');
    expect(event.providerName).toBe('Red Cross');
    expect(event.at).toEqual(at);
    expect(event.note).toBeUndefined();
  });

  it('FR-BR-2: keeps an optional trimmed note when provided', () => {
    const event = unwrap(aidEvent('cash', 'Gov Relief', new Date(), '  emergency top-up  '));
    expect(event.note).toBe('emergency top-up');
  });

  it('FR-BR-2: rejects an empty kind or provider name', () => {
    expect(aidEvent('', 'Red Cross', new Date()).ok).toBe(false);
    expect(aidEvent('food', '  ', new Date()).ok).toBe(false);
  });

  it('FR-BR-2: rejects an invalid timestamp', () => {
    expect(aidEvent('food', 'Red Cross', new Date('not-a-date')).ok).toBe(false);
  });

  it('FR-BR-3: same kind within the suspicion window is a suspected duplicate', () => {
    const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
    const second = unwrap(aidEvent('food', 'Other NGO', new Date('2026-07-05T00:00:00Z')));
    expect(isSuspectedDuplicate(second, first, 7)).toBe(true);
  });

  it('FR-BR-3: same kind exactly at the window boundary is still suspected', () => {
    const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
    const second = unwrap(aidEvent('food', 'Other NGO', new Date('2026-07-08T00:00:00Z')));
    expect(isSuspectedDuplicate(second, first, 7)).toBe(true);
  });

  it('FR-BR-3: same kind outside the suspicion window is not suspected', () => {
    const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
    const second = unwrap(aidEvent('food', 'Other NGO', new Date('2026-07-09T00:00:00Z')));
    expect(isSuspectedDuplicate(second, first, 7)).toBe(false);
  });

  it('FR-BR-3: different kind within the window is not suspected', () => {
    const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
    const second = unwrap(aidEvent('medical', 'Red Cross', new Date('2026-07-02T00:00:00Z')));
    expect(isSuspectedDuplicate(second, first, 7)).toBe(false);
  });
});
