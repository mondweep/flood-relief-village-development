import { describe, expect, it } from 'vitest';
import { asId, unwrap } from '../../../shared/index.js';
import { createAssignment, isActive, releaseAssignment } from './village-assignment.js';

// Pure aggregate logic: state-based assertions apply (ADR-004 §5).
const id = asId<'AssignmentId'>('30000000-0000-4000-8000-000000000001');
const village = asId<'VillageId'>('20000000-0000-4000-8000-000000000001');
const ngo = asId<'NgoId'>('10000000-0000-4000-8000-000000000001');
const assignedAt = new Date('2026-07-01T00:00:00.000Z');
const releasedAt = new Date('2026-07-20T00:00:00.000Z');

const active = () => createAssignment({ id, villageId: village, ngoId: ngo, assignedAt });

describe('VillageAssignment aggregate', () => {
  it('FR-NC-2: a new assignment is active with no release information', () => {
    expect(active()).toEqual({
      id,
      villageId: village,
      ngoId: ngo,
      status: 'active',
      assignedAt,
      releasedAt: null,
      releaseReason: null,
    });
    expect(isActive(active())).toBe(true);
  });

  it('FR-NC-3: releasing records the trimmed reason and the release time', () => {
    const released = unwrap(releaseAssignment(active(), '  capacity exceeded  ', releasedAt));

    expect(released.status).toBe('released');
    expect(released.releaseReason).toBe('capacity exceeded');
    expect(released.releasedAt).toBe(releasedAt);
    expect(isActive(released)).toBe(false);
  });

  it('FR-NC-3: releasing does not mutate the original assignment', () => {
    const original = active();

    unwrap(releaseAssignment(original, 'withdrawal', releasedAt));

    expect(original.status).toBe('active');
    expect(original.releaseReason).toBeNull();
  });

  it.each(['', '   ', '\n'])('FR-NC-3: rejects release with reason %j', (reason: string) => {
    const result = releaseAssignment(active(), reason, releasedAt);

    expect(!result.ok && result.error.code).toBe('RELEASE_REASON_REQUIRED');
  });

  it('FR-NC-3: an already released assignment cannot be released again', () => {
    const released = unwrap(releaseAssignment(active(), 'withdrawal', releasedAt));

    const result = releaseAssignment(released, 'another reason', releasedAt);

    expect(!result.ok && result.error.code).toBe('ASSIGNMENT_NOT_ACTIVE');
  });
});
