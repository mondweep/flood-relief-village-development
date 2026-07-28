import type { IssueCategory, PartyType, RoutedTo } from "./issue.js";

export interface LeadNgo {
  readonly ngoId: string;
  readonly name: string;
}

const DISTRICT_ADMINISTRATION: RoutedTo = {
  partyType: "government_department" as PartyType,
  party: "district_administration",
};

const HEALTH_DEPARTMENT: RoutedTo = {
  partyType: "government_department" as PartyType,
  party: "health_department",
};

const NGO_ROUTABLE_CATEGORIES: readonly IssueCategory[] = [
  "infrastructure",
  "water",
  "food",
  "education",
];

/** Pure, deterministic routing policy: given a category and the village's lead NGO (if any), decide who the issue routes to. */
export function determineRouting(category: IssueCategory, leadNgo: LeadNgo | null): RoutedTo {
  if (category === "corruption") return DISTRICT_ADMINISTRATION;
  if (category === "health") return HEALTH_DEPARTMENT;
  if ((NGO_ROUTABLE_CATEGORIES as readonly string[]).includes(category)) {
    return leadNgo ? { partyType: "lead_ngo", party: leadNgo.ngoId } : DISTRICT_ADMINISTRATION;
  }
  return DISTRICT_ADMINISTRATION;
}
