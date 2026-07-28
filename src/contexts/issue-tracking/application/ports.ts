import type { IssueId, NgoId, VillageId } from '../../../shared/index.js';
import type { Issue } from '../domain/issue.js';

/**
 * BC-6 Issue Tracking — driven ports (PRD §5 BC-6).
 * Repositories/lookups are Vitest-mocked in use-case tests (ADR-004 §2).
 */
export interface IssueRepository {
  save(issue: Issue): Promise<void>;
  findById(id: IssueId): Promise<Issue | null>;
}

/**
 * Anti-corruption port onto NGO Coordination (BC-2). Issue Tracking never
 * imports from ngo-coordination directly; this port and its NgoId return
 * type are Issue Tracking's own translation of "who is assigned here".
 */
export interface AssignmentLookup {
  findActiveNgoForVillage(villageId: VillageId): Promise<NgoId | null>;
}
