import { type Result, ok, err } from '../../../shared/index.js';

/**
 * BC-6 Issue Tracking — IssueStatus state machine (PRD §5 BC-6, FR-IT-3).
 * reported → routed → in_progress → resolved | rejected. No skipping.
 */
export type IssueStatus = 'reported' | 'routed' | 'in_progress' | 'resolved' | 'rejected';

const ALLOWED_TRANSITIONS: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  reported: ['routed'],
  routed: ['in_progress'],
  in_progress: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(from: IssueStatus, to: IssueStatus): Result<IssueStatus> {
  if (!canTransition(from, to)) {
    return err('INVALID_STATUS_TRANSITION', `cannot transition issue from '${from}' to '${to}'`);
  }
  return ok(to);
}
