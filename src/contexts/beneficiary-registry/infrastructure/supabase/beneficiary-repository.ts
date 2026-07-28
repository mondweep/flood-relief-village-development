/**
 * Supabase adapter for BeneficiaryRepository (BC-3, ADR-003 schema `beneficiary_registry`).
 *
 * Mapping notes:
 * - `beneficiaries.full_name` is `not null`, but the `Beneficiary` aggregate does not model
 *   a name at all (PRD §5 BC-3 tracks vulnerability categories, not identity fields beyond
 *   villageId). A fixed placeholder is written to satisfy the constraint; `needs` and
 *   `photo_url` are likewise not modelled by the aggregate and are written empty/null.
 * - `aid_events` is append-only (FR-BR-2): `save` inserts only the tail of `aidHistory`
 *   not yet persisted.
 * - `follow_ups` (individual completion records) has no corresponding data on the
 *   aggregate — `Beneficiary` only tracks the *next* follow-up date, not a history of
 *   completions — so this adapter does not populate that table.
 * - `Beneficiary` exposes no public rehydration factory (only `register`, which recomputes
 *   `nextFollowUpAt` from scratch — wrong for an aggregate whose follow-up has since been
 *   advanced). `fromBeneficiaryRow` rebuilds the instance directly via its prototype
 *   instead, without re-running registration/scheduling logic.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type BeneficiaryId, type VillageId } from '../../../../shared/index.js';
import { Beneficiary } from '../../domain/beneficiary.js';
import type { AidEvent } from '../../domain/aid-event.js';
import type { VulnerabilityCategory } from '../../domain/vulnerability-category.js';
import type { BeneficiaryRepository } from '../../application/ports.js';

const SCHEMA = 'beneficiary_registry';
const UNNAMED_BENEFICIARY = 'unnamed beneficiary';

export interface BeneficiaryRow {
  readonly id: string;
  readonly village_id: string;
  readonly full_name: string;
  readonly categories: readonly string[];
  readonly needs: readonly string[];
  readonly photo_url: string | null;
  readonly next_follow_up_at: string | null;
  readonly created_at: string;
}

export interface AidEventRow {
  readonly id: string;
  readonly beneficiary_id: string;
  readonly kind: string;
  readonly provider_name: string;
  readonly note: string | null;
  readonly occurred_at: string;
}

/** Pure mapping: Beneficiary -> its `beneficiaries` row. */
export function toBeneficiaryRow(beneficiary: Beneficiary): BeneficiaryRow {
  return {
    id: beneficiary.id,
    village_id: beneficiary.villageId,
    full_name: UNNAMED_BENEFICIARY,
    categories: beneficiary.categories,
    needs: [],
    photo_url: null,
    next_follow_up_at: beneficiary.nextFollowUpAt ? beneficiary.nextFollowUpAt.toISOString() : null,
    created_at: beneficiary.registeredAt.toISOString(),
  };
}

/** Pure mapping: a single new AidEvent -> its insertable row (a fresh id is generated). */
export function toNewAidEventRow(beneficiaryId: BeneficiaryId, aid: AidEvent): AidEventRow {
  return {
    id: randomUUID(),
    beneficiary_id: beneficiaryId,
    kind: aid.kind,
    provider_name: aid.providerName,
    note: aid.note ?? null,
    occurred_at: aid.at.toISOString(),
  };
}

function fromAidEventRow(row: AidEventRow): AidEvent {
  return {
    kind: row.kind,
    providerName: row.provider_name,
    at: new Date(row.occurred_at),
    ...(row.note !== null ? { note: row.note } : {}),
  };
}

/**
 * Pure mapping: `beneficiaries` row + its ordered aid-history rows -> a `Beneficiary`
 * instance, reconstructed without re-running domain validation (see file header).
 */
export function fromBeneficiaryRow(row: BeneficiaryRow, aidHistoryRows: readonly AidEventRow[]): Beneficiary {
  const props = {
    id: asId<'BeneficiaryId'>(row.id),
    villageId: asId<'VillageId'>(row.village_id),
    categories: row.categories as readonly VulnerabilityCategory[],
    aidHistory: aidHistoryRows.map(fromAidEventRow),
    nextFollowUpAt: row.next_follow_up_at ? new Date(row.next_follow_up_at) : undefined,
    registeredAt: new Date(row.created_at),
  };

  const instance = Object.create(Beneficiary.prototype) as Beneficiary;
  Object.defineProperty(instance, 'props', { value: props, enumerable: false, writable: false, configurable: false });
  return instance;
}

export class SupabaseBeneficiaryRepository implements BeneficiaryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: BeneficiaryId): Promise<Beneficiary | undefined> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('beneficiaries')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`SupabaseBeneficiaryRepository.findById: ${error.message}`);
    if (!data) return undefined;

    const aidHistory = await this.loadAidHistory(id);
    return fromBeneficiaryRow(data as BeneficiaryRow, aidHistory);
  }

  async save(beneficiary: Beneficiary): Promise<void> {
    const { error } = await this.client.schema(SCHEMA).from('beneficiaries').upsert(toBeneficiaryRow(beneficiary));
    if (error) throw new Error(`SupabaseBeneficiaryRepository.save: ${error.message}`);

    const { count, error: countError } = await this.client
      .schema(SCHEMA)
      .from('aid_events')
      .select('id', { count: 'exact', head: true })
      .eq('beneficiary_id', beneficiary.id);
    if (countError) throw new Error(`SupabaseBeneficiaryRepository.save (aid count): ${countError.message}`);

    const persisted = count ?? 0;
    const newAid = beneficiary.aidHistory.slice(persisted);
    if (newAid.length > 0) {
      const rows = newAid.map((aid) => toNewAidEventRow(beneficiary.id, aid));
      const { error: insertError } = await this.client.schema(SCHEMA).from('aid_events').insert(rows);
      if (insertError) throw new Error(`SupabaseBeneficiaryRepository.save (aid insert): ${insertError.message}`);
    }
  }

  async findAllWithScheduledFollowUp(): Promise<readonly Beneficiary[]> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('beneficiaries')
      .select('*')
      .not('next_follow_up_at', 'is', null);
    if (error) throw new Error(`SupabaseBeneficiaryRepository.findAllWithScheduledFollowUp: ${error.message}`);

    const rows = (data ?? []) as BeneficiaryRow[];
    return Promise.all(
      rows.map(async (row) => fromBeneficiaryRow(row, await this.loadAidHistory(asId<'BeneficiaryId'>(row.id)))),
    );
  }

  private async loadAidHistory(id: BeneficiaryId): Promise<readonly AidEventRow[]> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('aid_events')
      .select('*')
      .eq('beneficiary_id', id)
      .order('occurred_at', { ascending: true });
    if (error) throw new Error(`SupabaseBeneficiaryRepository (aid history): ${error.message}`);
    return (data ?? []) as AidEventRow[];
  }
}
