import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFRIP_SCHEMA,
  assignmentId,
  ngoId,
  villageId,
  type NgoId,
  type VillageId,
} from "@afrip/shared-kernel";
import {
  VillageAssignment,
  type AssignmentStatus,
  type CommitteeMember,
  type CommitteeRole,
} from "../domain/village-assignment.js";
import type { AssignmentRepository } from "../application/ports.js";
import { corrupt, failed } from "./supabase-errors.js";

/** Tables owned by the ngo-coordination context (see 00001_initial_schema.sql). */
export const ASSIGNMENTS_TABLE = "ngo_coordination_assignments";
export const COMMITTEE_MEMBERS_TABLE = "ngo_coordination_committee_members";

/** The status value that marks the single live assignment for a village. */
export const ACTIVE_STATUS: AssignmentStatus = "active";

/** Row shape of `ngo_coordination_assignments`. */
export interface AssignmentRow {
  id: string;
  village_id: string;
  ngo_id: string;
  status: string;
  assigned_at: string;
  retired_at: string | null;
}

/** Row shape of `ngo_coordination_committee_members` (identity `id` is DB-assigned). */
export interface CommitteeMemberRow {
  assignment_id: string;
  role: string;
  name: string;
  contact: string | null;
}

export function toRow(assignment: VillageAssignment): AssignmentRow {
  return {
    id: assignment.id,
    village_id: assignment.villageId,
    ngo_id: assignment.ngoId,
    status: assignment.status,
    assigned_at: assignment.assignedAt,
    // The aggregate keeps no retirement timestamp; the column stays null.
    retired_at: null,
  };
}

export function toCommitteeMemberRows(assignment: VillageAssignment): CommitteeMemberRow[] {
  return assignment.committee.map((member) => ({
    assignment_id: assignment.id,
    role: member.role,
    name: member.name,
    contact: member.contact ?? null,
  }));
}

function toCommitteeMember(row: CommitteeMemberRow): CommitteeMember {
  return {
    role: row.role as CommitteeRole,
    name: row.name,
    ...(row.contact === null || row.contact === undefined ? {} : { contact: row.contact }),
  };
}

/**
 * Rebuilds a VillageAssignment from its row plus its committee rows. Members
 * are added while the assignment is still active (addCommitteeMember refuses a
 * retired assignment), then the stored status is applied. Any failure throws.
 */
export function fromRow(
  row: AssignmentRow,
  memberRows: readonly CommitteeMemberRow[],
): VillageAssignment {
  const id = assignmentId(row.id);
  if (!id.ok) throw corrupt(ASSIGNMENTS_TABLE, String(row.id), id.error);
  const village = villageId(row.village_id);
  if (!village.ok) throw corrupt(ASSIGNMENTS_TABLE, row.id, village.error);
  const ngo = ngoId(row.ngo_id);
  if (!ngo.ok) throw corrupt(ASSIGNMENTS_TABLE, row.id, ngo.error);
  if (row.status !== "active" && row.status !== "retired") {
    throw corrupt(ASSIGNMENTS_TABLE, row.id, `invalid status: ${String(row.status)}`);
  }
  if (typeof row.assigned_at !== "string" || row.assigned_at.trim().length === 0) {
    throw corrupt(ASSIGNMENTS_TABLE, row.id, "assigned_at must not be empty");
  }

  const assignment = VillageAssignment.create({
    id: id.value,
    villageId: village.value,
    ngoId: ngo.value,
    assignedAt: row.assigned_at,
  });

  for (const memberRow of memberRows) {
    const added = assignment.addCommitteeMember(toCommitteeMember(memberRow));
    if (!added.ok) throw corrupt(COMMITTEE_MEMBERS_TABLE, row.id, added.error);
  }

  if (row.status === "retired") {
    const retired = assignment.retire();
    if (!retired.ok) throw corrupt(ASSIGNMENTS_TABLE, row.id, retired.error);
  }

  return assignment;
}

/** Supabase/Postgres adapter for AssignmentRepository (ADR 0004). */
export class SupabaseAssignmentRepository implements AssignmentRepository {
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

  async findActiveByVillage(village: VillageId): Promise<VillageAssignment | undefined> {
    const result = await this.table(ASSIGNMENTS_TABLE)
      .select("*")
      .eq("village_id", village)
      .eq("status", ACTIVE_STATUS)
      .maybeSingle();
    failed(ASSIGNMENTS_TABLE, "select", result.error);
    if (!result.data) return undefined;

    const row = result.data as AssignmentRow;
    const members = await this.committeeRowsFor([row.id]);
    return fromRow(row, members.get(row.id) ?? []);
  }

  async findActiveByNgo(ngo: NgoId): Promise<VillageAssignment[]> {
    const result = await this.table(ASSIGNMENTS_TABLE)
      .select("*")
      .eq("ngo_id", ngo)
      .eq("status", ACTIVE_STATUS)
      .order("id", { ascending: true });
    failed(ASSIGNMENTS_TABLE, "select", result.error);

    const rows = (result.data ?? []) as AssignmentRow[];
    if (rows.length === 0) return [];

    const members = await this.committeeRowsFor(rows.map((row) => row.id));
    return rows.map((row) => fromRow(row, members.get(row.id) ?? []));
  }

  async save(assignment: VillageAssignment): Promise<void> {
    const upserted = await this.table(ASSIGNMENTS_TABLE).upsert(toRow(assignment));
    failed(ASSIGNMENTS_TABLE, "upsert", upserted.error);

    // Committee members carry a DB-assigned identity key, so the child set is
    // reconciled wholesale: clear then re-insert in aggregate order.
    const cleared = await this.table(COMMITTEE_MEMBERS_TABLE)
      .delete()
      .eq("assignment_id", assignment.id);
    failed(COMMITTEE_MEMBERS_TABLE, "delete", cleared.error);

    const rows = toCommitteeMemberRows(assignment);
    if (rows.length > 0) {
      const inserted = await this.table(COMMITTEE_MEMBERS_TABLE).insert(rows);
      failed(COMMITTEE_MEMBERS_TABLE, "insert", inserted.error);
    }
  }

  private async committeeRowsFor(
    assignmentIds: readonly string[],
  ): Promise<Map<string, CommitteeMemberRow[]>> {
    const result = await this.table(COMMITTEE_MEMBERS_TABLE)
      .select("*")
      .in("assignment_id", [...assignmentIds])
      .order("id", { ascending: true });
    failed(COMMITTEE_MEMBERS_TABLE, "select", result.error);

    const byAssignment = new Map<string, CommitteeMemberRow[]>();
    for (const row of (result.data ?? []) as CommitteeMemberRow[]) {
      const bucket = byAssignment.get(row.assignment_id);
      if (bucket) bucket.push(row);
      else byAssignment.set(row.assignment_id, [row]);
    }
    return byAssignment;
  }
}
