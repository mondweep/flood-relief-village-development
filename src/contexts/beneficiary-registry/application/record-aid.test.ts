import { describe, expect, it, vi } from 'vitest';
import { type DomainEvent, asId, unwrap } from '../../../shared/index.js';
import { Beneficiary } from '../domain/beneficiary.js';
import type { BeneficiaryRepository } from './ports.js';
import { RecordAid } from './record-aid.js';

const VALID_ID = '3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b';
const villageId = asId<'VillageId'>('4a9f0b2d-3c5e-4f70-9b1c-2d3e4f5a6b7c');
const beneficiaryId = asId<'BeneficiaryId'>(VALID_ID);

function registeredBeneficiary(categories: readonly ('farmer' | 'widow')[] = ['farmer']) {
  return unwrap(
    Beneficiary.register({
      id: beneficiaryId,
      villageId,
      categories,
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
describe('RecordAid (FR-BR-2, FR-BR-3)', () => {
  it('FR-BR-2: looks up the beneficiary, saves the appended history and publishes AidRecorded', async () => {
    const beneficiary = registeredBeneficiary();
    const { repository, publisher, clock, now } = buildCollaborators(beneficiary);
    const useCase = new RecordAid(repository, publisher, clock);

    const result = await useCase.execute({ beneficiaryId: VALID_ID, kind: 'food', providerName: 'Red Cross' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.duplicateSuspected).toBe(false);

    expect(repository.findById).toHaveBeenCalledWith(VALID_ID);
    const saved = vi.mocked(repository.save).mock.calls[0]?.[0];
    expect(saved?.aidHistory).toEqual([{ kind: 'food', providerName: 'Red Cross', at: now }]);

    expect(publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'AidRecorded' }),
    ]);
  });

  it('FR-BR-3: same kind within the suspicion window also publishes DuplicateAidSuspected but keeps the record', async () => {
    const priorAid = { kind: 'food', providerName: 'Red Cross', at: new Date('2026-07-25T00:00:00Z') };
    const beneficiaryWithHistory = registeredBeneficiary().recordAid(priorAid).beneficiary;
    const { repository, publisher, clock } = buildCollaborators(beneficiaryWithHistory);
    const useCase = new RecordAid(repository, publisher, clock);

    const result = await useCase.execute({ beneficiaryId: VALID_ID, kind: 'food', providerName: 'Other NGO' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.duplicateSuspected).toBe(true);

    const saved = vi.mocked(repository.save).mock.calls[0]?.[0];
    expect(saved?.aidHistory).toHaveLength(2);

    const published: readonly DomainEvent[] = vi.mocked(publisher.publish).mock.calls[0]?.[0] ?? [];
    expect(published.map((event) => event.type)).toEqual(['AidRecorded', 'DuplicateAidSuspected']);
    const duplicateEvent = published.find((event) => event.type === 'DuplicateAidSuspected');
    expect(duplicateEvent?.payload).toEqual(
      expect.objectContaining({ beneficiaryId, newAid: expect.objectContaining({ kind: 'food' }), existingAid: priorAid }),
    );
  });

  it('FR-BR-3: different kind or outside window publishes only AidRecorded, no alert', async () => {
    const priorAid = { kind: 'food', providerName: 'Red Cross', at: new Date('2026-07-01T00:00:00Z') };
    const beneficiaryWithHistory = registeredBeneficiary().recordAid(priorAid).beneficiary;
    const { repository, publisher, clock } = buildCollaborators(beneficiaryWithHistory);
    const useCase = new RecordAid(repository, publisher, clock);

    const result = await useCase.execute({ beneficiaryId: VALID_ID, kind: 'medical', providerName: 'Other NGO' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.duplicateSuspected).toBe(false);
    const published: readonly DomainEvent[] = vi.mocked(publisher.publish).mock.calls[0]?.[0] ?? [];
    expect(published.map((event) => event.type)).toEqual(['AidRecorded']);
  });

  it('FR-BR-2: rejects an unknown beneficiary without saving or publishing', async () => {
    const { repository, publisher, clock } = buildCollaborators(undefined);
    const useCase = new RecordAid(repository, publisher, clock);

    const result = await useCase.execute({ beneficiaryId: VALID_ID, kind: 'food', providerName: 'Red Cross' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BENEFICIARY_NOT_FOUND');
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-BR-2: uses the injected Clock for the aid timestamp, never wall-clock time', async () => {
    const beneficiary = registeredBeneficiary();
    const { repository, publisher, clock, now } = buildCollaborators(beneficiary);
    const useCase = new RecordAid(repository, publisher, clock);

    await useCase.execute({ beneficiaryId: VALID_ID, kind: 'food', providerName: 'Red Cross' });

    expect(clock.now).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(repository.save).mock.calls[0]?.[0];
    expect(saved?.aidHistory[0]?.at).toEqual(now);
  });
});
