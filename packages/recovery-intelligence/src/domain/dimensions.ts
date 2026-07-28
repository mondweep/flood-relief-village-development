/** The 11 recovery dimensions tracked per village (each scored 0-100). */
export const DIMENSIONS = [
  "infrastructure",
  "education",
  "health",
  "livelihood",
  "agriculture",
  "housing",
  "employment",
  "water",
  "sanitation",
  "road",
  "electricity",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type DimensionScores = Record<Dimension, number>;

export function isDimension(value: string): value is Dimension {
  return (DIMENSIONS as readonly string[]).includes(value);
}

export function zeroScores(): DimensionScores {
  const out = {} as DimensionScores;
  for (const dimension of DIMENSIONS) out[dimension] = 0;
  return out;
}
