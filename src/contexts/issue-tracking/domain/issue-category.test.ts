import { describe, expect, it } from 'vitest';
import {
  DISTRICT_ADMINISTRATION_DEPARTMENT,
  departmentForCategory,
  isIssueCategory,
} from './issue-category.js';

// FR-IT-2: category → district department mapping (state-based, pure domain — ADR-004 §5).
describe('IssueCategory', () => {
  it('FR-IT-2 recognizes the seven valid categories', () => {
    expect(isIssueCategory('infrastructure')).toBe(true);
    expect(isIssueCategory('water')).toBe(true);
    expect(isIssueCategory('education')).toBe(true);
    expect(isIssueCategory('health')).toBe(true);
    expect(isIssueCategory('food')).toBe(true);
    expect(isIssueCategory('corruption')).toBe(true);
    expect(isIssueCategory('other')).toBe(true);
    expect(isIssueCategory('not-a-category')).toBe(false);
  });

  it('FR-IT-2 maps each non-corruption category to a distinct district department', () => {
    expect(departmentForCategory('water')).toBe('public_health_engineering');
    expect(departmentForCategory('infrastructure')).toBe('public_works');
    expect(departmentForCategory('education')).toBe('education_department');
    expect(departmentForCategory('health')).toBe('health_department');
    expect(departmentForCategory('food')).toBe('food_and_civil_supplies');
    expect(departmentForCategory('other')).toBe('general_administration');
  });

  it('FR-IT-2 maps corruption to the district administration department', () => {
    expect(departmentForCategory('corruption')).toBe(DISTRICT_ADMINISTRATION_DEPARTMENT);
  });
});
