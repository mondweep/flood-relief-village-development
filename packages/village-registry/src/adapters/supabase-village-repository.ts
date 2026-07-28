import type { SupabaseClient } from "@supabase/supabase-js";
import { AFRIP_SCHEMA, villageId, type VillageId } from "@afrip/shared-kernel";
import {
  Village,
  type DamageAssessment,
  type Severity,
  type VillageCreateProps,
} from "../domain/village.js";
import type { VillageRepository } from "../application/ports.js";

/** Tables owned by the village-registry context (see 00001_initial_schema.sql). */
export const VILLAGES_TABLE = "village_registry_villages";
export const DAMAGE_ASSESSMENTS_TABLE = "village_registry_damage_assessments";

/** Row shape of `village_registry_villages`. */
export interface VillageRow {
  id: string;
  name: string;
  district: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
  households: number;
  affected_families: number;
  severity: string;
}

/** Row shape of `village_registry_damage_assessments` (identity `id` is DB-assigned). */
export interface DamageAssessmentRow {
  village_id: string;
  assessed_at: string;
  houses_damaged: number;
  schools_damaged: number;
  health_centres_damaged: number;
  water_sources_damaged: number;
  agriculture_hectares_lost: number;
  livestock_lost: number;
  notes: string | null;
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

export function toRow(village: Village): VillageRow {
  return {
    id: village.id,
    name: village.name,
    district: village.district,
    state: village.state,
    lat: village.geo.lat,
    lng: village.geo.lng,
    population: village.population,
    households: village.households,
    affected_families: village.affectedFamilies,
    severity: village.severity,
  };
}

export function toDamageAssessmentRows(village: Village): DamageAssessmentRow[] {
  return village.damageAssessments.map((assessment) => ({
    village_id: village.id,
    assessed_at: assessment.assessedAt,
    houses_damaged: assessment.housesDamaged,
    schools_damaged: assessment.schoolsDamaged,
    health_centres_damaged: assessment.healthCentresDamaged,
    water_sources_damaged: assessment.waterSourcesDamaged,
    agriculture_hectares_lost: assessment.agricultureHectaresLost,
    livestock_lost: assessment.livestockLost,
    notes: assessment.notes ?? null,
  }));
}

function toDamageAssessment(row: DamageAssessmentRow): DamageAssessment {
  return {
    assessedAt: row.assessed_at,
    housesDamaged: row.houses_damaged,
    schoolsDamaged: row.schools_damaged,
    healthCentresDamaged: row.health_centres_damaged,
    waterSourcesDamaged: row.water_sources_damaged,
    agricultureHectaresLost: Number(row.agriculture_hectares_lost),
    livestockLost: row.livestock_lost,
    ...(row.notes === null || row.notes === undefined ? {} : { notes: row.notes }),
  };
}

/**
 * Rebuilds a Village from its row plus its damage-assessment rows, oldest
 * first. Every factory failure throws — a half-built aggregate is never
 * returned to the application.
 */
export function fromRow(row: VillageRow, assessmentRows: readonly DamageAssessmentRow[]): Village {
  const id = villageId(row.id);
  if (!id.ok) throw corrupt(VILLAGES_TABLE, String(row.id), id.error);

  const props: VillageCreateProps = {
    id: id.value,
    name: row.name,
    district: row.district,
    state: row.state,
    geo: { lat: row.lat, lng: row.lng },
    population: row.population,
    households: row.households,
    affectedFamilies: row.affected_families,
    severity: row.severity as Severity,
  };

  const created = Village.create(props);
  if (!created.ok) throw corrupt(VILLAGES_TABLE, row.id, created.error);
  const village = created.value;

  for (const assessmentRow of assessmentRows) {
    const recorded = village.recordDamageAssessment(toDamageAssessment(assessmentRow));
    if (!recorded.ok) throw corrupt(DAMAGE_ASSESSMENTS_TABLE, row.id, recorded.error);
  }

  return village;
}

/** Supabase/Postgres adapter for VillageRepository (ADR 0004). */
export class SupabaseVillageRepository implements VillageRepository {
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

  async findById(id: VillageId): Promise<Village | null> {
    const village = await this.table(VILLAGES_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    failed(VILLAGES_TABLE, "select", village.error);
    if (!village.data) return null;

    const assessments = await this.table(DAMAGE_ASSESSMENTS_TABLE)
      .select("*")
      .eq("village_id", id)
      .order("id", { ascending: true });
    failed(DAMAGE_ASSESSMENTS_TABLE, "select", assessments.error);

    return fromRow(village.data as VillageRow, (assessments.data ?? []) as DamageAssessmentRow[]);
  }

  async save(village: Village): Promise<void> {
    const upserted = await this.table(VILLAGES_TABLE).upsert(toRow(village));
    failed(VILLAGES_TABLE, "upsert", upserted.error);

    // Damage assessments carry a DB-assigned identity key, so the child set is
    // reconciled wholesale: clear then re-insert in aggregate order.
    const cleared = await this.table(DAMAGE_ASSESSMENTS_TABLE)
      .delete()
      .eq("village_id", village.id);
    failed(DAMAGE_ASSESSMENTS_TABLE, "delete", cleared.error);

    const rows = toDamageAssessmentRows(village);
    if (rows.length > 0) {
      const inserted = await this.table(DAMAGE_ASSESSMENTS_TABLE).insert(rows);
      failed(DAMAGE_ASSESSMENTS_TABLE, "insert", inserted.error);
    }
  }

  async listAll(): Promise<Village[]> {
    const villages = await this.table(VILLAGES_TABLE)
      .select("*")
      .order("id", { ascending: true });
    failed(VILLAGES_TABLE, "select", villages.error);
    const villageRows = (villages.data ?? []) as VillageRow[];
    if (villageRows.length === 0) return [];

    const assessments = await this.table(DAMAGE_ASSESSMENTS_TABLE)
      .select("*")
      .in(
        "village_id",
        villageRows.map((row) => row.id),
      )
      .order("id", { ascending: true });
    failed(DAMAGE_ASSESSMENTS_TABLE, "select", assessments.error);

    const byVillage = new Map<string, DamageAssessmentRow[]>();
    for (const row of (assessments.data ?? []) as DamageAssessmentRow[]) {
      const bucket = byVillage.get(row.village_id);
      if (bucket) bucket.push(row);
      else byVillage.set(row.village_id, [row]);
    }

    return villageRows.map((row) => fromRow(row, byVillage.get(row.id) ?? []));
  }
}
