/**
 * Supabase adapter for IssueRepository (BC-6, ADR-003 schema `issue_tracking`).
 *
 * Mapping notes:
 * - `attachments` is append-only (FR-IT-1): `save` inserts only the tail beyond what is
 *   already persisted.
 * - `issues.resolved_at` has no counterpart on the `Issue` aggregate (it only tracks
 *   `status`, not a per-transition timestamp), so it is left unset by this adapter.
 * - `Issue` exposes no public rehydration factory (only `create`, which re-validates a
 *   *new* report). `fromIssueRow` rebuilds the instance directly via its prototype instead.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type IssueId, type NgoId, type VillageId } from '../../../../shared/index.js';
import type { Attachment } from '../../domain/attachment.js';
import type { IssueCategory } from '../../domain/issue-category.js';
import { Issue } from '../../domain/issue.js';
import type { IssueStatus } from '../../domain/issue-status.js';
import { districtDepartmentRouting, ngoRouting, type RoutingDecision } from '../../domain/routing-decision.js';
import type { IssueRepository } from '../../application/ports.js';

const SCHEMA = 'issue_tracking';

export interface IssueRow {
  readonly id: string;
  readonly village_id: string;
  readonly category: string;
  readonly description: string;
  readonly reporter_contact: string;
  readonly status: string;
  readonly routed_to_kind: string | null;
  readonly routed_to_ngo_id: string | null;
  readonly routed_to_department: string | null;
  readonly rejection_reason: string | null;
  readonly reported_at: string;
}

export interface AttachmentRow {
  readonly id: string;
  readonly issue_id: string;
  readonly photo_url: string;
  readonly lat: number;
  readonly lng: number;
}

/** Pure mapping: Issue -> its `issues` row. */
export function toIssueRow(issue: Issue): IssueRow {
  const decision = issue.routingDecision;
  return {
    id: issue.id,
    village_id: issue.villageId,
    category: issue.category,
    description: issue.description,
    reporter_contact: issue.reporterContact,
    status: issue.status,
    routed_to_kind: decision ? decision.kind : null,
    routed_to_ngo_id: decision && decision.kind === 'ngo' ? decision.ngoId : null,
    routed_to_department: decision && decision.kind === 'district_department' ? decision.department : null,
    rejection_reason: issue.rejectionReason,
    reported_at: issue.reportedAt.toISOString(),
  };
}

/** Pure mapping: a single new Attachment -> its insertable row. */
export function toNewAttachmentRow(issueId: IssueId, attachment: Attachment): AttachmentRow {
  return {
    id: randomUUID(),
    issue_id: issueId,
    photo_url: attachment.photoUrl,
    lat: attachment.location.lat,
    lng: attachment.location.lng,
  };
}

function toRoutingDecision(row: IssueRow): RoutingDecision | null {
  if (row.routed_to_kind === 'ngo' && row.routed_to_ngo_id) {
    return ngoRouting(asId<'NgoId'>(row.routed_to_ngo_id));
  }
  if (row.routed_to_kind === 'district_department' && row.routed_to_department) {
    return districtDepartmentRouting(row.routed_to_department);
  }
  return null;
}

function fromAttachmentRow(row: AttachmentRow): Attachment {
  return { photoUrl: row.photo_url, location: { lat: row.lat, lng: row.lng } };
}

/** Pure mapping: row + its attachment rows -> the Issue aggregate (see file header). */
export function fromIssueRow(row: IssueRow, attachmentRows: readonly AttachmentRow[]): Issue {
  const props = {
    id: asId<'IssueId'>(row.id),
    villageId: asId<'VillageId'>(row.village_id),
    category: row.category as IssueCategory,
    description: row.description,
    reporterContact: row.reporter_contact,
    attachments: attachmentRows.map(fromAttachmentRow),
    status: row.status as IssueStatus,
    reportedAt: new Date(row.reported_at),
    routingDecision: toRoutingDecision(row),
    rejectionReason: row.rejection_reason,
  };

  const instance = Object.create(Issue.prototype) as Issue;
  Object.defineProperty(instance, 'props', { value: props, enumerable: false, writable: false, configurable: false });
  return instance;
}

export class SupabaseIssueRepository implements IssueRepository {
  constructor(private readonly client: SupabaseClient) {}

  async save(issue: Issue): Promise<void> {
    const { error } = await this.client.schema(SCHEMA).from('issues').upsert(toIssueRow(issue));
    if (error) throw new Error(`SupabaseIssueRepository.save: ${error.message}`);

    const { count, error: countError } = await this.client
      .schema(SCHEMA)
      .from('attachments')
      .select('id', { count: 'exact', head: true })
      .eq('issue_id', issue.id);
    if (countError) throw new Error(`SupabaseIssueRepository.save (attachment count): ${countError.message}`);

    const persisted = count ?? 0;
    const newAttachments = issue.attachments.slice(persisted).map((a) => toNewAttachmentRow(issue.id, a));
    if (newAttachments.length > 0) {
      const { error: insertError } = await this.client.schema(SCHEMA).from('attachments').insert(newAttachments);
      if (insertError) throw new Error(`SupabaseIssueRepository.save (attachment insert): ${insertError.message}`);
    }
  }

  async findById(id: IssueId): Promise<Issue | null> {
    const { data, error } = await this.client.schema(SCHEMA).from('issues').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`SupabaseIssueRepository.findById: ${error.message}`);
    if (!data) return null;

    const { data: attachmentData, error: attachmentError } = await this.client
      .schema(SCHEMA)
      .from('attachments')
      .select('*')
      .eq('issue_id', id)
      .order('uploaded_at', { ascending: true });
    if (attachmentError) {
      throw new Error(`SupabaseIssueRepository.findById (attachments): ${attachmentError.message}`);
    }

    return fromIssueRow(data as IssueRow, (attachmentData ?? []) as AttachmentRow[]);
  }
}
