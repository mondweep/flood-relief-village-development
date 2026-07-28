import type { IssueId, VillageId } from "@afrip/shared-kernel";
import type { Issue, IssueStatus } from "../domain/issue.js";
import type { LeadNgo } from "../domain/routing-policy.js";

/** Outbound port: persistence for the Issue aggregate. */
export interface IssueRepository {
  findById(id: IssueId): Promise<Issue | null>;
  save(issue: Issue): Promise<void>;
  listByVillage(villageId: VillageId): Promise<Issue[]>;
  listByStatus(status: IssueStatus): Promise<Issue[]>;
}

/** Outbound port: looks up the lead NGO assigned to a village, if any. */
export interface AssignmentLookup {
  findLeadNgo(villageId: VillageId): Promise<LeadNgo | null>;
}
