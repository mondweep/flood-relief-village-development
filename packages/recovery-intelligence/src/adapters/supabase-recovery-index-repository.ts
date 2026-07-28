import type { SupabaseClient } from "@supabase/supabase-js";
import { AFRIP_SCHEMA, villageId, type VillageId } from "@afrip/shared-kernel";
import type { DimensionScores } from "../domain/dimensions.js";
import { RecoveryIndex, type ScoreHistoryEntry } from "../domain/recovery-index.js";
import type { RecoveryIndexRepository } from "../application/ports.js";

/** Tables owned by the recovery-intelligence context (see 00001_initial_schema.sql). */
export const INDICES_TABLE = "recovery_intelligence_indices";
export const HISTORY_TABLE = "recovery_intelligence_history";

/** Row shape of `recovery_intelligence_indices` (`village_id` is the primary key). */
export interface RecoveryIndexRow {
  village_id: string;
  scores: DimensionScores;
  composite: number;
  calculated_at: string;
}

/** Row shape of `recovery_intelligence_history` (identity `id` is DB-assigned). */
export interface ScoreHistoryRow {
  village_id: string;
  composite: number;
  calculated_at: string;
}

function failed(table: string, operation: string, error: { message?: string } | null): void {
  if (error) {
    throw new Error(
      `supabase ${operation} on ${table} failed: ${error.message ?? "unknown error"}`,
    );
  }
}

function corrupt(table: string, id: string, reason: string): Error {
  return new Error(`corrupt row in ${table} (village_id=${id}): ${reason}`);
}

/**
 * `recovery_intelligence_indices.calculated_at` is NOT NULL, so an index that
 * has never been scored has nothing to persist — that is a programming error,
 * not a storage error, and is surfaced as such.
 */
export function toRow(index: RecoveryIndex): RecoveryIndexRow {
  const calculatedAt = index.calculatedAt;
  if (calculatedAt === null) {
    throw new Error(
      `cannot persist a RecoveryIndex that has never been calculated to ${INDICES_TABLE} (village_id=${index.villageId})`,
    );
  }
  return {
    village_id: index.villageId,
    scores: index.scores,
    composite: index.composite,
    calculated_at: calculatedAt,
  };
}

export function toHistoryRows(index: RecoveryIndex): ScoreHistoryRow[] {
  return index.history.map((entry) => ({
    village_id: index.villageId,
    composite: entry.composite,
    calculated_at: entry.calculatedAt,
  }));
}

/**
 * Rebuilds a RecoveryIndex from its row plus its history rows, oldest first.
 * Uses RecoveryIndex.restore because the append-only history was computed under
 * the weights in force at the time and must not be recomputed. Any invariant
 * failure throws.
 */
export function fromRow(
  row: RecoveryIndexRow,
  historyRows: readonly ScoreHistoryRow[],
): RecoveryIndex {
  const village = villageId(row.village_id);
  if (!village.ok) throw corrupt(INDICES_TABLE, String(row.village_id), village.error);

  if (row.scores === null || typeof row.scores !== "object") {
    throw corrupt(INDICES_TABLE, row.village_id, "scores must be a JSON object");
  }

  const history: ScoreHistoryEntry[] = historyRows.map((entry) => ({
    composite: entry.composite,
    calculatedAt: entry.calculated_at,
  }));

  const restored = RecoveryIndex.restore({
    villageId: village.value,
    scores: { ...row.scores },
    composite: row.composite,
    calculatedAt: row.calculated_at,
    history,
  });
  if (!restored.ok) throw corrupt(INDICES_TABLE, row.village_id, restored.error);
  return restored.value;
}

/** Supabase/Postgres adapter for RecoveryIndexRepository (ADR 0004). */
export class SupabaseRecoveryIndexRepository implements RecoveryIndexRepository {
  /**
   * @param schema Postgres schema holding the AFRIP tables. Defaults to
   * AFRIP_SCHEMA rather than the client's own default, which is `public` — a
   * schema owned by other applications in this shared project.
   */
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string = AFRIP_SCHEMA,
  ) {}

  /** Every query goes through here, so no call can forget the schema. */
  private table(name: string) {
    return this.client.schema(this.schema).from(name);
  }

  async findByVillage(village: VillageId): Promise<RecoveryIndex | null> {
    const index = await this.table(INDICES_TABLE)
      .select("*")
      .eq("village_id", village)
      .maybeSingle();
    failed(INDICES_TABLE, "select", index.error);
    if (!index.data) return null;

    const history = await this.table(HISTORY_TABLE)
      .select("*")
      .eq("village_id", village)
      .order("id", { ascending: true });
    failed(HISTORY_TABLE, "select", history.error);

    return fromRow(index.data as RecoveryIndexRow, (history.data ?? []) as ScoreHistoryRow[]);
  }

  async save(index: RecoveryIndex): Promise<void> {
    const upserted = await this.table(INDICES_TABLE).upsert(toRow(index));
    failed(INDICES_TABLE, "upsert", upserted.error);

    // History rows carry a DB-assigned identity key, so the append-only log is
    // reconciled wholesale: clear then re-insert in aggregate order.
    const cleared = await this.table(HISTORY_TABLE).delete().eq("village_id", index.villageId);
    failed(HISTORY_TABLE, "delete", cleared.error);

    const rows = toHistoryRows(index);
    if (rows.length > 0) {
      const inserted = await this.table(HISTORY_TABLE).insert(rows);
      failed(HISTORY_TABLE, "insert", inserted.error);
    }
  }
}
