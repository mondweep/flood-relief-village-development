import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap, type Clock, type EventPublisher, type IssueId, type NgoId, type VillageId } from '../../../shared/index.js';
import { Issue, type ReportIssueProps } from '../domain/issue.js';
import type { AssignmentLookup, IssueRepository } from './ports.js';
import { RouteIssue } from './route-issue.js';

// FR-IT-2: Route an issue — London School, mock-driven collaboration tests (ADR-004 §2).
describe('RouteIssue (FR-IT-2)', () => {
  const villageId = asId<'VillageId'>('4a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d') as VillageId;
  const issueId = asId<'IssueId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as IssueId;
  const ngoId = asId<'NgoId'>('5b2c3d4e-5f6a-4b2c-9d3e-4f5a6b7c8d9e') as NgoId;
  const reportedAt = new Date('2026-07-28T09:00:00Z');
  const routedAt = new Date('2026-07-28T10:00:00Z');

  function makeIssue(props: Partial<ReportIssueProps> = {}): Issue {
    const base: ReportIssueProps = {
      villageId,
      category: 'water',
      description: 'No clean water for 5 days',
      reporterContact: '+911234567890',
      ...props,
    };
    return unwrap(Issue.create(base, issueId, reportedAt));
  }

  function buildCollaborators(issue: Issue | null) {
    const issueRepository: IssueRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(issue),
    };
    const assignmentLookup: AssignmentLookup = { findActiveNgoForVillage: vi.fn() };
    const eventPublisher: EventPublisher = { publish: vi.fn() };
    const clock: Clock = { now: vi.fn().mockReturnValue(routedAt) };
    return { issueRepository, assignmentLookup, eventPublisher, clock };
  }

  it('FR-IT-2 corruption ALWAYS routes to district administration, and NEVER consults AssignmentLookup even when an NGO is assigned', async () => {
    const issue = makeIssue({ category: 'corruption' });
    const { issueRepository, assignmentLookup, eventPublisher, clock } = buildCollaborators(issue);
    (assignmentLookup.findActiveNgoForVillage as ReturnType<typeof vi.fn>).mockResolvedValue(ngoId);
    const useCase = new RouteIssue(issueRepository, assignmentLookup, eventPublisher, clock);

    const result = await useCase.execute(issueId);

    expect(result.ok).toBe(true);
    const routed = unwrap(result);
    expect(routed.routingDecision).toEqual({ kind: 'district_department', department: 'district_administration' });

    expect(assignmentLookup.findActiveNgoForVillage).not.toHaveBeenCalled();
    expect(issueRepository.save).toHaveBeenCalledWith(routed);
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'IssueRouted',
        occurredAt: routedAt,
        payload: expect.objectContaining({
          issueId,
          routingDecision: { kind: 'district_department', department: 'district_administration' },
        }),
      }),
    ]);
  });

  it('FR-IT-2 routes a non-corruption issue to the assigned NGO when AssignmentLookup finds one', async () => {
    const issue = makeIssue({ category: 'water' });
    const { issueRepository, assignmentLookup, eventPublisher, clock } = buildCollaborators(issue);
    (assignmentLookup.findActiveNgoForVillage as ReturnType<typeof vi.fn>).mockResolvedValue(ngoId);
    const useCase = new RouteIssue(issueRepository, assignmentLookup, eventPublisher, clock);

    const result = await useCase.execute(issueId);

    expect(assignmentLookup.findActiveNgoForVillage).toHaveBeenCalledWith(villageId);
    const routed = unwrap(result);
    expect(routed.routingDecision).toEqual({ kind: 'ngo', ngoId });
  });

  it('FR-IT-2 falls back to the category district department when no NGO is assigned', async () => {
    const issue = makeIssue({ category: 'water' });
    const { issueRepository, assignmentLookup, eventPublisher, clock } = buildCollaborators(issue);
    (assignmentLookup.findActiveNgoForVillage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const useCase = new RouteIssue(issueRepository, assignmentLookup, eventPublisher, clock);

    const result = await useCase.execute(issueId);

    const routed = unwrap(result);
    expect(routed.routingDecision).toEqual({ kind: 'district_department', department: 'public_health_engineering' });
  });

  it('FR-IT-2 fails with ISSUE_NOT_FOUND when the issue does not exist', async () => {
    const { issueRepository, assignmentLookup, eventPublisher, clock } = buildCollaborators(null);
    const useCase = new RouteIssue(issueRepository, assignmentLookup, eventPublisher, clock);

    const result = await useCase.execute(issueId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ISSUE_NOT_FOUND');
    expect(assignmentLookup.findActiveNgoForVillage).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-IT-3 fails with INVALID_STATUS_TRANSITION when routing an already-routed issue', async () => {
    const reported = makeIssue({ category: 'water' });
    const alreadyRouted = unwrap(reported.route({ kind: 'district_department', department: 'public_health_engineering' }));
    const { issueRepository, assignmentLookup, eventPublisher, clock } = buildCollaborators(alreadyRouted);
    const useCase = new RouteIssue(issueRepository, assignmentLookup, eventPublisher, clock);

    const result = await useCase.execute(issueId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(issueRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });
});
