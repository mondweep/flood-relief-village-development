import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap } from '../../../shared/index.js';
import { Beneficiary } from '../domain/beneficiary.js';
import type { BeneficiaryRepository } from './ports.js';
import { FindOverdueFollowUps } from './find-overdue-follow-ups.js';

const villageId = asId<'VillageId'>('4a9f0b2d-3c5e-4f70-9b1c-2d3e4f5a6b7c');

function widowWithFollowUp(id: string, nextFollowUpAt: Date) {
  const widow = unwrap(
    Beneficiary.register({
      id: asId<'BeneficiaryId'>(id),
      villageId,
      categories: ['widow'],
      registeredAt: new Date('2026-06-01T00:00:00Z'),
    }),
  );
  // interval of 0 days pins nextFollowUpAt exactly to the given date.
  return widow.completeFollowUp(nextFollowUpAt, 0);
}

function buildCollaborators(scheduled: readonly Beneficiary[]) {
  const repository: BeneficiaryRepository = {
    findById: vi.fn(),
    save: vi.fn(),
    findAllWithScheduledFollowUp: vi.fn().mockResolvedValue(scheduled),
  };
  const now = new Date('2026-07-28T00:00:00Z');
  const clock = { now: vi.fn().mockReturnValue(now) };
  return { repository, clock, now };
}

// London School: verify collaboration; overdue filtering itself is pure domain logic (see beneficiary.test.ts).
describe('FindOverdueFollowUps (FR-BR-4)', () => {
  it('FR-BR-4: returns only beneficiaries whose nextFollowUpAt is before the clock time', async () => {
    const overdue = widowWithFollowUp('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b', new Date('2026-07-01T00:00:00Z'));
    const notYetDue = widowWithFollowUp('4f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6c', new Date('2026-08-01T00:00:00Z'));
    const { repository, clock } = buildCollaborators([overdue, notYetDue]);
    const useCase = new FindOverdueFollowUps(repository, clock);

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.overdue).toEqual([overdue]);
    expect(repository.findAllWithScheduledFollowUp).toHaveBeenCalledTimes(1);
  });

  it('FR-BR-4: is side-effect free — no publisher is invoked, it only returns the list', async () => {
    const overdue = widowWithFollowUp('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b', new Date('2026-07-01T00:00:00Z'));
    const { repository, clock } = buildCollaborators([overdue]);
    const useCase = new FindOverdueFollowUps(repository, clock);

    await useCase.execute();

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('FR-BR-4: uses the injected Clock, never wall-clock time', async () => {
    const { repository, clock } = buildCollaborators([]);
    const useCase = new FindOverdueFollowUps(repository, clock);

    await useCase.execute();

    expect(clock.now).toHaveBeenCalledTimes(1);
  });
});
