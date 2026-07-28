import { describe, expect, it } from 'vitest';
import { asId, unwrap, geoPoint, type IssueId, type NgoId, type VillageId } from '../../../shared/index.js';
import { attachment } from './attachment.js';
import { Issue, type ReportIssueProps } from './issue.js';
import { districtDepartmentRouting, ngoRouting } from './routing-decision.js';

// Pure aggregate: state-based tests are appropriate here (ADR-004 §5).
describe('Issue aggregate', () => {
  const issueId = asId<'IssueId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as IssueId;
  const villageId = asId<'VillageId'>('4a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d') as VillageId;
  const reportedAt = new Date('2026-07-28T09:00:00Z');

  const validProps: ReportIssueProps = {
    villageId,
    category: 'water',
    description: 'No clean water for 5 days',
    reporterContact: '+911234567890',
  };

  describe('FR-IT-1 creation invariants', () => {
    it('creates a reported issue with village, category, description, reporter contact', () => {
      const result = Issue.create(validProps, issueId, reportedAt);
      expect(result.ok).toBe(true);
      const issue = unwrap(result);
      expect(issue.status).toBe('reported');
      expect(issue.villageId).toBe(villageId);
      expect(issue.category).toBe('water');
      expect(issue.attachments).toEqual([]);
    });

    it('carries attachments with photo and GPS', () => {
      const point = unwrap(geoPoint(26.2, 92.9));
      const photo = unwrap(attachment('https://cdn.example.com/photo.jpg', point));
      const issue = unwrap(Issue.create({ ...validProps, attachments: [photo] }, issueId, reportedAt));
      expect(issue.attachments).toEqual([photo]);
    });

    it('rejects an empty description', () => {
      const result = Issue.create({ ...validProps, description: '  ' }, issueId, reportedAt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ISSUE_EMPTY_DESCRIPTION');
    });

    it('rejects an empty reporter contact', () => {
      const result = Issue.create({ ...validProps, reporterContact: '' }, issueId, reportedAt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ISSUE_EMPTY_REPORTER_CONTACT');
    });
  });

  describe('FR-IT-3 status machine', () => {
    const ngoId = asId<'NgoId'>('5b2c3d4e-5f6a-4b2c-9d3e-4f5a6b7c8d9e') as NgoId;

    it('routes a reported issue to routed, carrying the routing decision', () => {
      const issue = unwrap(Issue.create(validProps, issueId, reportedAt));
      const routed = unwrap(issue.route(ngoRouting(ngoId)));
      expect(routed.status).toBe('routed');
      expect(routed.routingDecision).toEqual({ kind: 'ngo', ngoId });
    });

    it('progresses a routed issue to in_progress', () => {
      const issue = unwrap(Issue.create(validProps, issueId, reportedAt));
      const routed = unwrap(issue.route(districtDepartmentRouting('public_health_engineering')));
      const inProgress = unwrap(routed.progress());
      expect(inProgress.status).toBe('in_progress');
    });

    it('resolves an in_progress issue', () => {
      const issue = unwrap(Issue.create(validProps, issueId, reportedAt));
      const routed = unwrap(issue.route(districtDepartmentRouting('public_health_engineering')));
      const inProgress = unwrap(routed.progress());
      const resolved = unwrap(inProgress.resolve());
      expect(resolved.status).toBe('resolved');
    });

    it('rejects resolve() from reported with INVALID_STATUS_TRANSITION (no skipping)', () => {
      const issue = unwrap(Issue.create(validProps, issueId, reportedAt));
      const result = issue.resolve();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('rejects an in_progress issue with a reason', () => {
      const issue = unwrap(Issue.create(validProps, issueId, reportedAt));
      const routed = unwrap(issue.route(districtDepartmentRouting('public_health_engineering')));
      const inProgress = unwrap(routed.progress());
      const rejected = unwrap(inProgress.reject('duplicate report'));
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('duplicate report');
    });

    it('requires a non-empty reason to reject', () => {
      const issue = unwrap(Issue.create(validProps, issueId, reportedAt));
      const routed = unwrap(issue.route(districtDepartmentRouting('public_health_engineering')));
      const inProgress = unwrap(routed.progress());
      const result = inProgress.reject('   ');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ISSUE_REJECTION_REASON_REQUIRED');
    });
  });
});
