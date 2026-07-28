/**
 * FR-RS-1 / FR-RS-3: the fixed set of 11 recovery categories (PRD §5 BC-5).
 * Pure value object — no I/O.
 */
export const SCORE_CATEGORIES = [
  'infrastructure',
  'education',
  'health',
  'livelihood',
  'agriculture',
  'housing',
  'employment',
  'water',
  'sanitation',
  'road',
  'electricity',
] as const;

export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];

export const isScoreCategory = (value: string): value is ScoreCategory =>
  (SCORE_CATEGORIES as readonly string[]).includes(value);
