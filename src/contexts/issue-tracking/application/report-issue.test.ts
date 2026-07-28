import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap, type Clock, type EventPublisher, type IdGenerator, type IssueId, type VillageId } from '../../../shared/index.js';
import type { ReportIssueProps } from '../domain/issue.js';
import type { IssueRepository } from './ports.js';
import { ReportIssue } from './report-issue.js';

// FR-IT-1: Report an issue — London School, mock-driven collaboration tests (ADR-004 §2).
describe('ReportIssue (FR-IT-1)', () => {
  const villageId = asId<'VillageId'>('4a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d') as VillageId;
  const issueId = asId<'IssueId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as IssueId;
  const now = new Date('2026-07-28T09:00:00Z');

  const validInput: ReportIssueProps = {
    villageId,
    category: 'water',
    description: 'No clean water for 5 days',
    reporterContact: '+911234567890',
  };

  function buildCollaborators() {
    const issueRepository: IssueRepository = { save: vi.fn(), findById: vi.fn() };
    const eventPublisher: EventPublisher = { publish: vi.fn() };
    const clock: Clock = { now: vi.fn().mockReturnValue(now) };
    const idGenerator: IdGenerator = { next: vi.fn().mockReturnValue(issueId as unknown as string) };
    return { issueRepository, eventPublisher, clock, idGenerator };
  }

  it('FR-IT-1 saves the new issue and publishes IssueReported', async () => {
    const { issueRepository, eventPublisher, clock, idGenerator } = buildCollaborators();
    const useCase = new ReportIssue(issueRepository, eventPublisher, clock, idGenerator);

    const result = await useCase.execute(validInput);

    expect(result.ok).toBe(true);
    const issue = unwrap(result);
    expect(issue.status).toBe('reported');

    expect(idGenerator.next).toHaveBeenCalledTimes(1);
    expect(issueRepository.save).toHaveBeenCalledWith(issue);
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'IssueReported',
        occurredAt: now,
        payload: expect.objectContaining({ issueId: issue.id, villageId, category: 'water' }),
      }),
    ]);
  });

  it('FR-IT-1 requires villageId, category, non-empty description and reporter contact', async () => {
    const { issueRepository, eventPublisher, clock, idGenerator } = buildCollaborators();
    const useCase = new ReportIssue(issueRepository, eventPublisher, clock, idGenerator);

    const result = await useCase.execute({ ...validInput, description: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ISSUE_EMPTY_DESCRIPTION');
    expect(issueRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });
});
