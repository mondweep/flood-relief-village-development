import { describe, expect, it } from 'vitest';
import { NGO_REGISTERED, NGO_VERIFIED } from '../domain/events.js';
import { registerNgoUseCase, verifyNgoUseCase } from './register-ngo.js';
import {
  NOW,
  anNgo,
  clockStub,
  eventPublisherMock,
  idGeneratorStub,
  ngoId,
  ngoRepositoryMock,
  publishedEvents,
} from './test-doubles.js';

const makeRegisterDeps = () => {
  const ngos = ngoRepositoryMock();
  const events = eventPublisherMock();
  return { ngos, events, clock: clockStub(), ids: idGeneratorStub(ngoId(7)) };
};

const makeVerifyDeps = () => {
  const ngos = ngoRepositoryMock();
  const events = eventPublisherMock();
  return { ngos, events, clock: clockStub() };
};

describe('RegisterNgo (FR-NC-1)', () => {
  it('FR-NC-1: saves an unverified NGO with its declared capacity and publishes NgoRegistered', async () => {
    const deps = makeRegisterDeps();

    const result = await registerNgoUseCase(deps)({ name: 'Assam Relief Trust', capacity: 4 });

    expect(result.ok).toBe(true);
    expect(deps.ngos.save).toHaveBeenCalledTimes(1);
    expect(deps.ngos.save).toHaveBeenCalledWith({
      id: ngoId(7),
      name: 'Assam Relief Trust',
      capacity: 4,
      verified: false,
    });
    expect(deps.events.publish).toHaveBeenCalledTimes(1);
    expect(publishedEvents(deps.events)).toEqual([
      {
        type: NGO_REGISTERED,
        occurredAt: NOW,
        payload: { ngoId: ngoId(7), name: 'Assam Relief Trust', capacity: 4 },
      },
    ]);
  });

  it('FR-NC-1: returns the generated NGO id to the caller', async () => {
    const deps = makeRegisterDeps();

    const result = await registerNgoUseCase(deps)({ name: 'Brahmaputra Aid', capacity: 1 });

    expect(result.ok && result.value.ngoId).toBe(ngoId(7));
  });

  it('FR-NC-1: rejects a blank name without touching the repository or the publisher', async () => {
    const deps = makeRegisterDeps();

    const result = await registerNgoUseCase(deps)({ name: '   ', capacity: 2 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NGO_NAME_REQUIRED');
    expect(deps.ngos.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it.each([0, -1, 2.5])(
    'FR-NC-1: rejects capacity %s without saving',
    async (capacity: number) => {
      const deps = makeRegisterDeps();

      const result = await registerNgoUseCase(deps)({ name: 'Relief Now', capacity });

      expect(!result.ok && result.error.code).toBe('NGO_CAPACITY_INVALID');
      expect(deps.ngos.save).not.toHaveBeenCalled();
      expect(deps.events.publish).not.toHaveBeenCalled();
    },
  );
});

describe('VerifyNgo (FR-NC-1)', () => {
  it('FR-NC-1: saves the NGO as verified and publishes NgoVerified', async () => {
    const deps = makeVerifyDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ verified: false }));

    const result = await verifyNgoUseCase(deps)({ ngoId: ngoId(1) });

    expect(result.ok).toBe(true);
    expect(deps.ngos.findById).toHaveBeenCalledWith(ngoId(1));
    expect(deps.ngos.save).toHaveBeenCalledWith(expect.objectContaining({ verified: true }));
    expect(publishedEvents(deps.events)).toEqual([
      { type: NGO_VERIFIED, occurredAt: NOW, payload: { ngoId: ngoId(1) } },
    ]);
  });

  it('FR-NC-1: rejects an unknown NGO without saving or publishing', async () => {
    const deps = makeVerifyDeps();
    deps.ngos.findById.mockResolvedValue(null);

    const result = await verifyNgoUseCase(deps)({ ngoId: ngoId(1) });

    expect(!result.ok && result.error.code).toBe('NGO_NOT_FOUND');
    expect(deps.ngos.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-1: rejects re-verifying an already verified NGO (no duplicate NgoVerified event)', async () => {
    const deps = makeVerifyDeps();
    deps.ngos.findById.mockResolvedValue(anNgo({ verified: true }));

    const result = await verifyNgoUseCase(deps)({ ngoId: ngoId(1) });

    expect(!result.ok && result.error.code).toBe('NGO_ALREADY_VERIFIED');
    expect(deps.ngos.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });
});
