/**
 * Supabase adapter for ProjectRepository (BC-4, ADR-003 schema `fund_monitoring`).
 *
 * Mapping notes:
 * - `funded_projects.status` only allows `('active','completed')`, but the domain has
 *   three states (`sanctioned` | `in_progress` | `completed`). Both pre-completion states
 *   map to `'active'` on write; on read, `'active'` is refined back to `sanctioned` /
 *   `in_progress` by checking whether any releases have been recorded yet.
 * - `evidence_items.kind` allows `('photo', ...)`, but the domain's `EvidenceKind` uses
 *   `'geo_tagged_photo'` — mapped both ways via a small lookup table.
 * - `evidence_items` has no attribution column, so `EvidenceItem.attachedBy` cannot be
 *   persisted; it round-trips as an empty string on read (write is a no-op for that field).
 * - `ledger_entries` (releases + expenditures) and `evidence_items` are both append-only
 *   (FR-FM-2/3): `save` inserts only the tail beyond what is already persisted.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type Money, type ProjectId, type VillageId } from '../../../../shared/index.js';
import type { BudgetLedger, ExpenditureEntry, ReleaseEntry } from '../../domain/budget-ledger.js';
import { totalReleased, totalSpent } from '../../domain/budget-ledger.js';
import type { EvidenceItem } from '../../domain/evidence.js';
import type { FundedProject } from '../../domain/funded-project.js';
import type { EvidenceKind, FundingSource, ProjectCategory, ProjectStatus } from '../../domain/types.js';
import type { ProjectRepository } from '../../application/ports.js';

const SCHEMA = 'fund_monitoring';

export interface ProjectRow {
  readonly id: string;
  readonly village_id: string;
  readonly title: string;
  readonly category: string;
  readonly funding_source: string;
  readonly currency: string;
  readonly sanctioned_minor: number;
  readonly released_minor: number;
  readonly spent_minor: number;
  readonly status: string;
  readonly started_at: string;
  readonly expected_completion_at: string;
  readonly completed_at: string | null;
}

export interface LedgerEntryRow {
  readonly id: string;
  readonly project_id: string;
  readonly entry_type: 'release' | 'expenditure';
  readonly amount_minor: number;
  readonly description: string | null;
  readonly occurred_at: string;
}

export interface EvidenceRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly url: string;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly attached_at: string;
}

const DB_EVIDENCE_KIND: Readonly<Record<EvidenceKind, string>> = {
  geo_tagged_photo: 'photo',
  invoice: 'invoice',
  completion_certificate: 'completion_certificate',
  village_verification: 'village_verification',
};
const DOMAIN_EVIDENCE_KIND: Readonly<Record<string, EvidenceKind>> = {
  photo: 'geo_tagged_photo',
  invoice: 'invoice',
  completion_certificate: 'completion_certificate',
  village_verification: 'village_verification',
};

/** Pure mapping: FundedProject -> its `funded_projects` row. */
export function toProjectRow(project: FundedProject): ProjectRow {
  const released = totalReleased(project.ledger);
  const spent = totalSpent(project.ledger);
  return {
    id: project.id,
    village_id: project.villageId,
    title: project.title,
    category: project.category,
    funding_source: project.fundingSource,
    currency: project.ledger.sanctioned.currency,
    sanctioned_minor: project.ledger.sanctioned.amountMinor,
    released_minor: released.amountMinor,
    spent_minor: spent.amountMinor,
    status: project.status === 'completed' ? 'completed' : 'active',
    started_at: project.sanctionedAt.toISOString(),
    expected_completion_at: project.expectedCompletionAt.toISOString(),
    completed_at: project.completedAt ? project.completedAt.toISOString() : null,
  };
}

/** Pure mapping: the tail of new ledger entries (releases/expenditures) -> insertable rows. */
export function toNewLedgerEntryRows(
  project: FundedProject,
  persistedReleaseCount: number,
  persistedExpenditureCount: number,
): readonly LedgerEntryRow[] {
  const releaseRows: LedgerEntryRow[] = project.ledger.releases.slice(persistedReleaseCount).map((r) => ({
    id: randomUUID(),
    project_id: project.id,
    entry_type: 'release',
    amount_minor: r.amount.amountMinor,
    description: null,
    occurred_at: r.at.toISOString(),
  }));
  const expenditureRows: LedgerEntryRow[] = project.ledger.expenditures
    .slice(persistedExpenditureCount)
    .map((e) => ({
      id: randomUUID(),
      project_id: project.id,
      entry_type: 'expenditure',
      amount_minor: e.amount.amountMinor,
      description: e.description,
      occurred_at: e.at.toISOString(),
    }));
  return [...releaseRows, ...expenditureRows];
}

/** Pure mapping: a single new EvidenceItem -> its insertable row. */
export function toNewEvidenceRow(project: FundedProject, item: EvidenceItem): EvidenceRow {
  return {
    id: randomUUID(),
    project_id: project.id,
    kind: DB_EVIDENCE_KIND[item.kind],
    url: item.uri,
    lat: item.location ? item.location.lat : null,
    lng: item.location ? item.location.lng : null,
    attached_at: item.attachedAt.toISOString(),
  };
}

