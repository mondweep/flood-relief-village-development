import { describe, expect, it } from 'vitest';
import { asId, unwrap, type IssueId, type NgoId, type VillageId } from '../../../../shared/index.js';
import { Issue } from '../../domain/issue.js';
import { attachment } from '../../domain/attachment.js';
import { ngoRouting, districtDepartmentRouting } from '../../domain/routing-decision.js';
import {
  fromIssueRow,
  toIssueRow,
  toNewAttachmentRow,
  type AttachmentRow,
} from './issue-repository.js';

const issueId = (): IssueId => asId<'IssueId'>('60000000-0000-4000-8000-000000000001');
const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');
const ngoId = (): NgoId => asId<'NgoId'>('10000000-0000-4000-8000-000000000001');

const aReportedIssue = () =>
  unwrap(
    Issue.create(
      { villageId: villageId(), category: 'water', description: 'well contaminated', reporterContact: '+91-9000000000' },
      issueId(),
      new Date('2026-07-28T09:00:00.000Z'),
    ),
  );

describe('toIssueRow', () => {
  it('maps an unrouted issue with null routing columns', () => {
    const row = toIssueRow(aReportedIssue());
    expect(row).toMatchObject({
      id: issueId(),
      village_id: villageId(),
      category: 'water',
      description: 'well contaminated',
      reporter_contact: '+91-9000000000',
      status: 'reported',
      routed_to_kind: null,
      routed_to_ngo_id: null,
      routed_to_department: null,
      rejection_reason: null,
      reported_at: '2026-07-28T09:00:00.000Z',
    });
  });

  it('maps an ngo-routed issue', () => {
    const routed = unwrap(aReportedIssue().route(ngoRouting(ngoId())));
    const row = toIssueRow(routed);
    expect(row.routed_to_kind).toBe('ngo');
    expect(row.routed_to_ngo_id).toBe(ngoId());
    expect(row.routed_to_department).toBeNull();
  });

  it('maps a department-routed issue', () => {
    const routed = unwrap(aReportedIssue().route(districtDepartmentRouting('public_health_engineering')));
    const row = toIssueRow(routed);
    expect(row.routed_to_kind).toBe('district_department');
    expect(row.routed_to_department).toBe('public_health_engineering');
    expect(row.routed_to_ngo_id).toBeNull();
  });
});

describe('toNewAttachmentRow', () => {
  it('maps an Attachment to its insertable row', () => {
    const item = unwrap(attachment('https://x/photo.jpg', { lat: 26.9, lng: 94.1 }));
    const row = toNewAttachmentRow(issueId(), item);
    expect(row.issue_id).toBe(issueId());
    expect(row.photo_url).toBe('https://x/photo.jpg');
    expect(row.lat).toBe(26.9);
    expect(row.lng).toBe(94.1);
  });
});

describe('fromIssueRow', () => {
  it('rebuilds an Issue whose getters reflect the row and attachments', () => {
    const routed = unwrap(aReportedIssue().route(ngoRouting(ngoId())));
    const row = toIssueRow(routed);
    const item = unwrap(attachment('https://x/photo.jpg', { lat: 26.9, lng: 94.1 }));
    const attachmentRow: AttachmentRow = { ...toNewAttachmentRow(issueId(), item), id: 'attachment-1' };

    const rebuilt = fromIssueRow(row, [attachmentRow]);

    expect(rebuilt.id).toBe(issueId());
    expect(rebuilt.villageId).toBe(villageId());
    expect(rebuilt.category).toBe('water');
    expect(rebuilt.status).toBe('routed');
    expect(rebuilt.routingDecision).toEqual(ngoRouting(ngoId()));
    expect(rebuilt.attachments).toEqual([item]);
    expect(rebuilt.reportedAt).toEqual(new Date('2026-07-28T09:00:00.000Z'));
  });

  it('rebuilds a rejected issue with its rejection reason and no routing decision cleared', () => {
    let issue = aReportedIssue();
    issue = unwrap(issue.route(districtDepartmentRouting('general_administration')));
    issue = unwrap(issue.progress());
    issue = unwrap(issue.reject('duplicate report'));

    const row = toIssueRow(issue);
    const rebuilt = fromIssueRow(row, []);

    expect(rebuilt.status).toBe('rejected');
    expect(rebuilt.rejectionReason).toBe('duplicate report');
    expect(rebuilt.routingDecision).toEqual(districtDepartmentRouting('general_administration'));
  });
});
