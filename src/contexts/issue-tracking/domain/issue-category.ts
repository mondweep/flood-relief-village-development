/**
 * BC-6 Issue Tracking — IssueCategory value object (PRD §5 BC-6).
 * Pure domain: the set of categories a citizen can report, plus the
 * category → district department mapping used when no NGO is assigned
 * (FR-IT-2 routing policy).
 */
export type IssueCategory =
  | 'infrastructure'
  | 'water'
  | 'education'
  | 'health'
  | 'food'
  | 'corruption'
  | 'other';

export const ISSUE_CATEGORIES: readonly IssueCategory[] = [
  'infrastructure',
  'water',
  'education',
  'health',
  'food',
  'corruption',
  'other',
];

export function isIssueCategory(value: string): value is IssueCategory {
  return (ISSUE_CATEGORIES as readonly string[]).includes(value);
}

/** District administration is the fixed destination for corruption reports (FR-IT-2). */
export const DISTRICT_ADMINISTRATION_DEPARTMENT = 'district_administration';

/**
 * District department a category routes to when no NGO is assigned to the
 * village (FR-IT-2). Corruption is intentionally mapped here too, but the
 * routing policy in the application layer never consults this for
 * corruption — it always uses DISTRICT_ADMINISTRATION_DEPARTMENT directly.
 */
const CATEGORY_TO_DEPARTMENT: Readonly<Record<IssueCategory, string>> = {
  infrastructure: 'public_works',
  water: 'public_health_engineering',
  education: 'education_department',
  health: 'health_department',
  food: 'food_and_civil_supplies',
  corruption: DISTRICT_ADMINISTRATION_DEPARTMENT,
  other: 'general_administration',
};

export function departmentForCategory(category: IssueCategory): string {
  return CATEGORY_TO_DEPARTMENT[category];
}
