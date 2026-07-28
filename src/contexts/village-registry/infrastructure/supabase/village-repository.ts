/**
 * Supabase adapter for VillageRepository (BC-1, ADR-003 schema `village_registry`).
 * `villages` holds current state; `severity_changes` is the append-only audit trail
 * (FR-VR-3) — `save` inserts only the tail of `severityHistory` not yet persisted.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type GeoPoint, type VillageId } from '../../../../shared/index.js';
import type { DamageInventory } from '../../domain/damage-inventory.js';
import type { Demographics } from '../../domain/demographics.js';
import type { Severity, SeverityChangeRecord } from '../../domain/severity.js';
import type { Village } from '../../domain/village.js';
import type { VillageRepository } from '../../application/ports.js';

const SCHEMA = 'village_registry';

export interface VillageRow {
  readonly id: string;
  readonly name: string;
  readonly district: string;
  readonly lat: number;
  readonly lng: number;
  readonly population: number;
  readonly households: number;
  readonly affected_families: number;
  readonly severity: string;
  readonly damaged_houses: number;
  readonly damaged_schools: number;
  readonly damaged_health_centres: number;
  readonly damaged_water_sources: number;
  readonly agriculture_hectares_damaged: number;
  readonly livestock_lost: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SeverityChangeRow {
  readonly village_id: string;
  readonly from_severity: string;
  readonly to_severity: string;
  readonly reason: string;
  readonly changed_at: string;
}

/** Pure mapping: Village aggregate -> `villages` row (id is the natural key for upsert). */
export function toVillageRow(village: Village): VillageRow {
  return {
    id: village.id,
    name: village.name,
    district: village.district,
    lat: village.location.lat,
    lng: village.location.lng,
    population: village.demographics.population,
    households: village.demographics.households,
    affected_families: village.demographics.affectedFamilies,
    severity: village.severity,
    damaged_houses: village.damageInventory.houses,
    damaged_schools: village.damageInventory.schools,
    damaged_health_centres: village.damageInventory.healthCentres,
    damaged_water_sources: village.damageInventory.waterSources,
    agriculture_hectares_damaged: village.damageInventory.agricultureHectares,
    livestock_lost: village.damageInventory.livestock,
    created_at: village.registeredAt.toISOString(),
    updated_at: village.updatedAt.toISOString(),
  };
}

/** Pure mapping: a single new severity-history entry -> its append-only row. */
export function toNewSeverityChangeRow(villageId: VillageId, record: SeverityChangeRecord): SeverityChangeRow {
  return {
    village_id: villageId,
    from_severity: record.from,
    to_severity: record.to,
    reason: record.reason,
    changed_at: record.at.toISOString(),
  };
}

/** Pure mapping: `villages` row + its ordered severity-history rows -> the Village aggregate. */
export function fromVillageRow(row: VillageRow, historyRows: readonly SeverityChangeRow[]): Village {
  const location: GeoPoint = { lat: row.lat, lng: row.lng };
  const demographics: Demographics = {
    population: row.population,
    households: row.households,
    affectedFamilies: row.affected_families,
  };
  const damageInventory: DamageInventory = {
    houses: row.damaged_houses,
    schools: row.damaged_schools,
    healthCentres: row.damaged_health_centres,
    waterSources: row.damaged_water_sources,
    agricultureHectares: row.agriculture_hectares_damaged,
    livestock: row.livestock_lost,
  };
  const severityHistory: readonly SeverityChangeRecord[] = historyRows.map((h) => ({
    from: h.from_severity as Severity,
    to: h.to_severity as Severity,
    reason: h.reason,
    at: new Date(h.changed_at),
  }));

  return {
    id: asId<'VillageId'>(row.id),
    name: row.name,
    district: row.district,
    location,
    demographics,
    damageInventory,
    severity: row.severity as Severity,
    severityHistory,
    registeredAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SupabaseVillageRepository implements VillageRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: VillageId): Promise<Village | null> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('villages')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`SupabaseVillageRepository.findById: ${error.message}`);
    if (!data) return null;

    const history = await this.loadHistory(id);
    return fromVillageRow(data as VillageRow, history);
  }

  async save(village: Village): Promise<void> {
    const { error } = await this.client.schema(SCHEMA).from('villages').upsert(toVillageRow(village));
    if (error) throw new Error(`SupabaseVillageRepository.save: ${error.message}`);

    const { count, error: countError } = await this.client
      .schema(SCHEMA)
      .from('severity_changes')
      .select('id', { count: 'exact', head: true })
      .eq('village_id', village.id);
    if (countError) throw new Error(`SupabaseVillageRepository.save (history count): ${countError.message}`);

    const persisted = count ?? 0;
    const newEntries = village.severityHistory.slice(persisted);
    if (newEntries.length > 0) {
      const rows = newEntries.map((record) => toNewSeverityChangeRow(village.id, record));
      const { error: insertError } = await this.client.schema(SCHEMA).from('severity_changes').insert(rows);
      if (insertError) {
        throw new Error(`SupabaseVillageRepository.save (history insert): ${insertError.message}`);
      }
    }
  }

  private async loadHistory(id: VillageId): Promise<readonly SeverityChangeRow[]> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('severity_changes')
      .select('*')
      .eq('village_id', id)
      .order('changed_at', { ascending: true });
    if (error) throw new Error(`SupabaseVillageRepository (history): ${error.message}`);
    return (data ?? []) as SeverityChangeRow[];
  }
}
