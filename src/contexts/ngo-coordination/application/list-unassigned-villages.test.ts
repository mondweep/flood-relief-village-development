import { describe, expect, it } from 'vitest';
import { listUnassignedVillagesUseCase } from './list-unassigned-villages.js';
import {
  affectedVillageLookupMock,
  assignmentRepositoryMock,
  villageId,
} from './test-doubles.js';

const makeDeps = () => ({
  villages: affectedVillageLookupMock(),
  assignments: assignmentRepositoryMock(),
});

describe('ListUnassignedVillages (FR-NC-6)', () => {
  it('FR-NC-6: asks the assignment repository which affected villages are already assigned', async () => {
    const deps = makeDeps();
    const affected = [villageId(1), villageId(2), villageId(3)];
    deps.villages.listAffectedVillageIds.mockResolvedValue(affected);
    deps.assignments.findAssignedVillageIds.mockResolvedValue([villageId(2)]);

    const result = await listUnassignedVillagesUseCase(deps)();

    expect(deps.villages.listAffectedVillageIds).toHaveBeenCalledTimes(1);
    expect(deps.assignments.findAssignedVillageIds).toHaveBeenCalledWith(affected);
    expect(result.ok && result.value.villageIds).toEqual([villageId(1), villageId(3)]);
  });

  it('FR-NC-6: returns every affected village when none has a lead NGO', async () => {
    const deps = makeDeps();
    deps.villages.listAffectedVillageIds.mockResolvedValue([villageId(1), villageId(2)]);
    deps.assignments.findAssignedVillageIds.mockResolvedValue([]);

    const result = await listUnassignedVillagesUseCase(deps)();

    expect(result.ok && result.value.villageIds).toEqual([villageId(1), villageId(2)]);
  });

  it('FR-NC-6: returns an empty feed when every affected village is assigned', async () => {
    const deps = makeDeps();
    deps.villages.listAffectedVillageIds.mockResolvedValue([villageId(1), villageId(2)]);
    deps.assignments.findAssignedVillageIds.mockResolvedValue([villageId(1), villageId(2)]);

    const result = await listUnassignedVillagesUseCase(deps)();

    expect(result.ok && result.value.villageIds).toEqual([]);
  });

  it('FR-NC-6: does not query assignments when there are no affected villages', async () => {
    const deps = makeDeps();
    deps.villages.listAffectedVillageIds.mockResolvedValue([]);

    const result = await listUnassignedVillagesUseCase(deps)();

    expect(result.ok && result.value.villageIds).toEqual([]);
    expect(deps.assignments.findAssignedVillageIds).not.toHaveBeenCalled();
  });
});
