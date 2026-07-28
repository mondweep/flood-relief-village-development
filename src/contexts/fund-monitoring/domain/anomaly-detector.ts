/**
 * AnomalyDetector (PRD §5 BC-4, FR-FM-4): a pure domain service.
 * Rules: delayed, duplicate funding, comparative overspend. No I/O, no clock —
 * "now" and the comparison sets are supplied by the calling use case.
 */
import type { Money, ProjectId } from '../../../shared/index.js';
import { totalSpent } from './budget-ledger.js';
import type { FundedProject } from './funded-project.js';
import type { AnomalyKind, ProjectCategory } from './types.js';

export interface Anomaly {
  readonly projectId: ProjectId;
  readonly kind: AnomalyKind;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Overspend baseline projection supplied by the ComparableProjectsQuery port. */
export interface ComparableProject {
  readonly projectId: ProjectId;
  readonly category: ProjectCategory;
  readonly spent: Money;
}

export interface AnomalyDetectorConfig {
  readonly overspendMultiplier: number;
}

export const DEFAULT_OVERSPEND_MULTIPLIER = 1.5;
export const DEFAULT_ANOMALY_CONFIG: AnomalyDetectorConfig = {
  overspendMultiplier: DEFAULT_OVERSPEND_MULTIPLIER,
};

export interface AnomalyScan {
  readonly project: FundedProject;
  /** Other funded projects in the same village (may include the project itself). */
  readonly villageProjects: readonly FundedProject[];
  /** Comparable projects of the same category used as the overspend baseline. */
  readonly comparables: readonly ComparableProject[];
  readonly now: Date;
  readonly config: AnomalyDetectorConfig;
}

export interface Period {
  readonly start: Date;
  readonly end: Date;
}

const MS_PER_DAY = 86_400_000;

export const activePeriod = (project: FundedProject): Period => ({
  start: project.sanctionedAt,
  end: project.completedAt ?? project.expectedCompletionAt,
});

export const periodsOverlap = (a: Period, b: Period): boolean =>
  a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime();

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (low === undefined || high === undefined) return undefined;
  return (low + high) / 2;
}

/** (a) Past the expected completion date and not completed. */
function detectDelayed(scan: AnomalyScan): readonly Anomaly[] {
  const { project, now } = scan;
  if (project.status === 'completed') return [];
  if (now.getTime() <= project.expectedCompletionAt.getTime()) return [];

  return [
    {
      projectId: project.id,
      kind: 'delayed',
      details: {
        expectedCompletionAt: project.expectedCompletionAt.toISOString(),
        overdueDays: Math.floor((now.getTime() - project.expectedCompletionAt.getTime()) / MS_PER_DAY),
        status: project.status,
      },
    },
  ];
}

/** (b) Same village + same category with an overlapping active period. */
function detectDuplicateFunding(scan: AnomalyScan): readonly Anomaly[] {
  const { project, villageProjects } = scan;
  const period = activePeriod(project);

  return villageProjects
    .filter(
      (other) =>
        other.id !== project.id &&
        other.villageId === project.villageId &&
        other.category === project.category &&
        periodsOverlap(period, activePeriod(other)),
    )
    .map((other) => ({
      projectId: project.id,
      kind: 'duplicate_funding' as const,
      details: {
        villageId: project.villageId,
        category: project.category,
        otherProjectId: other.id,
        otherFundingSource: other.fundingSource,
        otherSanctionedAt: other.sanctionedAt.toISOString(),
      },
    }));
}

/** (c) Spend above multiplier x the median spend of comparable projects. */
function detectOverspend(scan: AnomalyScan): readonly Anomaly[] {
  const { project, comparables, config } = scan;
  const spent = totalSpent(project.ledger);

  const baseline = comparables
    .filter((c) => c.projectId !== project.id && c.spent.currency === spent.currency)
    .map((c) => c.spent.amountMinor);

  const medianSpentMinor = median(baseline);
  // Guard: no comparables (or an all-zero baseline) means no defensible judgement.
  if (medianSpentMinor === undefined || medianSpentMinor <= 0) return [];

  const thresholdMinor = medianSpentMinor * config.overspendMultiplier;
  if (spent.amountMinor <= thresholdMinor) return [];

  return [
    {
      projectId: project.id,
      kind: 'overspend',
      details: {
        spentMinor: spent.amountMinor,
        currency: spent.currency,
        medianSpentMinor,
        multiplier: config.overspendMultiplier,
        thresholdMinor,
        comparableCount: baseline.length,
      },
    },
  ];
}

/** FR-FM-4: all rules, evaluated in a stable order. */
export function detectAnomalies(scan: AnomalyScan): readonly Anomaly[] {
  return [...detectDelayed(scan), ...detectDuplicateFunding(scan), ...detectOverspend(scan)];
}
