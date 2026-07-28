/**
 * Supabase adapter for VolunteerRepository (BC-7, ADR-003 schema `volunteer_management`).
 * `Volunteer` exposes a `hydrate` factory purpose-built for rehydration, so this adapter
 * needs no reflection tricks (contrast with Beneficiary/Issue in other contexts).
 *
 * Mapping note: `service_logs` (individual hour-logging events) has no counterpart on the
 * `Volunteer` aggregate — only the cumulative `totalHours` is tracked — and no port method
 * exposes it, so this adapter does not populate that table.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type VolunteerId } from '../../../../shared/index.js';
import { Volunteer, type ActiveAssignment, type Availability } from '../../domain/volunteer.js';
import type { VolunteerRepository } from '../../application/ports.js';

const SCHEMA = 'volunteer_management';

export interface VolunteerRow {
  readonly id: string;
  readonly name: string;
  readonly contact: string;
  readonly skills: readonly string[];
  readonly languages: readonly string[];
  readonly location: string;
  readonly availability: string;
  readonly active_village_id: string | null;
  readonly active_role: string | null;
  readonly active_since: string | null;
  readonly total_hours: number;
  readonly certificates: readonly string[];
}

/** Pure mapping: Volunteer -> its `volunteers` row. */
export function toVolunteerRow(volunteer: Volunteer): VolunteerRow {
  const active = volunteer.activeAssignment;
  return {
    id: volunteer.id,
    name: volunteer.name,
    contact: volunteer.contact,
    skills: volunteer.skills,
    languages: volunteer.languages,
    location: volunteer.location,
    availability: volunteer.availability,
    active_village_id: active ? active.villageId : null,
    active_role: active ? active.role : null,
    active_since: active ? active.since.toISOString() : null,
    total_hours: volunteer.totalHours,
    certificates: volunteer.certificates,
  };
}

/** Pure mapping: a `volunteers` row -> a Volunteer instance, via `Volunteer.hydrate`. */
export function fromVolunteerRow(row: VolunteerRow): Volunteer {
  const activeAssignment: ActiveAssignment | null =
    row.active_village_id !== null && row.active_role !== null && row.active_since !== null
      ? {
          villageId: asId<'VillageId'>(row.active_village_id),
          role: row.active_role,
          since: new Date(row.active_since),
        }
      : null;

  return Volunteer.hydrate(
    asId<'VolunteerId'>(row.id),
    row.name,
    row.contact,
    row.skills,
    row.languages,
    row.location,
    row.availability as Availability,
    activeAssignment,
    row.total_hours,
    row.certificates,
  );
}

export class SupabaseVolunteerRepository implements VolunteerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: VolunteerId): Promise<Volunteer | null> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('volunteers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`SupabaseVolunteerRepository.findById: ${error.message}`);
    return data ? fromVolunteerRow(data as VolunteerRow) : null;
  }

  async save(volunteer: Volunteer): Promise<void> {
    const { error } = await this.client.schema(SCHEMA).from('volunteers').upsert(toVolunteerRow(volunteer));
    if (error) throw new Error(`SupabaseVolunteerRepository.save: ${error.message}`);
  }
}
