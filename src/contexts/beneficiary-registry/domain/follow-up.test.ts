import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLLOW_UP_INTERVAL_DAYS, isOverdue, scheduleNextFollowUp } from './follow-up.js';

// Pure VO: state-based tests (ADR-004 §5).
describe('FollowUp schedule', () => {
  it('FR-BR-4: widow and orphaned_child always get a next follow-up date', () => {
    const from = new Date('2026-07-01T00:00:00Z');
    const widow = scheduleNextFollowUp(['widow'], from);
    const orphan = scheduleNextFollowUp(['orphaned_child'], from);

    expect(widow).toEqual(new Date(from.getTime() + DEFAULT_FOLLOW_UP_INTERVAL_DAYS * 24 * 60 * 60 * 1000));
    expect(orphan).toBeInstanceOf(Date);
  });

  it('FR-BR-4: other categories alone get no follow-up date', () => {
    expect(scheduleNextFollowUp(['farmer'], new Date())).toBeUndefined();
    expect(scheduleNextFollowUp([], new Date())).toBeUndefined();
  });

  it('FR-BR-4: a configurable interval is honoured', () => {
    const from = new Date('2026-07-01T00:00:00Z');
    const next = scheduleNextFollowUp(['widow'], from, 7);
    expect(next).toEqual(new Date('2026-07-08T00:00:00Z'));
  });

  it('FR-BR-4: a date before now is overdue, a date in the future or undefined is not', () => {
    const now = new Date('2026-07-28T00:00:00Z');
    expect(isOverdue(new Date('2026-07-27T00:00:00Z'), now)).toBe(true);
    expect(isOverdue(new Date('2026-07-29T00:00:00Z'), now)).toBe(false);
    expect(isOverdue(undefined, now)).toBe(false);
  });
});
