import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_RELEASED } from '../domain/events.js';
import { releaseAssignmentUseCase } from './release-assignment.js';
import {
  NOW,
  anAssignment,
  assignmentId,
  assignmentRepositoryMock,
  clockStub,
  eventPublisherMock,
  ngoId,
  publishedEvents,
  villageId,
} from './test-doubles.js';

const makeDeps = () => {
  const assignments = assignmentRepositoryMock();
  const events = eventPublisherMock();
  assignments.findById.mockResolvedValue(anAssignment());
  return { assignments, events, clock: clockStub() };
};

const command = { assignmentId: assignmentId(1), reason: 'NGO withdrew after funding cut' };

describe('ReleaseAssignment (FR-NC-3)', () => {
  it('FR-NC-3: saves the assignment as released with reason and timestamp', async () => {
    const deps = makeDeps();

    const result = await releaseAssignmentUseCase(deps)(command);

    expect(result.ok).toBe(true);
    expect(deps.assignments.findById).toHaveBeenCalledWith(assignmentId(1));
    expect(deps.assignments.save).toHaveBeenCalledTimes(1);
    expect(deps.assignments.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: assignmentId(1),
        status: 'released',
        releasedAt: NOW,
        releaseReason: 'NGO withdrew after funding cut',
      }),
    );
  });

  it('FR-NC-3: publishes AssignmentReleased carrying the village, NGO and reason', async () => {
    const deps = makeDeps();

    await releaseAssignmentUseCase(deps)(command);

    expect(publishedEvents(deps.events)).toEqual([
      {
        type: ASSIGNMENT_RELEASED,
        occurredAt: NOW,
        payload: {
          assignmentId: assignmentId(1),
          villageId: villageId(1),
          ngoId: ngoId(1),
          reason: 'NGO withdrew after funding cut',
        },
      },
    ]);
  });

  it('FR-NC-3: rejects a release without a reason and saves nothing', async () => {
    const deps = makeDeps();

    const result = await releaseAssignmentUseCase(deps)({
      assignmentId: assignmentId(1),
      reason: '  ',
    });

    expect(!result.ok && result.error.code).toBe('RELEASE_REASON_REQUIRED');
    expect(deps.assignments.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-3: rejects releasing an assignment that is already released', async () => {
    const deps = makeDeps();
    deps.assignments.findById.mockResolvedValue(
      anAssignment({ status: 'released', releasedAt: NOW, releaseReason: 'earlier reason' }),
    );

    const result = await releaseAssignmentUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('ASSIGNMENT_NOT_ACTIVE');
    expect(deps.assignments.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-3: rejects an unknown assignment id', async () => {
    const deps = makeDeps();
    deps.assignments.findById.mockResolvedValue(null);

    const result = await releaseAssignmentUseCase(deps)(command);

    expect(!result.ok && result.error.code).toBe('ASSIGNMENT_NOT_FOUND');
    expect(deps.assignments.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });
});
