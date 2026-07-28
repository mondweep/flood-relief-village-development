import { beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../../../shared/index.js';
import { makeDetectAnomalies } from './detect-anomalies.js';
import {
  OTHER_PROJECT_ID,
  OTHER_VILLAGE_ID,
  PROJECT_ID,
  THIRD_PROJECT_ID,
  VILLAGE_ID,
  aProject,
  asComparableProjectsQuery,
  asProjectRepository,
  comparable,
  fixedClock,
  mockComparableProjectsQuery,
  mockEventPublisher,
  mockComparableProjectsQuery as mockQuery,
  mockProjectRepository,
  withReleased,
  withSpent,
} from '../test-support.js';

const BEFORE_DEADLINE = '2026-03-01T00:00:00.000Z';
const AFTER_DEADLINE = '2026-07-01T00:00:00.000Z';

const spentProject = (minor: number) => withSpent(withReleased(aProject(), 1_000_000), minor);

const buildUseCase = (
  projects: ReturnType<typeof mockProjectRepository>,
  comparables: ReturnType<typeof mockComparableProjectsQuery>,
  events: ReturnType<typeof mockEventPublisher>,
  now: string,
  overspendMultiplier?: number,
) =>
  makeDetectAnomalies({
    projects: asProjectRepository(projects),
    comparables: asComparableProjectsQuery(comparables),
    events,
    clock: fixedClock(now),
    ...(overspendMultiplier === undefined ? {} : { config: { overspendMultiplier } }),
  });

describe('FR-FM-4 DetectAnomalies', () => {
  let projects: ReturnType<typeof mockProjectRepository>;
  let comparables: ReturnType<typeof mockQuery>;
  let events: ReturnType<typeof mockEventPublisher>;

  const command = { projectId: PROJECT_ID as string };

  beforeEach(() => {
    projects = mockProjectRepository();
    comparables = mockComparableProjectsQuery();
    events = mockEventPublisher();
    projects.findById.mockResolvedValue(aProject());
  });

  describe('delayed', () => {
    it('FR-FM-4: flags a project past its expected completion date and publishes AnomalyFlagged', async () => {
      const useCase = buildUseCase(projects, comparables, events, AFTER_DEADLINE);

      const result = await useCase.execute(command);

      expect(unwrap(result).map((a) => a.kind)).toEqual(['delayed']);
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'AnomalyFlagged',
          occurredAt: new Date(AFTER_DEADLINE),
          payload: expect.objectContaining({
            projectId: PROJECT_ID,
            kind: 'delayed',
            details: expect.objectContaining({ overdueDays: 30 }),
          }),
        }),
      ]);
    });

    it('FR-FM-4: does not flag a project that is still within its schedule (Clock-driven)', async () => {
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      const result = await useCase.execute(command);

      expect(unwrap(result)).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('FR-FM-4: does not flag a completed project as delayed', async () => {
      projects.findById.mockResolvedValue(
        aProject({ status: 'completed', completedAt: new Date('2026-05-20T00:00:00.000Z') }),
      );
      const useCase = buildUseCase(projects, comparables, events, AFTER_DEADLINE);

      const result = await useCase.execute(command);

      expect(unwrap(result)).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  describe('duplicate_funding', () => {
    it('FR-FM-4: flags another project in the same village and category with an overlapping period', async () => {
      projects.findByVillage.mockResolvedValue([
        aProject(),
        aProject({ id: OTHER_PROJECT_ID, fundingSource: 'csr' }),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      const result = await useCase.execute(command);

      expect(projects.findByVillage).toHaveBeenCalledWith(VILLAGE_ID);
      expect(unwrap(result)).toEqual([
        expect.objectContaining({
          projectId: PROJECT_ID,
          kind: 'duplicate_funding',
          details: expect.objectContaining({ otherProjectId: OTHER_PROJECT_ID, category: 'road' }),
        }),
      ]);
      expect(events.publish).toHaveBeenCalledWith([
        expect.objectContaining({ payload: expect.objectContaining({ kind: 'duplicate_funding' }) }),
      ]);
    });

    it('FR-FM-4: never flags the project against itself', async () => {
      projects.findByVillage.mockResolvedValue([aProject()]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      const result = await useCase.execute(command);

      expect(unwrap(result)).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('FR-FM-4: does not flag a different category in the same village', async () => {
      projects.findByVillage.mockResolvedValue([
        aProject(),
        aProject({ id: OTHER_PROJECT_ID, category: 'school' }),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      expect(unwrap(await useCase.execute(command))).toEqual([]);
    });

    it('FR-FM-4: does not flag the same category in a different village', async () => {
      projects.findByVillage.mockResolvedValue([
        aProject(),
        aProject({ id: OTHER_PROJECT_ID, villageId: OTHER_VILLAGE_ID }),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      expect(unwrap(await useCase.execute(command))).toEqual([]);
    });

    it('FR-FM-4: does not flag a same-category project whose active period does not overlap', async () => {
      projects.findByVillage.mockResolvedValue([
        aProject(),
        aProject({
          id: OTHER_PROJECT_ID,
          sanctionedAt: new Date('2026-08-01T00:00:00.000Z'),
          expectedCompletionAt: new Date('2026-12-01T00:00:00.000Z'),
        }),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      expect(unwrap(await useCase.execute(command))).toEqual([]);
    });

    it('FR-FM-4: flags every overlapping same-category sibling', async () => {
      projects.findByVillage.mockResolvedValue([
        aProject(),
        aProject({ id: OTHER_PROJECT_ID }),
        aProject({ id: THIRD_PROJECT_ID }),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      const result = await useCase.execute(command);

      expect(unwrap(result)).toHaveLength(2);
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish.mock.calls[0]?.[0]).toHaveLength(2);
    });
  });

  describe('overspend', () => {
    beforeEach(() => {
      projects.findById.mockResolvedValue(spentProject(400_000));
    });

    it('FR-FM-4: flags spend above 1.5x the median of comparable projects', async () => {
      comparables.findComparable.mockResolvedValue([
        comparable(OTHER_PROJECT_ID, 200_000),
        comparable(THIRD_PROJECT_ID, 200_000),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      const result = await useCase.execute(command);

      expect(comparables.findComparable).toHaveBeenCalledWith({
        category: 'road',
        excludeProjectId: PROJECT_ID,
      });
      expect(unwrap(result)).toEqual([
        expect.objectContaining({
          kind: 'overspend',
          details: expect.objectContaining({
            spentMinor: 400_000,
            medianSpentMinor: 200_000,
            multiplier: 1.5,
            thresholdMinor: 300_000,
          }),
        }),
      ]);
      expect(events.publish).toHaveBeenCalledWith([
        expect.objectContaining({ payload: expect.objectContaining({ kind: 'overspend' }) }),
      ]);
    });

    it('FR-FM-4: does not flag spend exactly at the 1.5x threshold', async () => {
      projects.findById.mockResolvedValue(spentProject(300_000));
      comparables.findComparable.mockResolvedValue([comparable(OTHER_PROJECT_ID, 200_000)]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      expect(unwrap(await useCase.execute(command))).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('FR-FM-4: does not flag overspend when there are no comparable projects', async () => {
      comparables.findComparable.mockResolvedValue([]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      const result = await useCase.execute(command);

      expect(comparables.findComparable).toHaveBeenCalledTimes(1);
      expect(unwrap(result)).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('FR-FM-4: does not flag overspend when every comparable has spent nothing', async () => {
      comparables.findComparable.mockResolvedValue([
        comparable(OTHER_PROJECT_ID, 0),
        comparable(THIRD_PROJECT_ID, 0),
      ]);
      const useCase = buildUseCase(projects, comparables, events, BEFORE_DEADLINE);

      expect(unwrap(await useCase.execute(command))).toEqual([]);
    });

    it('FR-FM-4: honours a configurable overspend multiplier', async () => {
      comparables.findComparable.mockResolvedValue([comparable(OTHER_PROJECT_ID, 200_000)]);
      const strict = buildUseCase(projects, comparables, events, BEFORE_DEADLINE, 1.2);

      const result = await strict.execute(command);

      expect(unwrap(result).map((a) => a.kind)).toEqual(['overspend']);
      expect(unwrap(result)[0]?.details).toEqual(
        expect.objectContaining({ multiplier: 1.2, thresholdMinor: 240_000 }),
      );
    });

    it('FR-FM-4: a lenient multiplier suppresses the flag', async () => {
      comparables.findComparable.mockResolvedValue([comparable(OTHER_PROJECT_ID, 200_000)]);
      const lenient = buildUseCase(projects, comparables, events, BEFORE_DEADLINE, 3);

      expect(unwrap(await lenient.execute(command))).toEqual([]);
    });
  });

  describe('orchestration', () => {
    it('FR-FM-4: publishes one AnomalyFlagged per finding across kinds', async () => {
      projects.findById.mockResolvedValue(spentProject(400_000));
      projects.findByVillage.mockResolvedValue([spentProject(400_000), aProject({ id: OTHER_PROJECT_ID })]);
      comparables.findComparable.mockResolvedValue([comparable(THIRD_PROJECT_ID, 100_000)]);
      const useCase = buildUseCase(projects, comparables, events, AFTER_DEADLINE);

      const result = await useCase.execute(command);

      expect(unwrap(result).map((a) => a.kind)).toEqual(['delayed', 'duplicate_funding', 'overspend']);
      expect(events.publish).toHaveBeenCalledTimes(1);
      const published = events.publish.mock.calls[0]?.[0] as ReadonlyArray<{
        payload: { kind: string; projectId: string };
      }>;
      expect(published.map((e) => e.payload.kind)).toEqual([
        'delayed',
        'duplicate_funding',
        'overspend',
      ]);
      expect(published.every((e) => e.payload.projectId === PROJECT_ID)).toBe(true);
    });

    it('FR-FM-4: never mutates or saves the project while detecting', async () => {
      const useCase = buildUseCase(projects, comparables, events, AFTER_DEADLINE);

      await useCase.execute(command);

      expect(projects.save).not.toHaveBeenCalled();
    });

    it('FR-FM-4: rejects detection for an unknown project without publishing', async () => {
      projects.findById.mockResolvedValue(null);
      const useCase = buildUseCase(projects, comparables, events, AFTER_DEADLINE);

      const result = await useCase.execute(command);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND');
      expect(events.publish).not.toHaveBeenCalled();
      expect(comparables.findComparable).not.toHaveBeenCalled();
    });

    it('FR-FM-4: rejects a malformed project id before any collaboration', async () => {
      const useCase = buildUseCase(projects, comparables, events, AFTER_DEADLINE);

      const result = await useCase.execute({ projectId: 'bad-id' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT_ID');
      expect(projects.findById).not.toHaveBeenCalled();
      expect(projects.findByVillage).not.toHaveBeenCalled();
      expect(comparables.findComparable).not.toHaveBeenCalled();
    });
  });
});
