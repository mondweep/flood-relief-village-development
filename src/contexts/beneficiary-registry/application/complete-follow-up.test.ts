import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap } from '../../../shared/index.js';
import { Beneficiary } from '../domain/beneficiary.js';
import type { BeneficiaryRepository } from './ports.js';
import { CompleteFollowUp } from './complete-follow-up.js';

const VALID_ID = '3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
const villageId = asId<'VillageId'>('4a9f0b2d-3c5e-4f70-9b1c-2d3e4f5a6b7c');
const beneficiaryId = asId<'BeneficiaryId'>(VALID_ID);

function registeredWidow() {
  return unwrap(
    Beneficiary.register({
      id: beneficiaryId,
      villageId,
      categories: ['widow'],
      registeredAt: new Date('2026-07-01T00:00:00Z'),
    }),
  );
}

function buildCollaborators(existing: Beneficiary | undefined) {
  const repository: BeneficiaryRepository = {
    findById: vi.fn().mockResolvedValue(existing),
    save: vi.fn().mockResolvedValue(undefined),
    findAllWithScheduledFollowUp: vi.fn(),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const now = new Date('2026-07-28T00:00:00Z');
  const clock = { now: vi.fn().mockReturnValue(now) };

  return { repository, publisher, clock, now };
}

// London School: verify collaboration, not persisted state (ADR-004 §2).
describe('CompleteFollowUp (FR-BR-4)', () => {
  it('FR-BR-4: reschedules the next follow-up for a mandatory category and publishes FollowUpCompleted', async () => {
    const widow = registeredWidow();
    const { repository, publisher, clock, now } = buildCollaborators(widow);
    const useCase = new CompleteFollowUp(repository, publisher, clock, 30);

    const result = await useCase.execute({ beneficiaryId: VALID_ID });

    expect(result.ok).toBe(true);
    const expectedNext = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (result.ok) expect(result.value.nextFollowUpAt).toEqual(expectedNext);

    const saved = vi.mocked(repository.save).mock.calls[0]?.[0];
    expect(saved?.nextFollowUpAt).toEqual(expectedNext);

    expect(publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'FollowUpCompleted',
        payload: expect.objectContaining({ beneficiaryId, completedAt: now, nextFollowUpAt: expectedNext }),
      }),
    ]);
  });

  it('FR-BR-4: rejects an unknown beneficiary without saving or publishing', async () => {
    const { repository, publisher, clock } = buildCollaborators(undefined);
    const useCase = new CompleteFollowUp(repository, publisher, clock);

    const result = await useCase.execute({ beneficiaryId: VALID_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BENEFICIARY_NOT_FOUND');
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-BR-4: uses the injected Clock, never wall-clock time', async () => {
    const widow = registeredWidow();
    const { repository, publisher, clock } = buildCollaborators(widow);
    const useCase = new CompleteFollowUp(repository, publisher, clock);

    await useCase.execute({ beneficiaryId: VALID_ID });

    expect(clock.now).toHaveBeenCalledTimes(1);
  });
});
