import type { SupabaseClient } from "@supabase/supabase-js";
import { ngoId, type NgoId } from "@afrip/shared-kernel";
import { Ngo } from "../domain/ngo.js";
import type { NgoRepository } from "../application/ports.js";
import { corrupt, failed } from "./supabase-errors.js";

/** Table owned by the ngo-coordination context (see 00001_initial_schema.sql). */
export const NGOS_TABLE = "ngo_coordination_ngos";

/** Row shape of `ngo_coordination_ngos`. */
export interface NgoRow {
  id: string;
  name: string;
  focus_areas: string[];
  capacity: number;
}

export function toRow(ngo: Ngo): NgoRow {
  return {
    id: ngo.id,
    name: ngo.name,
    focus_areas: [...ngo.focusAreas],
    capacity: ngo.capacity,
  };
}

/** Rebuilds an Ngo from its row; any factory failure throws. */
export function fromRow(row: NgoRow): Ngo {
  const id = ngoId(row.id);
  if (!id.ok) throw corrupt(NGOS_TABLE, String(row.id), id.error);

  const created = Ngo.create({
    id: id.value,
    name: row.name,
    focusAreas: [...(row.focus_areas ?? [])],
    capacity: row.capacity,
  });
  if (!created.ok) throw corrupt(NGOS_TABLE, row.id, created.error);
  return created.value;
}

/** Supabase/Postgres adapter for NgoRepository (ADR 0004). */
export class SupabaseNgoRepository implements NgoRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: NgoId): Promise<Ngo | undefined> {
    const result = await this.client.from(NGOS_TABLE).select("*").eq("id", id).maybeSingle();
    failed(NGOS_TABLE, "select", result.error);
    if (!result.data) return undefined;
    return fromRow(result.data as NgoRow);
  }

  async save(ngo: Ngo): Promise<void> {
    const result = await this.client.from(NGOS_TABLE).upsert(toRow(ngo));
    failed(NGOS_TABLE, "upsert", result.error);
  }
}
