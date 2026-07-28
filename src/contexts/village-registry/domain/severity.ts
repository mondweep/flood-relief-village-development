import { type Result, ok, err } from '../../../shared/index.js';

/** Severity value object (FR-VR-3). */
export type Severity = 'unaffected' | 'low' | 'moderate' | 'severe' | 'critical';

const SEVERITIES: readonly Severity[] = ['unaffected', 'low', 'moderate', 'severe', 'critical'];

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

/** Append-only audit entry recorded on every severity transition (FR-VR-3). */
export interface SeverityChangeRecord {
  readonly from: Severity;
  readonly to: Severity;
  readonly reason: string;
  readonly at: Date;
}

export function severityChangeRecord(
  from: Severity,
  to: string,
  reason: string,
  at: Date,
): Result<SeverityChangeRecord> {
  if (!isSeverity(to)) return err('SEVERITY_INVALID', `invalid severity: ${to}`);
  if (reason.trim().length === 0) return err('SEVERITY_REASON_REQUIRED', 'reason is required for a severity change');
  return ok({ from, to, reason, at });
}
