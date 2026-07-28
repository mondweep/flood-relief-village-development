import { err, ok, type NgoId, type Result } from '../../../shared/index.js';

/**
 * BC-2 aggregate: an NGO that can be assigned as the single lead of villages.
 * `capacity` is the maximum number of *concurrently active* village assignments (FR-NC-4).
 */
export interface Ngo {
  readonly id: NgoId;
  readonly name: string;
  readonly capacity: number;
  readonly verified: boolean;
}

export interface RegisterNgoInput {
  readonly id: NgoId;
  readonly name: string;
  readonly capacity: number;
}

/** FR-NC-1: register an NGO with a declared capacity; it starts unverified. */
export function registerNgo(input: RegisterNgoInput): Result<Ngo> {
  const name = input.name.trim();
  if (name.length === 0) {
    return err('NGO_NAME_REQUIRED', 'an NGO must have a name');
  }
  if (!Number.isInteger(input.capacity) || input.capacity < 1) {
    return err(
      'NGO_CAPACITY_INVALID',
      'capacity must be a positive whole number of concurrent village assignments',
    );
  }
  return ok({ id: input.id, name, capacity: input.capacity, verified: false });
}

/** FR-NC-1: verification is a one-way transition performed by the district admin. */
export function verifyNgo(ngo: Ngo): Result<Ngo> {
  if (ngo.verified) {
    return err('NGO_ALREADY_VERIFIED', `NGO ${ngo.id} is already verified`);
  }
  return ok({ ...ngo, verified: true });
}

/** FR-NC-4: capacity is measured against currently active assignments only. */
export function hasCapacityFor(ngo: Ngo, activeAssignments: number): boolean {
  return activeAssignments < ngo.capacity;
}
