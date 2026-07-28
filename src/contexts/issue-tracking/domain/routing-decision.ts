import type { NgoId } from '../../../shared/index.js';

/**
 * BC-6 Issue Tracking — RoutingDecision value object (PRD §5 BC-6, FR-IT-2).
 * An issue routes either to the village's assigned NGO, or to a district
 * department (always the case for 'corruption').
 */
export type RoutingDecision =
  | { readonly kind: 'ngo'; readonly ngoId: NgoId }
  | { readonly kind: 'district_department'; readonly department: string };

export function ngoRouting(ngoId: NgoId): RoutingDecision {
  return { kind: 'ngo', ngoId };
}

export function districtDepartmentRouting(department: string): RoutingDecision {
  return { kind: 'district_department', department };
}
