import { describe, expect, it } from 'vitest';
import { asId, type NgoId } from '../../../shared/index.js';
import { districtDepartmentRouting, ngoRouting } from './routing-decision.js';

// FR-IT-2: RoutingDecision is a discriminated union (state-based, pure domain — ADR-004 §5).
describe('RoutingDecision', () => {
  it('FR-IT-2 builds an ngo routing decision', () => {
    const ngoId = asId<'NgoId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as NgoId;
    const decision = ngoRouting(ngoId);
    expect(decision).toEqual({ kind: 'ngo', ngoId });
  });

  it('FR-IT-2 builds a district department routing decision', () => {
    const decision = districtDepartmentRouting('district_administration');
    expect(decision).toEqual({ kind: 'district_department', department: 'district_administration' });
  });
});
