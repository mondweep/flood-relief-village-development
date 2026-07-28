import { beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { makeCompleteProject } from './complete-project.js';
import {
  PROJECT_ID,
  aProject,
  asProjectRepository,
  fixedClock,
  mockEventPublisher,
  mockProjectRepository,
  withEvidence,
  withReleased,
  withSpent,
} from '../test-support.js';

const NOW = '2026-05-01T00:00:00.000Z';

describe('FR-FM-3 CompleteProject (village verification required)', () => {
  let projects: ReturnType<typeof mockProjectRepository>;
  let events: ReturnType<typeof mockEventPublisher>;
  let useCase: ReturnType<typeof makeCompleteProject>;

  const command = { projectId: PROJECT_ID as string };

  beforeEach(() => {
    projects = mockProjectRepository();
    events = mockEventPublisher();
    projects.findById.mockResolvedValue(withEvidence(aProject(), 'village_verification'));
    useCase = makeCompleteProject({
      projects: asProjectRepository(projects),
      events,
      clock: fixedClock(NOW),
    });
  });

  it('FR-FM-3: completes a project that has village verification and publishes ProjectCompleted', async () => {
    const result = await useCase.execute(command);

    expect(result.ok).toBe(true);
    expect(unwrap(result).status).toBe('completed');
    expect(unwrap(result).completedAt).toEqual(new Date(NOW));
    expect(projects.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', completedAt: new Date(NOW) }),
    );
    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ProjectCompleted',
        occurredAt: new Date(NOW),
        payload: expect.objectContaining({ projectId: PROJECT_ID }),
      }),
    ]);
  });

  it('FR-FM-3: reports the final spend on completion', async () => {
    projects.findById.mockResolvedValue(
      withEvidence(withSpent(withReleased(aProject(), 800_000), 750_000), 'village_verification'),
    );

    await useCase.execute(command);

    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: expect.objectContaining({ totalSpentMinor: 750_000, currency: 'INR' }),
      }),
    ]);
  });

  it('FR-FM-3: refuses completion without village_verification evidence', async () => {
    projects.findById.mockResolvedValue(aProject());

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMPLETION_NEEDS_VILLAGE_VERIFICATION');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-3: photos, invoices and certificates alone do not satisfy village verification', async () => {
    let project = withEvidence(aProject(), 'geo_tagged_photo');
    project = withEvidence(project, 'invoice');
    project = withEvidence(project, 'completion_certificate');
    projects.findById.mockResolvedValue(project);

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMPLETION_NEEDS_VILLAGE_VERIFICATION');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects completing an already completed project', async () => {
    projects.findById.mockResolvedValue(
      withEvidence(aProject({ status: 'completed', completedAt: new Date(NOW) }), 'village_verification'),
    );

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_ALREADY_COMPLETED');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects completing an unknown project', async () => {
    projects.findById.mockResolvedValue(null);

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-3: rejects a malformed project id before hitting the repository', async () => {
    const result = await useCase.execute({ projectId: 'nope' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT_ID');
    expect(projects.findById).not.toHaveBeenCalled();
  });
});
