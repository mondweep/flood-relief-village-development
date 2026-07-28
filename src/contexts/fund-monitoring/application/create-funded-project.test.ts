import { beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { makeCreateFundedProject } from './create-funded-project.js';
import {
  EXPECTED_COMPLETION_AT,
  PROJECT_ID,
  VILLAGE_ID,
  aProject,
  asProjectRepository,
  fixedClock,
  mockEventPublisher,
  mockProjectRepository,
} from '../test-support.js';

const NOW = '2026-01-01T00:00:00.000Z';

describe('FR-FM-1 CreateFundedProject', () => {
  let projects: ReturnType<typeof mockProjectRepository>;
  let events: ReturnType<typeof mockEventPublisher>;
  let useCase: ReturnType<typeof makeCreateFundedProject>;

  const command = {
    projectId: PROJECT_ID as string,
    villageId: VILLAGE_ID as string,
    title: 'Village approach road repair',
    category: 'road',
    fundingSource: 'district',
    sanctionedAmountMinor: 1_000_000,
    currency: 'INR',
    expectedCompletionAt: EXPECTED_COMPLETION_AT,
  };

  beforeEach(() => {
    projects = mockProjectRepository();
    events = mockEventPublisher();
    useCase = makeCreateFundedProject({
      projects: asProjectRepository(projects),
      events,
      clock: fixedClock(NOW),
    });
  });

  it('FR-FM-1: saves a sanctioned project and publishes ProjectFunded', async () => {
    const result = await useCase.execute(command);

    expect(result.ok).toBe(true);
    expect(projects.save).toHaveBeenCalledTimes(1);
    expect(projects.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PROJECT_ID,
        villageId: VILLAGE_ID,
        category: 'road',
        fundingSource: 'district',
        status: 'sanctioned',
        evidence: [],
      }),
    );
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ProjectFunded',
        occurredAt: new Date(NOW),
        payload: expect.objectContaining({
          projectId: PROJECT_ID,
          villageId: VILLAGE_ID,
          sanctionedMinor: 1_000_000,
          currency: 'INR',
          fundingSource: 'district',
        }),
      }),
    ]);
  });

  it('FR-FM-1: stamps sanctionedAt from the injected Clock', async () => {
    const result = await useCase.execute(command);

    expect(unwrap(result).sanctionedAt).toEqual(new Date(NOW));
    expect(unwrap(result).expectedCompletionAt).toEqual(EXPECTED_COMPLETION_AT);
  });

  it('FR-FM-1: rejects a duplicate project id without saving or publishing', async () => {
    projects.findById.mockResolvedValue(aProject());

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_ALREADY_EXISTS');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects a non-positive sanctioned budget without touching the repository', async () => {
    const result = await useCase.execute({ ...command, sanctionedAmountMinor: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SANCTIONED_NOT_POSITIVE');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects a negative sanctioned budget', async () => {
    const result = await useCase.execute({ ...command, sanctionedAmountMinor: -5 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MONEY_NEGATIVE');
    expect(projects.findById).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects a non-integer sanctioned budget (minor units only)', async () => {
    const result = await useCase.execute({ ...command, sanctionedAmountMinor: 100.5 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MONEY_NOT_INTEGER');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects an unknown project category at the boundary', async () => {
    const result = await useCase.execute({ ...command, category: 'spaceport' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_CATEGORY');
    expect(projects.findById).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects an unknown funding source at the boundary', async () => {
    const result = await useCase.execute({ ...command, fundingSource: 'crypto' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_FUNDING_SOURCE');
    expect(projects.findById).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects a blank title', async () => {
    const result = await useCase.execute({ ...command, title: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NEEDS_TITLE');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects an expected completion date not after sanction', async () => {
    const result = await useCase.execute({ ...command, expectedCompletionAt: new Date(NOW) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_BAD_COMPLETION_DATE');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects a malformed project id', async () => {
    const result = await useCase.execute({ ...command, projectId: 'project-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT_ID');
    expect(projects.findById).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects a malformed village id', async () => {
    const result = await useCase.execute({ ...command, villageId: 'village-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_VILLAGE_ID');
    expect(projects.findById).not.toHaveBeenCalled();
  });

  it('FR-FM-1: rejects an invalid currency code', async () => {
    const result = await useCase.execute({ ...command, currency: 'rupees' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MONEY_BAD_CURRENCY');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-1: publishes only after the project is persisted', async () => {
    const order: string[] = [];
    projects.save.mockImplementation(async () => {
      order.push('save');
    });
    events.publish.mockImplementation(async () => {
      order.push('publish');
    });

    await useCase.execute(command);

    expect(order).toEqual(['save', 'publish']);
  });
});