/** Pure mapping: row + its ledger/evidence rows -> the FundedProject aggregate. */
export function fromProjectRow(
  row: ProjectRow,
  ledgerRows: readonly LedgerEntryRow[],
  evidenceRows: readonly EvidenceRow[],
): FundedProject {
  const currency = row.currency;
  const releases: ReleaseEntry[] = ledgerRows
    .filter((r) => r.entry_type === 'release')
    .map((r) => ({ amount: { amountMinor: r.amount_minor, currency }, at: new Date(r.occurred_at) }));
  const expenditures: ExpenditureEntry[] = ledgerRows
    .filter((r) => r.entry_type === 'expenditure')
    .map((r) => ({
      amount: { amountMinor: r.amount_minor, currency },
      at: new Date(r.occurred_at),
      description: r.description ?? '',
    }));

  const ledger: BudgetLedger = {
    sanctioned: { amountMinor: row.sanctioned_minor, currency } as Money,
    releases,
    expenditures,
  };

  const evidence: EvidenceItem[] = evidenceRows.map((e) => ({
    kind: DOMAIN_EVIDENCE_KIND[e.kind] ?? (e.kind as EvidenceKind),
    uri: e.url,
    attachedBy: '',
    attachedAt: new Date(e.attached_at),
    ...(e.lat !== null && e.lng !== null ? { location: { lat: e.lat, lng: e.lng } } : {}),
  }));

  const status: ProjectStatus =
    row.status === 'completed' ? 'completed' : releases.length > 0 ? 'in_progress' : 'sanctioned';

  return {
    id: asId<'ProjectId'>(row.id),
    villageId: asId<'VillageId'>(row.village_id),
    title: row.title,
    category: row.category as ProjectCategory,
    fundingSource: row.funding_source as FundingSource,
    ledger,
    evidence,
    sanctionedAt: new Date(row.started_at),
    expectedCompletionAt: new Date(row.expected_completion_at),
    status,
    ...(row.completed_at ? { completedAt: new Date(row.completed_at) } : {}),
  };
}

export class SupabaseProjectRepository implements ProjectRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: ProjectId): Promise<FundedProject | null> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('funded_projects')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`SupabaseProjectRepository.findById: ${error.message}`);
    if (!data) return null;

    const [ledgerRows, evidenceRows] = await Promise.all([this.loadLedger(id), this.loadEvidence(id)]);
    return fromProjectRow(data as ProjectRow, ledgerRows, evidenceRows);
  }

  async findByVillage(villageId: VillageId): Promise<readonly FundedProject[]> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('funded_projects')
      .select('*')
      .eq('village_id', villageId);
    if (error) throw new Error(`SupabaseProjectRepository.findByVillage: ${error.message}`);

    const rows = (data ?? []) as ProjectRow[];
    return Promise.all(
      rows.map(async (row) => {
        const id = asId<'ProjectId'>(row.id);
        const [ledgerRows, evidenceRows] = await Promise.all([this.loadLedger(id), this.loadEvidence(id)]);
        return fromProjectRow(row, ledgerRows, evidenceRows);
      }),
    );
  }

  async save(project: FundedProject): Promise<void> {
    const { error } = await this.client.schema(SCHEMA).from('funded_projects').upsert(toProjectRow(project));
    if (error) throw new Error(`SupabaseProjectRepository.save: ${error.message}`);

    const existingLedger = await this.loadLedger(project.id);
    const releaseCount = existingLedger.filter((r) => r.entry_type === 'release').length;
    const expenditureCount = existingLedger.filter((r) => r.entry_type === 'expenditure').length;
    const newLedgerRows = toNewLedgerEntryRows(project, releaseCount, expenditureCount);
    if (newLedgerRows.length > 0) {
      const { error: ledgerError } = await this.client.schema(SCHEMA).from('ledger_entries').insert(newLedgerRows);
      if (ledgerError) throw new Error(`SupabaseProjectRepository.save (ledger insert): ${ledgerError.message}`);
    }

    const { count, error: countError } = await this.client
      .schema(SCHEMA)
      .from('evidence_items')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', project.id);
    if (countError) throw new Error(`SupabaseProjectRepository.save (evidence count): ${countError.message}`);

    const persistedEvidence = count ?? 0;
    const newEvidence = project.evidence.slice(persistedEvidence).map((item) => toNewEvidenceRow(project, item));
    if (newEvidence.length > 0) {
      const { error: evidenceError } = await this.client.schema(SCHEMA).from('evidence_items').insert(newEvidence);
      if (evidenceError) throw new Error(`SupabaseProjectRepository.save (evidence insert): ${evidenceError.message}`);
    }
  }

  private async loadLedger(id: ProjectId): Promise<readonly LedgerEntryRow[]> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('ledger_entries')
      .select('*')
      .eq('project_id', id)
      .order('occurred_at', { ascending: true });
    if (error) throw new Error(`SupabaseProjectRepository (ledger): ${error.message}`);
    return (data ?? []) as LedgerEntryRow[];
  }

  private async loadEvidence(id: ProjectId): Promise<readonly EvidenceRow[]> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('evidence_items')
      .select('*')
      .eq('project_id', id)
      .order('attached_at', { ascending: true });
    if (error) throw new Error(`SupabaseProjectRepository (evidence): ${error.message}`);
    return (data ?? []) as EvidenceRow[];
  }
}
