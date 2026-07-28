import { describe, expect, it } from 'vitest';
import {
  type AnomalyScan,
  DEFAULT_ANOMALY_CONFIG,
  activePeriod,
  detectAnomalies,
  median,
  periodsOverlap,
} from './anomaly-detector.js';
import {
  OTHER_PROJECT_ID,
  THIRD_PROJECT_ID,
  aProject,
  comparable,
  withReleased,
  withSpent,
} from '../test-support.js';

// Pure domain service: state-based assertions (ADR-004 §5).
const scan = (overrides: Partial<AnomalyScan> = {}): AnomalyScan => ({
  project: aProject(),
  villageProjects: [],
  comparables: [],
  now: new Date('2026-03-01T00:00:00.000Z'),
  config: DEFAULT_ANOMALY_CONFIG,
  ...overrides,
});

describe('FR-FM-4 AnomalyDetector', () => {
  describe('median', () => {
    it('FR-FM-4: is undefined for an empty sample', () => {
      expect(median([])).toBeUndefined();
    });

    it('FR-FM-4: is the middle value for an odd sample', () => {
      expect(median([5, 1, 3])).toBe(3);
    });

    it('FR-FM-4: is the mean of the middle pair for an even sample', () => {
      expect(median([4, 1, 3, 2])).toBe(2.5);
    });
  });

  describe('activePeriod / periodsOverlap', () => {
    it('FR-FM-4: an open project runs from sanction to expected completion', () => {
      const period = activePeriod(aProject());
      expect(period.start).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(period.end).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    });

    it('FR-FM-4: a completed project ends at its completion date', () => {
      const completedAt = new Date('2026-04-01T00:00:00.000Z');
      expect(activePeriod(aProject({ status: 'completed', completedAt })).end).toEqual(completedAt);
    });

    it('FR-FM-4: touching periods count as overlapping', () => {
      const a = { start: new Date('2026-01-01'), end: new Date('2026-06-01') };
      const b = { start: new Date('2026-06-01'), end: new Date('2026-09-01') };
      expect(periodsOverlap(a, b)).toBe(true);
    });

    it('FR-FM-4: disjoint periods do not overlap', () => {
      const a = { start: new Date('2026-01-01'), end: new Date('2026-06-01') };
      const b = { start: new Date('2026-06-02'), end: new Date('2026-09-01') };
      expect(periodsOverlap(a, b)).toBe(false);
    });
  });

  describe('rules', () => {
    it('FR-FM-4: a healthy in-schedule project yields no anomalies', () => {
      expect(detectAnomalies(scan())).toEqual([]);
    });

    it('FR-FM-4: delayed carries the overdue day count and expected date', () => {
      const found = detectAnomalies(scan({ now: new Date('2026-06-11T00:00:00.000Z') }));
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe('delayed');
      expect(found[0]?.details).toEqual(
        expect.objectContaining({
          overdueDays: 10,
          expectedCompletionAt: '2026-06-01T00:00:00.000Z',
        }),
      );
    });

    it('FR-FM-4: a project exactly at its deadline is not yet delayed', () => {
      expect(detectAnomalies(scan({ now: new Date('2026-06-01T00:00:00.000Z') }))).toEqual([]);
    });

    it('FR-FM-4: duplicate funding names the overlapping sibling project', () => {
      const found = detectAnomalies(
        scan({ villageProjects: [aProject(), aProject({ id: OTHER_PROJECT_ID, fundingSource: 'mla' })] }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe('duplicate_funding');
      expect(found[0]?.details).toEqual(
        expect.objectContaining({ otherProjectId: OTHER_PROJECT_ID, otherFundingSource: 'mla' }),
      );
    });

    it('FR-FM-4: overspend compares against the median of comparables', () => {
      const found = detectAnomalies(
        scan({
          project: withSpent(withReleased(aProject(), 900_000), 900_000),
          comparables: [
            comparable(OTHER_PROJECT_ID, 100_000),
            comparable(THIRD_PROJECT_ID, 300_000),
          ],
        }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.details).toEqual(
        expect.objectContaining({ medianSpentMinor: 200_000, thresholdMinor: 300_000, comparableCount: 2 }),
      );
    });

    it('FR-FM-4: comparables in another currency are ignored (no baseline, no flag)', () => {
      const found = detectAnomalies(
        scan({
          project: withSpent(withReleased(aProject(), 900_000), 900_000),
          comparables: [{ ...comparable(OTHER_PROJECT_ID, 1), spent: { amountMinor: 1, currency: 'USD' } }],
        }),
      );
      expect(found).toEqual([]);
    });

    it('FR-FM-4: the project itself is excluded from its own overspend baseline', () => {
      const project = withSpent(withReleased(aProject(), 900_000), 900_000);
      const found = detectAnomalies(
        scan({ project, comparables: [{ ...comparable(project.id, 900_000) }] }),
      );
      expect(found).toEqual([]);
    });

    it('FR-FM-4: all three rules can fire together, in a stable order', () => {
      const project = withSpent(withReleased(aProject(), 900_000), 900_000);
      const found = detectAnomalies(
        scan({
          project,
          now: new Date('2026-07-01T00:00:00.000Z'),
          villageProjects: [project, aProject({ id: OTHER_PROJECT_ID })],
          comparables: [comparable(THIRD_PROJECT_ID, 100_000)],
        }),
      );
      expect(found.map((a) => a.kind)).toEqual(['delayed', 'duplicate_funding', 'overspend']);
      expect(found.every((a) => a.projectId === project.id)).toBe(true);
    });
  });
});
