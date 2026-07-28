import { beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { totalReleased } from '../domain/index.js';
import { makeReleaseFunds } from './release-funds.js';
import {
  PROJECT_ID,
  aProject,
  asProjectRepository,
  fixedClock,
  mockEventPublisher,
  mockProjectRepository,
  withReleased,
} from '../test-support.js';

const NOW = '2026-02-01T00:00:00.000Z';

describe('FR-FM-2 ReleaseFunds (ledger ordering: released <= sanctioned)', () => {
  let projects: ReturnType<typeof mockProjectRepository>;
  let events: ReturnType<typeof mockEventPublisher>;
  let useCase: ReturnType<typeof makeReleaseFunds>;

  const command = { projectId: PROJECT_ID as string, amountMinor: 400_000, currency: 'INR' };

  beforeEach(() => {
    projects = mockProjectRepository();
    events = mockEventPublisher();
    projects.findById.mockResolvedValue(aProject());
    useCase = makeReleaseFunds({
      projects: asProjectRepository(projects),
      events,
      clock: fixedClock(NOW),
    });
  });

  it('FR-FM-2: releases funds within the sanctioned budget and publishes FundsReleased', async () => {
    const result = await useCase.execute(command);

    expect(result.ok).toBe(true);
    expect(projects.findById).toHaveBeenCalledWith(PROJECT_ID);
    expect(projects.save).toHaveBeenCalledTimes(1);
    expect(totalReleased(unwrap(result).ledger).amountMinor).toBe(400_000);
    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'FundsReleased',
        occurredAt: new Date(NOW),
        payload: expect.objectContaining({
          projectId: PROJECT_ID,
          amountMinor: 400_000,
          currency: 'INR',
          totalReleasedMinor: 400_000,
        }),
      }),
    ]);
  });

  it('FR-FM-2: moves a sanctioned project to in_progress on first release', async () => {
    const result = await useCase.execute(command);

    expect(unwrap(result).status).toBe('in_progress');
    expect(projects.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress' }));
  });

  it('FR-FM-2: allows a release that exactly exhausts the sanctioned budget', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 1_000_000 });

    expect(result.ok).toBe(true);
    expect(projects.save).toHaveBeenCalledTimes(1);
  });

  it('FR-FM-2: rejects a single release exceeding sanctioned (RELEASE_EXCEEDS_SANCTIONED)', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 1_000_001 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RELEASE_EXCEEDS_SANCTIONED');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a release whose cumulative total exceeds sanctioned', async () => {
    projects.findById.mockResolvedValue(withReleased(aProject(), 700_000));

    const result = await useCase.execute({ ...command, amountMinor: 300_001 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RELEASE_EXCEEDS_SANCTIONED');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: accepts a further release while cumulative stays within sanctioned', async () => {
    projects.findById.mockResolvedValue(withReleased(aProject(), 700_000));

    const result = await useCase.execute({ ...command, amountMinor: 300_000 });

    expect(result.ok).toBe(true);
    expect(totalReleased(unwrap(result).ledger).amountMinor).toBe(1_000_000);
    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({ payload: expect.objectContaining({ totalReleasedMinor: 1_000_000 }) }),
    ]);
  });

  it('FR-FM-2: rejects a currency that does not match the sanctioned budget', async () => {
    const result = await useCase.execute({ ...command, currency: 'USD' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CURRENCY_MISMATCH');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a zero release amount', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AMOUNT_NOT_POSITIVE');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a negative release amount', async () => {
    const result = await useCase.execute({ ...command, amountMinor: -1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MONEY_NEGATIVE');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a non-integer release amount', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 10.25 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MONEY_NOT_INTEGER');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a release against an unknown project', async () => {
    projects.findById.mockResolvedValue(null);

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a release against a completed project', async () => {
    projects.findById.mockResolvedValue(aProject({ status: 'completed', completedAt: new Date(NOW) }));

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_ALREADY_COMPLETED');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a malformed project id before hitting the repository', async () => {
    const result = await useCase.execute({ ...command, projectId: 'not-a-uuid' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT_ID');
    expect(projects.findById).not.toHaveBeenCalled();
  });
});
