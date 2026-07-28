import type { SupabaseClient } from "@supabase/supabase-js";
import { beneficiaryId, villageId, type BeneficiaryId, type VillageId } from "@afrip/shared-kernel";
import {
  Beneficiary,
  type AidRecord,
  type AidType,
  type BeneficiaryCategory,
  type DuplicateFlag,
  type FollowUp,
  type ProviderType,
} from "../domain/beneficiary.js";
import type { BeneficiaryRepository } from "../application/ports.js";

/** Tables owned by the beneficiary-registry context (see 00001_initial_schema.sql). */
export const BENEFICIARIES_TABLE = "beneficiary_registry_beneficiaries";
export const AID_RECORDS_TABLE = "beneficiary_registry_aid_records";
export const FOLLOW_UPS_TABLE = "beneficiary_registry_follow_ups";
export const DUPLICATE_FLAGS_TABLE = "beneficiary_registry_duplicate_flags";

/** Row shape of `beneficiary_registry_beneficiaries`. */
export interface BeneficiaryRow {
  id: string;
  village_id: string;
  name: string;
  category: string;
}

/** Row shape of `beneficiary_registry_aid_records` (identity `id` is DB-assigned). */
export interface AidRecordRow {
  beneficiary_id: string;
  aid_type: string;
  provider_id: string;
  provider_type: string;
  delivered_at: string;
  notes: string | null;
}

/** Row shape of `beneficiary_registry_follow_ups` (PK is `(beneficiary_id, id)`). */
export interface FollowUpRow {
  id: string;
  beneficiary_id: string;
  due_at: string;
  completed_at: string | null;
}

/** Row shape of `beneficiary_registry_duplicate_flags` (identity `id` is DB-assigned). */
export interface DuplicateFlagRow {
  beneficiary_id: string;
  aid_type: string;
  provider_ids: string[];
  flagged_at: string;
}

/** Every child row set belonging to one beneficiary, in aggregate order. */
export interface BeneficiaryChildRows {
  aidRecords: readonly AidRecordRow[];
  followUps: readonly FollowUpRow[];
  duplicateFlags: readonly DuplicateFlagRow[];
}

function failed(table: string, operation: string, error: { message?: string } | null): void {
  if (error) {
    throw new Error(
      `supabase ${operation} on ${table} failed: ${error.message ?? "unknown error"}`,
    );
  }
}

function corrupt(table: string, id: string, reason: string): Error {
  return new Error(`corrupt row in ${table} (id=${id}): ${reason}`);
}

export function toRow(beneficiary: Beneficiary): BeneficiaryRow {
  return {
    id: beneficiary.id,
    village_id: beneficiary.villageId,
    name: beneficiary.name,
    category: beneficiary.category,
  };
}

export function toAidRecordRows(beneficiary: Beneficiary): AidRecordRow[] {
  return beneficiary.aidRecords.map((record) => ({
    beneficiary_id: beneficiary.id,
    aid_type: record.aidType,
    provider_id: record.providerId,
    provider_type: record.providerType,
    delivered_at: record.deliveredAt,
    notes: record.notes ?? null,
  }));
}

export function toFollowUpRows(beneficiary: Beneficiary): FollowUpRow[] {
  return beneficiary.followUps.map((followUp) => ({
    id: followUp.id,
    beneficiary_id: beneficiary.id,
    due_at: followUp.dueAt,
    completed_at: followUp.completedAt ?? null,
  }));
}

export function toDuplicateFlagRows(beneficiary: Beneficiary): DuplicateFlagRow[] {
  return beneficiary.duplicateFlags.map((flag) => ({
    beneficiary_id: beneficiary.id,
    aid_type: flag.aidType,
    provider_ids: [...flag.providerIds],
    flagged_at: flag.flaggedAt,
  }));
}

function toAidRecord(row: AidRecordRow): AidRecord {
  return {
    aidType: row.aid_type as AidType,
    providerId: row.provider_id,
    providerType: row.provider_type as ProviderType,
    deliveredAt: row.delivered_at,
    ...(row.notes === null || row.notes === undefined ? {} : { notes: row.notes }),
  };
}

function toFollowUp(row: FollowUpRow): FollowUp {
  return {
    id: row.id,
    dueAt: row.due_at,
    ...(row.completed_at === null || row.completed_at === undefined
      ? {}
      : { completedAt: row.completed_at }),
  };
}

function toDuplicateFlag(row: DuplicateFlagRow): DuplicateFlag {
  return {
    aidType: row.aid_type as AidType,
    providerIds: [...(row.provider_ids ?? [])],
    flaggedAt: row.flagged_at,
  };
}

/**
 * Rebuilds a Beneficiary from its row plus its child rows. Uses
 * Beneficiary.restore because replaying recordAid() would re-derive duplicate
 * flags instead of honouring the stored ones. Any invariant failure throws.
 */
