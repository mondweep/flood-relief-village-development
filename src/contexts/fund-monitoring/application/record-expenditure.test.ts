import { beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { totalSpent } from '../domain/index.js';
import { makeRecordExpenditure } from './record-expenditure.js';
import {
  PROJECT_ID,
  aProject,
  asProjectRepository,
  fixedClock,
  mockEventPublisher,
  mockProjectRepository,
  withReleased,
  withSpent,
} from '../test-support.js';

const NOW = '2026-03-01T00:00:00.000Z';

describe('FR-FM-2 RecordExpenditure (ledger ordering: spent <= released)', () => {
  let projects: ReturnType<typeof mockProjectRepository>;
  let events: ReturnType<typeof mockEventPublisher>;
  let useCase: ReturnType<typeof makeRecordExpenditure>;

  const command = {
    projectId: PROJECT_ID as string,
    amountMinor: 200_000,
    currency: 'INR',
    description: 'Aggregate and bitumen purchase',
  };

  beforeEach(() => {
    projects = mockProjectRepository();
    events = mockEventPublisher();
    projects.findById.mockResolvedValue(withReleased(aProject(), 500_000));
    useCase = makeRecordExpenditure({
      projects: asProjectRepository(projects),
      events,
      clock: fixedClock(NOW),
    });
  });

  it('FR-FM-2: records an expenditure within released funds and publishes ExpenditureRecorded', async () => {
    const result = await useCase.execute(command);

    expect(result.ok).toBe(true);
    expect(totalSpent(unwrap(result).ledger).amountMinor).toBe(200_000);
    expect(projects.save).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ExpenditureRecorded',
        occurredAt: new Date(NOW),
        payload: expect.objectContaining({
          projectId: PROJECT_ID,
          amountMinor: 200_000,
          currency: 'INR',
          description: 'Aggregate and bitumen purchase',
          totalSpentMinor: 200_000,
        }),
      }),
    ]);
  });

  it('FR-FM-2: allows spending exactly the released amount', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 500_000 });

    expect(result.ok).toBe(true);
    expect(projects.save).toHaveBeenCalledTimes(1);
  });

  it('FR-FM-2: rejects spending more than released (SPEND_EXCEEDS_RELEASED)', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 500_001 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPEND_EXCEEDS_RELEASED');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a cumulative spend exceeding released', async () => {
    projects.findById.mockResolvedValue(withSpent(withReleased(aProject(), 500_000), 400_000));

    const result = await useCase.execute({ ...command, amountMinor: 100_001 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPEND_EXCEEDS_RELEASED');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: accepts a further expenditure while cumulative spend stays within released', async () => {
    projects.findById.mockResolvedValue(withSpent(withReleased(aProject(), 500_000), 400_000));

    const result = await useCase.execute({ ...command, amountMinor: 100_000 });

    expect(result.ok).toBe(true);
    expect(totalSpent(unwrap(result).ledger).amountMinor).toBe(500_000);
  });

  it('FR-FM-2: rejects any expenditure when nothing has been released yet', async () => {
    projects.findById.mockResolvedValue(aProject());

    const result = await useCase.execute({ ...command, amountMinor: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPEND_EXCEEDS_RELEASED');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects an expenditure without a description', async () => {
    const result = await useCase.execute({ ...command, description: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXPENDITURE_NEEDS_DESCRIPTION');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a zero expenditure amount', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AMOUNT_NOT_POSITIVE');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects a non-integer expenditure amount', async () => {
    const result = await useCase.execute({ ...command, amountMinor: 12.5 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MONEY_NOT_INTEGER');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects an expenditure in a different currency', async () => {
    const result = await useCase.execute({ ...command, currency: 'USD' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CURRENCY_MISMATCH');
    expect(projects.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects an expenditure against an unknown project', async () => {
    projects.findById.mockResolvedValue(null);

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: rejects an expenditure against a completed project', async () => {
    projects.findById.mockResolvedValue(
      aProject({ status: 'completed', completedAt: new Date(NOW) }),
    );

    const result = await useCase.execute(command);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROJECT_ALREADY_COMPLETED');
    expect(projects.save).not.toHaveBeenCalled();
  });

  it('FR-FM-2: keeps expenditures append-only (prior entries preserved)', async () => {
    projects.findById.mockResolvedValue(withSpent(withReleased(aProject(), 500_000), 100_000, 'gravel'));

    const result = await useCase.execute({ ...command, amountMinor: 50_000 });

    const ledger = unwrap(result).ledger;
    expect(ledger.expenditures).toHaveLength(2);
    expect(ledger.expenditures[0]?.description).toBe('gravel');
    expect(ledger.expenditures[1]?.description).toBe('Aggregate and bitumen purchase');
  });
});
