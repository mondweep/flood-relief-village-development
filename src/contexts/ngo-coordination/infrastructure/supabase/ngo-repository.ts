/** Supabase adapter for NgoRepository (BC-2, ADR-003 schema `ngo_coordination`). */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type NgoId } from '../../../../shared/index.js';
import type { Ngo } from '../../domain/ngo.js';
import type { NgoRepository } from '../../application/ports.js';

const SCHEMA = 'ngo_coordination';

export interface NgoRow {
  readonly id: string;
  readonly name: string;
  readonly verified: boolean;
  readonly capacity: number;
}

/**
 * Pure mapping: Ngo aggregate -> `ngos` row.
 * The `contact` column has no domain counterpart — the aggregate doesn't model it, so it
 * is simply left unset here (untouched on update, null on first insert).
 */
export function toNgoRow(ngo: Ngo): NgoRow {
  return { id: ngo.id, name: ngo.name, verified: ngo.verified, capacity: ngo.capacity };
}

export function fromNgoRow(row: NgoRow): Ngo {
  return { id: asId<'NgoId'>(row.id), name: row.name, capacity: row.capacity, verified: row.verified };
}

export class SupabaseNgoRepository implements NgoRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: NgoId): Promise<Ngo | null> {
    const { data, error } = await this.client.schema(SCHEMA).from('ngos').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`SupabaseNgoRepository.findById: ${error.message}`);
    return data ? fromNgoRow(data as NgoRow) : null;
  }

  async save(ngo: Ngo): Promise<void> {
    const { error } = await this.client.schema(SCHEMA).from('ngos').upsert(toNgoRow(ngo));
    if (error) throw new Error(`SupabaseNgoRepository.save: ${error.message}`);
  }
}