export function fromRow(row: BeneficiaryRow, children: BeneficiaryChildRows): Beneficiary {
  const id = beneficiaryId(row.id);
  if (!id.ok) throw corrupt(BENEFICIARIES_TABLE, String(row.id), id.error);
  const village = villageId(row.village_id);
  if (!village.ok) throw corrupt(BENEFICIARIES_TABLE, row.id, village.error);

  const restored = Beneficiary.restore({
    id: id.value,
    villageId: village.value,
    name: row.name,
    category: row.category as BeneficiaryCategory,
    aidRecords: children.aidRecords.map(toAidRecord),
    followUps: children.followUps.map(toFollowUp),
    duplicateFlags: children.duplicateFlags.map(toDuplicateFlag),
  });
  if (!restored.ok) throw corrupt(BENEFICIARIES_TABLE, row.id, restored.error);
  return restored.value;
}

/** Supabase/Postgres adapter for BeneficiaryRepository (ADR 0004). */
export class SupabaseBeneficiaryRepository implements BeneficiaryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: BeneficiaryId): Promise<Beneficiary | null> {
    const result = await this.client
      .from(BENEFICIARIES_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    failed(BENEFICIARIES_TABLE, "select", result.error);
    if (!result.data) return null;

    const row = result.data as BeneficiaryRow;
    const children = await this.childRowsFor([row.id]);
    return fromRow(row, childrenOf(children, row.id));
  }

  async listByVillage(village: VillageId): Promise<Beneficiary[]> {
    const result = await this.client
      .from(BENEFICIARIES_TABLE)
      .select("*")
      .eq("village_id", village)
      .order("id", { ascending: true });
    failed(BENEFICIARIES_TABLE, "select", result.error);
    return this.hydrate((result.data ?? []) as BeneficiaryRow[]);
  }

  async listAll(): Promise<Beneficiary[]> {
    const result = await this.client
      .from(BENEFICIARIES_TABLE)
      .select("*")
      .order("id", { ascending: true });
    failed(BENEFICIARIES_TABLE, "select", result.error);
    return this.hydrate((result.data ?? []) as BeneficiaryRow[]);
  }

  async save(beneficiary: Beneficiary): Promise<void> {
    const upserted = await this.client.from(BENEFICIARIES_TABLE).upsert(toRow(beneficiary));
    failed(BENEFICIARIES_TABLE, "upsert", upserted.error);

    // Aid records, follow-ups and duplicate flags are append-only collections
    // keyed by DB identity, so each child set is reconciled wholesale.
    await this.replaceChildren(AID_RECORDS_TABLE, beneficiary.id, toAidRecordRows(beneficiary));
    await this.replaceChildren(FOLLOW_UPS_TABLE, beneficiary.id, toFollowUpRows(beneficiary));
    await this.replaceChildren(
      DUPLICATE_FLAGS_TABLE,
      beneficiary.id,
      toDuplicateFlagRows(beneficiary),
    );
  }

  private async replaceChildren(
    table: string,
    id: BeneficiaryId,
    rows: readonly object[],
  ): Promise<void> {
    const cleared = await this.client.from(table).delete().eq("beneficiary_id", id);
    failed(table, "delete", cleared.error);
    if (rows.length === 0) return;
    const inserted = await this.client.from(table).insert([...rows]);
    failed(table, "insert", inserted.error);
  }

  private async hydrate(rows: readonly BeneficiaryRow[]): Promise<Beneficiary[]> {
    if (rows.length === 0) return [];
    const children = await this.childRowsFor(rows.map((row) => row.id));
    return rows.map((row) => fromRow(row, childrenOf(children, row.id)));
  }

  private async childRowsFor(ids: readonly string[]): Promise<ChildIndex> {
    const [aidRecords, followUps, duplicateFlags] = await Promise.all([
      this.selectChildren<AidRecordRow>(AID_RECORDS_TABLE, ids, ["id"]),
      // Follow-ups have no identity column (PK is `(beneficiary_id, id)`), so
      // `id` breaks ties on equal due dates and keeps reads deterministic.
      this.selectChildren<FollowUpRow>(FOLLOW_UPS_TABLE, ids, ["due_at", "id"]),
      this.selectChildren<DuplicateFlagRow>(DUPLICATE_FLAGS_TABLE, ids, ["id"]),
    ]);
    return {
      aidRecords: groupByBeneficiary(aidRecords),
      followUps: groupByBeneficiary(followUps),
      duplicateFlags: groupByBeneficiary(duplicateFlags),
    };
  }

  private async selectChildren<T>(
    table: string,
    ids: readonly string[],
    orderBy: readonly string[],
  ): Promise<T[]> {
    let query = this.client.from(table).select("*").in("beneficiary_id", [...ids]);
    for (const column of orderBy) query = query.order(column, { ascending: true });
    const result = await query;
    failed(table, "select", result.error);
    return (result.data ?? []) as T[];
  }
}

interface ChildIndex {
  aidRecords: Map<string, AidRecordRow[]>;
  followUps: Map<string, FollowUpRow[]>;
  duplicateFlags: Map<string, DuplicateFlagRow[]>;
}

function groupByBeneficiary<T extends { beneficiary_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.beneficiary_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.beneficiary_id, [row]);
  }
  return grouped;
}

function childrenOf(index: ChildIndex, id: string): BeneficiaryChildRows {
  return {
    aidRecords: index.aidRecords.get(id) ?? [],
    followUps: index.followUps.get(id) ?? [],
    duplicateFlags: index.duplicateFlags.get(id) ?? [],
  };
}
