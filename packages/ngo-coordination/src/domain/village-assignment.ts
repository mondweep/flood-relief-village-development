import { err, ok, type AssignmentId, type NgoId, type Result, type VillageId } from "@afrip/shared-kernel";

export type CommitteeRole =
  | "leader"
  | "volunteer"
  | "engineer"
  | "teacher"
  | "doctor"
  | "government_rep"
  | "health_worker"
  | "school_rep"
  | "womens_rep";

export interface CommitteeMember {
  role: CommitteeRole;
  name: string;
  contact?: string;
}

export type AssignmentStatus = "active" | "retired";

export interface VillageAssignmentProps {
  id: AssignmentId;
  villageId: VillageId;
  ngoId: NgoId;
  assignedAt: string;
}

/**
 * VillageAssignment aggregate: links one village to one NGO with a committee.
 * Flagship invariant (at most one active assignment per village) is enforced by
 * the AssignNgoToVillage use case, which retires the previous assignment before
 * creating a new one — this aggregate never deletes history.
 */
export class VillageAssignment {
  readonly id: AssignmentId;
  readonly villageId: VillageId;
  readonly ngoId: NgoId;
  readonly assignedAt: string;
  private _status: AssignmentStatus;
  private readonly _committee: CommitteeMember[];

  private constructor(props: VillageAssignmentProps, status: AssignmentStatus, committee: CommitteeMember[]) {
    this.id = props.id;
    this.villageId = props.villageId;
    this.ngoId = props.ngoId;
    this.assignedAt = props.assignedAt;
    this._status = status;
    this._committee = committee;
  }

  static create(props: VillageAssignmentProps): VillageAssignment {
    return new VillageAssignment(props, "active", []);
  }

  get status(): AssignmentStatus {
    return this._status;
  }

  get committee(): readonly CommitteeMember[] {
    return [...this._committee];
  }

  retire(): Result<void> {
    if (this._status === "retired") return err("assignment is already retired");
    this._status = "retired";
    return ok(undefined);
  }

  addCommitteeMember(member: CommitteeMember): Result<void> {
    if (this._status !== "active") return err("cannot modify a retired assignment");
    if (this._committee.some((existing) => existing.role === member.role)) {
      return err(`committee role '${member.role}' is already filled`);
    }
    this._committee.push({ ...member });
    return ok(undefined);
  }
}
