import { describe, expect, it } from 'vitest';
import { asId, unwrap } from '../../../shared/index.js';
import { hasCapacityFor, registerNgo, verifyNgo } from './ngo.js';

// Pure aggregate logic: no collaborators, so state-based assertions apply (ADR-004 §5).
const id = asId<'NgoId'>('10000000-0000-4000-8000-000000000001');

describe('Ngo aggregate', () => {
  it('FR-NC-1: a registered NGO starts unverified with its trimmed name and capacity', () => {
    const ngo = unwrap(registerNgo({ id, name: '  Assam Relief Trust  ', capacity: 5 }));

    expect(ngo).toEqual({ id, name: 'Assam Relief Trust', capacity: 5, verified: false });
  });

  it('FR-NC-1: registration requires a name', () => {
    const result = registerNgo({ id, name: '', capacity: 1 });

    expect(!result.ok && result.error.code).toBe('NGO_NAME_REQUIRED');
  });

  it.each([0, -3, 1.5, Number.NaN])('FR-NC-1: rejects capacity %s', (capacity: number) => {
    const result = registerNgo({ id, name: 'Relief Now', capacity });

    expect(!result.ok && result.error.code).toBe('NGO_CAPACITY_INVALID');
  });

  it('FR-NC-1: verification flips the verified flag without mutating the original', () => {
    const ngo = unwrap(registerNgo({ id, name: 'Relief Now', capacity: 2 }));

    const verified = unwrap(verifyNgo(ngo));

    expect(verified.verified).toBe(true);
    expect(ngo.verified).toBe(false);
  });

  it('FR-NC-1: verifying twice is rejected', () => {
    const verified = unwrap(verifyNgo(unwrap(registerNgo({ id, name: 'X', capacity: 1 }))));

    const result = verifyNgo(verified);

    expect(!result.ok && result.error.code).toBe('NGO_ALREADY_VERIFIED');
  });

  it('FR-NC-4: capacity is exhausted once active assignments reach the declared limit', () => {
    const ngo = unwrap(registerNgo({ id, name: 'Relief Now', capacity: 2 }));

    expect(hasCapacityFor(ngo, 0)).toBe(true);
    expect(hasCapacityFor(ngo, 1)).toBe(true);
    expect(hasCapacityFor(ngo, 2)).toBe(false);
    expect(hasCapacityFor(ngo, 3)).toBe(false);
  });
});
