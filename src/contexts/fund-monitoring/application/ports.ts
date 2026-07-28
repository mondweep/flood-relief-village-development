/**
 * Driven ports for Fund Monitoring (PRD §5 BC-4, ADR-004 §3).
 * Adapters (Supabase, in-memory) implement these; the domain never sees them.
 */
import type { ProjectId, VillageId } from '../../../shared/index.js';
import type { ComparableProject, FundedProject, ProjectCategory } from '../domain/index.js';

export interface ProjectRepository {
  findById(id: ProjectId): Promise<FundedProject | null>;
  /** All funded projects of a village — the duplicate-funding comparison set (FR-FM-4b). */
  findByVillage(villageId: VillageId): Promise<readonly FundedProject[]>;
  save(project: FundedProject): Promise<void>;
}

export interface ComparableCriteria {
  readonly category: ProjectCategory;
  readonly excludeProjectId: ProjectId;
}

/** Supplies the overspend baseline (FR-FM-4c): peer projects of the same category. */
export interface ComparableProjectsQuery {
  findComparable(criteria: ComparableCriteria): Promise<readonly ComparableProject[]>;
}

export type { ComparableProject };
