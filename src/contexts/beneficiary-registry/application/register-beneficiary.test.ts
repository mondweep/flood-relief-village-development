import { describe, expect, it, vi } from 'vitest';
import type { BeneficiaryRepository } from './ports.js';
import { RegisterBeneficiary } from './register-beneficiary.js';

const VALID_ID = '3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
const VALID_VILLAGE_ID = '4a9f0b2d-3c5e-4f70-9b1c-2d3e4f5a6b7c';

function buildCollaborators() {
  const repository: BeneficiaryRepository = {
    findById: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    findAllWithScheduledFollowUp: vi.fn(),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const now = new Date('2026-07-28T00:00:00Z');
  const clock = { now: vi.fn().mockReturnValue(now) };

  return { repository, publisher, clock, now };
}

// London School: verify collaboration, not persisted state (ADR-004 §2).
describe('RegisterBeneficiary (FR-BR-1)', () => {
  it('FR-BR-1: saves the beneficiary and publishes BeneficiaryRegistered', async () => {
    const { repository, publisher, clock, now } = buildCollaborators();
    const useCase = new RegisterBeneficiary(repository, publisher, clock);

    const result = await useCase.execute({
      id: VALID_ID,
      villageId: VALID_VILLAGE_ID,
      categories: ['widow'],
    });

    expect(result.ok).toBe(true);
    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(repository.save).mock.calls[0]?.[0];
    expect(saved?.id).toBe(VALID_ID);
    expect(saved?.villageId).toBe(VALID_VILLAGE_ID);
    expect(saved?.categories).toEqual(['widow']);

    expect(publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'BeneficiaryRegistered',
        occurredAt: now,
        payload: expect.objectContaining({ beneficiaryId: VALID_ID, villageId: VALID_VILLAGE_ID }),
      }),
    ]);
  });

  it('FR-BR-1: rejects registration with zero categories and does not touch collaborators', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new RegisterBeneficiary(repository, publisher, clock);

    const result = await useCase.execute({ id: VALID_ID, villageId: VALID_VILLAGE_ID, categories: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BENEFICIARY_NO_CATEGORY');
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-BR-1: rejects an unknown vulnerability category before touching collaborators', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new RegisterBeneficiary(repository, publisher, clock);

    const result = await useCase.execute({
      id: VALID_ID,
      villageId: VALID_VILLAGE_ID,
      categories: ['millionaire'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BENEFICIARY_INVALID_CATEGORY');
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-BR-1: rejects a malformed beneficiary or village id', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new RegisterBeneficiary(repository, publisher, clock);

    const badId = await useCase.execute({ id: 'not-a-uuid', villageId: VALID_VILLAGE_ID, categories: ['farmer'] });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe('BENEFICIARY_INVALID_ID');

    const badVillage = await useCase.execute({ id: VALID_ID, villageId: 'not-a-uuid', categories: ['farmer'] });
    expect(badVillage.ok).toBe(false);
    if (!badVillage.ok) expect(badVillage.error.code).toBe('BENEFICIARY_INVALID_VILLAGE_ID');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('FR-BR-1: uses the injected Clock for registeredAt, never wall-clock time', async () => {
    const { repository, publisher, clock, now } = buildCollaborators();
    const useCase = new RegisterBeneficiary(repository, publisher, clock);

    await useCase.execute({ id: VALID_ID, villageId: VALID_VILLAGE_ID, categories: ['farmer'] });

    expect(clock.now).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(repository.save).mock.calls[0]?.[0];
    expect(saved?.registeredAt).toEqual(now);
  });
});
