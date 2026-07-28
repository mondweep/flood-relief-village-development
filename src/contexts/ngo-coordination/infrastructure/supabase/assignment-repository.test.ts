import { describe, expect, it } from 'vitest';
import { asId, type AssignmentId, type NgoId, type VillageId } from '../../../../shared/index.js';
import type { VillageAssignment } from '../../domain/village-assignment.js';
import { fromAssignmentRow, toAssignmentRow, type AssignmentRow } from './assignment-repository.js';

const assignmentId = (): AssignmentId => asId<'AssignmentId'>('30000000-0000-4000-8000-000000000001');
const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');
const ngoId = (): NgoId => asId<'NgoId'>('10000000-0000-4000-8000-000000000001');

describe('toAssignmentRow / fromAssignmentRow', () => {
  it('round-trips an active assignment', () => {
    const assignment: VillageAssignment = {
      id: assignmentId(),
      villageId: villageId(),
      ngoId: ngoId(),
      status: 'active',
      assignedAt: new Date('2026-07-28T09:00:00.000Z'),
      releasedAt: null,
      releaseReason: null,
    };

    const row: AssignmentRow = toAssignmentRow(assignment);
    expect(row).toEqual({
      id: assignmentId(),
      village_id: villageId(),
      ngo_id: ngoId(),
      status: 'active',
      assigned_at: '2026-07-28T09:00:00.000Z',
      released_at: null,
      release_reason: null,
    });
    expect(fromAssignmentRow(row)).toEqual(assignment);
  });

  it('round-trips a released assignment with its reason', () => {
    const assignment: VillageAssignment = {
      id: assignmentId(),
      villageId: villageId(),
      ngoId: ngoId(),
      status: 'released',
      assignedAt: new Date('2026-07-01T00:00:00.000Z'),
      releasedAt: new Date('2026-07-20T00:00:00.000Z'),
      releaseReason: 'NGO withdrew from the region',
    };

    expect(fromAssignmentRow(toAssignmentRow(assignment))).toEqual(assignment);
  });
});
