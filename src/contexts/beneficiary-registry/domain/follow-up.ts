import type { VulnerabilityCategory } from './vulnerability-category.js';
import { requiresMandatoryFollowUp } from './vulnerability-category.js';

/** FR-BR-4: default interval, in days, between scheduled follow-ups for mandatory categories. */
export const DEFAULT_FOLLOW_UP_INTERVAL_DAYS = 30;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * VO: FollowUp schedule (PRD §5 BC-3, FR-BR-4).
 * Beneficiaries in a mandatory category ('widow', 'orphaned_child') must always carry a
 * next follow-up date; every other beneficiary has none by default.
 */
export function scheduleNextFollowUp(
  categories: readonly VulnerabilityCategory[],
  from: Date,
  intervalDays: number = DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
): Date | undefined {
  return requiresMandatoryFollowUp(categories) ? addDays(from, intervalDays) : undefined;
}

export function isOverdue(nextFollowUpAt: Date | undefined, now: Date): boolean {
  return nextFollowUpAt !== undefined && nextFollowUpAt.getTime() < now.getTime();
}
