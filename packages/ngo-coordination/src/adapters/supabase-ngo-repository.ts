import type { SupabaseClient } from "@supabase/supabase-js";
import { AFRIP_SCHEMA, ngoId, type NgoId } from "@afrip/shared-kernel";
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

  async findById(id: NgoId): Promise<Ngo | undefined> {
    const result = await this.table(NGOS_TABLE).select("*").eq("id", id).maybeSingle();
    failed(NGOS_TABLE, "select", result.error);
    if (!result.data) return undefined;
    return fromRow(result.data as NgoRow);
  }

  async save(ngo: Ngo): Promise<void> {
    const result = await this.table(NGOS_TABLE).upsert(toRow(ngo));
    failed(NGOS_TABLE, "upsert", result.error);
  }
}
