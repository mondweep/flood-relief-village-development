export * from "./domain/ngo.js";
export * from "./domain/village-assignment.js";
export * from "./application/ports.js";
export * from "./application/register-ngo.js";
export * from "./application/assign-ngo-to-village.js";
export * from "./application/add-committee-member.js";
export * from "./application/list-unassigned-villages.js";
export * from "./adapters/in-memory-ngo-repository.js";
export * from "./adapters/in-memory-assignment-repository.js";

export {
  NGOS_TABLE,
  SupabaseNgoRepository,
  fromRow as ngoFromRow,
  toRow as ngoToRow,
  type NgoRow,
} from "./adapters/supabase-ngo-repository.js";

export {
  ACTIVE_STATUS,
  ASSIGNMENTS_TABLE,
  COMMITTEE_MEMBERS_TABLE,
  SupabaseAssignmentRepository,
  fromRow as assignmentFromRow,
  toCommitteeMemberRows,
  toRow as assignmentToRow,
  type AssignmentRow,
  type CommitteeMemberRow,
} from "./adapters/supabase-assignment-repository.js";
