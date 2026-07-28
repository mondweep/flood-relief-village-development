import type { IssueId, VillageId } from "@afrip/shared-kernel";
import type { Issue, IssueStatus } from "../domain/issue.js";
import type { IssueRepository } from "../application/ports.js";

/** In-memory fake adapter for IssueRepository — used in tests and local runs. */
export class InMemoryIssueRepository implements IssueRepository {
  private readonly issues = new Map<string, Issue>();

  async findById(id: IssueId): Promise<Issue | null> {
    return this.issues.get(id) ?? null;
  }

  async save(issue: Issue): Promise<void> {
    this.issues.set(issue.id, issue);
  }

  async listByVillage(villageId: VillageId): Promise<Issue[]> {
    return Array.from(this.issues.values()).filter((issue) => issue.villageId === villageId);
  }

  async listByStatus(status: IssueStatus): Promise<Issue[]> {
    return Array.from(this.issues.values()).filter((issue) => issue.status === status);
  }
}
