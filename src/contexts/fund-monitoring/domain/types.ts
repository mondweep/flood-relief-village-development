/**
 * Fund Monitoring (BC-4) vocabulary — PRD §5 BC-4, §3 glossary.
 * Literal unions double as runtime guards so adapters can validate at the boundary.
 */

export const PROJECT_CATEGORIES = [
  'road',
  'school',
  'housing',
  'water',
  'health',
  'bridge',
  'other',
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

export const FUNDING_SOURCES = ['district', 'csr', 'ngo', 'donor', 'mla', 'mp', 'scheme'] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

export const EVIDENCE_KINDS = [
  'geo_tagged_photo',
  'invoice',
  'completion_certificate',
  'village_verification',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const PROJECT_STATUSES = ['sanctioned', 'in_progress', 'completed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ANOMALY_KINDS = ['delayed', 'duplicate_funding', 'overspend'] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

const isOneOf = <T extends string>(values: readonly T[], raw: string): raw is T =>
  (values as readonly string[]).includes(raw);

export const isProjectCategory = (raw: string): raw is ProjectCategory =>
  isOneOf(PROJECT_CATEGORIES, raw);
export const isFundingSource = (raw: string): raw is FundingSource => isOneOf(FUNDING_SOURCES, raw);
export const isEvidenceKind = (raw: string): raw is EvidenceKind => isOneOf(EVIDENCE_KINDS, raw);

/** Event type names published by this context (PRD §4.3). */
export const FUND_EVENT_TYPES = {
  projectFunded: 'ProjectFunded',
  fundsReleased: 'FundsReleased',
  expenditureRecorded: 'ExpenditureRecorded',
  evidenceAttached: 'EvidenceAttached',
  projectCompleted: 'ProjectCompleted',
  anomalyFlagged: 'AnomalyFlagged',
} as const;
