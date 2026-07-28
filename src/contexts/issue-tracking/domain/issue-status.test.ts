import { describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { canTransition, transition } from './issue-status.js';

// FR-IT-3: reported → routed → in_progress → resolved | rejected, no skipping.
// State-based tests: pure domain state machine (ADR-004 §5).
describe('IssueStatus state machine', () => {
  it('FR-IT-3 allows the full forward sequence: reported → routed → in_progress → resolved', () => {
    expect(unwrap(transition('reported', 'routed'))).toBe('routed');
    expect(unwrap(transition('routed', 'in_progress'))).toBe('in_progress');
    expect(unwrap(transition('in_progress', 'resolved'))).toBe('resolved');
  });

  it('FR-IT-3 allows in_progress → rejected', () => {
    expect(unwrap(transition('in_progress', 'rejected'))).toBe('rejected');
  });

  it('FR-IT-3 rejects skipping straight from reported to resolved', () => {
    const result = transition('reported', 'resolved');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(canTransition('reported', 'resolved')).toBe(false);
  });

  it('FR-IT-3 rejects skipping from reported straight to in_progress', () => {
    expect(canTransition('reported', 'in_progress')).toBe(false);
  });

  it('FR-IT-3 rejects any transition out of terminal states resolved and rejected', () => {
    expect(canTransition('resolved', 'in_progress')).toBe(false);
    expect(canTransition('rejected', 'in_progress')).toBe(false);
  });
});
