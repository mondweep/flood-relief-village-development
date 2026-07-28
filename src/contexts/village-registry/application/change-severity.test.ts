import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap, type VillageId } from '../../../shared/index.js';
import { createVillage, type Village } from '../domain/village.js';
import { demographics } from '../domain/demographics.js';
import { changeSeverity, type ChangeSeverityDeps, type ChangeSeverityInput } from './change-severity.js';

// London School: mock the ports, verify collaborations (ADR-004).
describe('ChangeSeverity use case', () => {
  const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;
  const registeredAt = new Date('2026-07-28T08:00:00.000Z');
  const changedAt = new Date('2026-07-29T09:00:00.000Z');

  const existingVillage = unwrap(
    createVillage({
      id: villageId,
      name: 'Majuli',
      district: 'Jorhat',
      location: { lat: 26.2, lng: 92.9 },
      demographics: unwrap(demographics({ population: 500, households: 100, affectedFamilies: 40 })),
      at: registeredAt,
    }),
  );

  function createDeps(found: Village | null = existingVillage): ChangeSeverityDeps {
    return {
      repository: { findById: vi.fn().mockResolvedValue(found), save: vi.fn().mockResolvedValue(undefined) },
      publisher: { publish: vi.fn().mockResolvedValue(undefined) },
      clock: { now: vi.fn().mockReturnValue(changedAt) },
    };
  }

  it('FR-VR-3: saves the audit history and publishes SeverityChanged', async () => {
    const deps = createDeps();
    const input: ChangeSeverityInput = { villageId, to: 'severe', reason: 'flash flood overnight' };

    const result = await changeSeverity(input, deps);

    expect(result.ok).toBe(true);
    expect(deps.repository.findById).toHaveBeenCalledWith(villageId);
    expect(deps.repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: villageId,
        severity: 'severe',
        severityHistory: [{ from: 'unaffected', to: 'severe', reason: 'flash flood overnight', at: changedAt }],
      }),
    );
    expect(deps.publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'SeverityChanged',
        occurredAt: changedAt,
        payload: { villageId, from: 'unaffected', to: 'severe', reason: 'flash flood overnight' },
      }),
    ]);
  });

  it('FR-VR-3: rejects severity change without reason and does not save or publish', async () => {
    const deps = createDeps();
    const input: ChangeSeverityInput = { villageId, to: 'severe', reason: '' };

    const result = await changeSeverity(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SEVERITY_REASON_REQUIRED');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VR-3: rejects an unrecognised severity level and does not save or publish', async () => {
    const deps = createDeps();
    const input: ChangeSeverityInput = { villageId, to: 'catastrophic' as ChangeSeverityInput['to'], reason: 'test' };

    const result = await changeSeverity(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SEVERITY_INVALID');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VR-3: rejects changing severity of an unknown village and does not save or publish', async () => {
    const deps = createDeps(null);
    const input: ChangeSeverityInput = { villageId, to: 'severe', reason: 'flash flood overnight' };

    const result = await changeSeverity(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VILLAGE_NOT_FOUND');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });
});
