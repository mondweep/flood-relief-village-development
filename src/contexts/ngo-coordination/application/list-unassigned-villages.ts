import { ok, type Result, type VillageId } from '../../../shared/index.js';
import type { AffectedVillageLookup, AssignmentRepository } from './ports.js';

export interface ListUnassignedVillagesDeps {
  readonly villages: AffectedVillageLookup;
  readonly assignments: AssignmentRepository;
}

export interface ListUnassignedVillagesResult {
  readonly villageIds: readonly VillageId[];
}

/** FR-NC-6: the "No NGO assigned" alert feed for affected villages. */
export const listUnassignedVillagesUseCase =
  (deps: ListUnassignedVillagesDeps) =>
  async (): Promise<Result<ListUnassignedVillagesResult>> => {
    const affected = await deps.villages.listAffectedVillageIds();
    if (affected.length === 0) {
      return ok({ villageIds: [] });
    }

    const assigned = new Set<string>(await deps.assignments.findAssignedVillageIds(affected));
    return ok({ villageIds: affected.filter((id) => !assigned.has(id)) });
  };
