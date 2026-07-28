import { describe, expect, it } from 'vitest';
import { err } from '../../../shared/index.js';
import { NGO_ASSIGNED } from '../domain/events.js';
import { assignNgoToVillageUseCase } from './assign-ngo-to-village.js';
import {
  NOW,
  anAssignment,
  anNgo,
  assignmentId,
  assignmentRepositoryMock,
  clockStub,
  eventPublisherMock,
  idGeneratorStub,
  ngoId,
  ngoRepositoryMock,
  publishedEvents,
  villageId,
} from './test-doubles.js';

const makeDeps = () => {
  const ngos = ngoRepositoryMock();
  const assignments = assignmentRepositoryMock();
  const events = eventPublisherMock();
  ngos.findById.mockResolvedValue(anNgo({ verified: true, capacity: 3 }));
  return { ngos, assignments, events, clock: clockStub(), ids: idGeneratorStub(assignmentId(9)) };
};

const command = { villageId: villageId(1), ngoId: ngoId(1) };

describe('AssignNgoToVillage (FR-NC-2, FR-NC-4)', () => {
  it('FR-NC-2: inserts an active assignment and publishes NgoAssigned when the village is free', async () => {
    const deps = makeDeps();
    deps.assignments.findActiveByVillage.mockResolvedValue(null);

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(result.ok).toBe(true);
    expect(deps.assignments.findActiveByVillage).toHaveBeenCalledWith(villageId(1));
    expect(deps.assignments.insertActive).toHaveBeenCalledTimes(1);
    expect(deps.assignments.insertActive).toHaveBeenCalledWith({
      id: assignmentId(9),
      villageId: villageId(1),
      ngoId: ngoId(1),
      status: 'active',
      assignedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    });
    expect(publishedEvents(deps.events)).toEqual([
      {
        type: NGO_ASSIGNED,
        occurredAt: NOW,
        payload: { assignmentId: assignmentId(9), villageId: villageId(1), ngoId: ngoId(1) },
      },
    ]);
  });

  it('FR-NC-2: returns the new assignment id to the caller', async () => {
    const deps = makeDeps();

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(result.ok && result.value.assignmentId).toBe(assignmentId(9));
  });

  it('FR-NC-2: rejects a second NGO for a village that already has an active assignment', async () => {
    const deps = makeDeps();
    deps.assignments.findActiveByVillage.mockResolvedValue(
      anAssignment({ villageId: villageId(1), ngoId: ngoId(2) }),
    );

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('VILLAGE_ALREADY_ASSIGNED');
    expect(deps.assignments.insertActive).not.toHaveBeenCalled();
    expect(deps.assignments.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-2: re-assigning the same NGO to a village it already leads is still rejected', async () => {
    const deps = makeDeps();
    deps.assignments.findActiveByVillage.mockResolvedValue(
      anAssignment({ villageId: villageId(1), ngoId: ngoId(1) }),
    );

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('VILLAGE_ALREADY_ASSIGNED');
    expect(deps.assignments.insertActive).not.toHaveBeenCalled();
  });

  it('FR-NC-2: rejects an unverified NGO before looking at village assignments', async () => {
    const deps = makeDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ verified: false }));

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('NGO_NOT_VERIFIED');
    expect(deps.assignments.insertActive).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-2: rejects an unknown NGO without touching the assignment repository', async () => {
    const deps = makeDeps();
    deps.ngos.findById.mockResolvedValue(null);

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('NGO_NOT_FOUND');
    expect(deps.assignments.findActiveByVillage).not.toHaveBeenCalled();
    expect(deps.assignments.insertActive).not.toHaveBeenCalled();
  });

  it('FR-NC-2: rejects when the repository reports a competing active assignment appearing between check and write (race)', async () => {
    const deps = makeDeps();
    deps.assignments.findActiveByVillage.mockResolvedValue(null);
    deps.assignments.insertActive.mockResolvedValue(
      err('VILLAGE_ALREADY_ASSIGNED', 'unique constraint on active assignment per village'),
    );

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('VILLAGE_ALREADY_ASSIGNED');
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-4: rejects when the NGO already leads its capacity of villages', async () => {
    const deps = makeDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ capacity: 2 }));
    deps.assignments.countActiveByNgo.mockResolvedValue(2);

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('NGO_AT_CAPACITY');
    expect(deps.assignments.countActiveByNgo).toHaveBeenCalledWith(ngoId(1));
    expect(deps.assignments.insertActive).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-4: allows the assignment that exactly fills the remaining capacity', async () => {
    const deps = makeDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ capacity: 2 }));
    deps.assignments.countActiveByNgo.mockResolvedValue(1);

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(result.ok).toBe(true);
    expect(deps.assignments.insertActive).toHaveBeenCalledTimes(1);
  });

  it('FR-NC-4: counts only active assignments — released ones do not consume capacity', async () => {
    const deps = makeDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ capacity: 1 }));
    // The repository counts active assignments only; a released one leaves the count at 0.
    deps.assignments.countActiveByNgo.mockResolvedValue(0);

    const result = await assignNgoToVillageUseCase(deps)(command);

    expect(result.ok).toBe(true);
  });

  it('FR-NC-3: a village whose assignment was released can be assigned to a different NGO', async () => {
    const deps = makeDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ id: ngoId(2), verified: true, capacity: 1 }));
    deps.assignments.findActiveByVillage.mockResolvedValue(null); // previous one is released
    deps.assignments.countActiveByNgo.mockResolvedValue(0);

    const result = await assignNgoToVillageUseCase(deps)({
      villageId: villageId(1),
      ngoId: ngoId(2),
    });

    expect(result.ok).toBe(true);
    expect(deps.assignments.insertActive).toHaveBeenCalledWith(
      expect.objectContaining({ villageId: villageId(1), ngoId: ngoId(2), status: 'active' }),
    );
  });
});
