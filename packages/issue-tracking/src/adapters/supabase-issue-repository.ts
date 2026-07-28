import type { SupabaseClient } from "@supabase/supabase-js";
import { issueId, villageId, type IssueId, type VillageId } from "@afrip/shared-kernel";
import {
  Issue,
  type IssueCategory,
  type IssueRestoreProps,
  type IssueStatus,
  type PartyType,
  type RoutedTo,
} from "../domain/issue.js";
import type { IssueRepository } from "../application/ports.js";

/** Table owned by the issue-tracking context (see 00001_initial_schema.sql). */
export const ISSUES_TABLE = "issue_tracking_issues";

/** Row shape of `issue_tracking_issues`. */
export interface IssueRow {
  id: string;
  village_id: string;
  category: string;
  description: string;
  photo_refs: string[];
  lat: number;
  lng: number;
  status: string;
  routed_party_type: string | null;
  routed_party: string | null;
  reported_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

function failed(table: string, operation: string, error: { message?: string } | null): void {
  if (error) {
    throw new Error(
      `supabase ${operation} on ${table} failed: ${error.message ?? "unknown error"}`,
    );
  }
}

function corrupt(table: string, id: string, reason: string): Error {
  return new Error(`corrupt row in ${table} (id=${id}): ${reason}`);
}

/**
 * Note: the 00001 schema stores only the routing decision and the resolution,
 * not the `routedAt` / `progressStartedAt` / `verifiedAt` instants the
 * aggregate tracks in memory. Those are intentionally written nowhere rather
 * than invented on read.
 */
export function toRow(issue: Issue): IssueRow {
  const routedTo = issue.routedTo;
  return {
    id: issue.id,
    village_id: issue.villageId,
    category: issue.category,
    description: issue.description,
    photo_refs: issue.photoRefs,
    lat: issue.gps.lat,
    lng: issue.gps.lng,
    status: issue.status,
    routed_party_type: routedTo ? routedTo.partyType : null,
    routed_party: routedTo ? routedTo.party : null,
    reported_at: issue.reportedAt,
    resolved_at: issue.resolvedAt ?? null,
    resolution_note: issue.resolutionNote ?? null,
  };
}

/** Rebuilds an Issue from its row; any invariant failure throws. */
export function fromRow(row: IssueRow): Issue {
  const id = issueId(row.id);
  if (!id.ok) throw corrupt(ISSUES_TABLE, String(row.id), id.error);
  const village = villageId(row.village_id);
  if (!village.ok) throw corrupt(ISSUES_TABLE, row.id, village.error);

  const hasPartyType = row.routed_party_type !== null && row.routed_party_type !== undefined;
  const hasParty = row.routed_party !== null && row.routed_party !== undefined;
  if (hasPartyType !== hasParty) {
    throw corrupt(
      ISSUES_TABLE,
      row.id,
      "routed_party_type and routed_party must both be set or both be null",
    );
  }
  const routedTo: RoutedTo | undefined =
    hasPartyType && hasParty
      ? { partyType: row.routed_party_type as PartyType, party: row.routed_party as string }
      : undefined;

  const props: IssueRestoreProps = {
    id: id.value,
    villageId: village.value,
    category: row.category as IssueCategory,
    description: row.description,
    photoRefs: [...(row.photo_refs ?? [])],
    gps: { lat: row.lat, lng: row.lng },
    reportedAt: row.reported_at,
    status: row.status as IssueStatus,
    ...(routedTo === undefined ? {} : { routedTo }),
    ...(row.resolved_at === null || row.resolved_at === undefined
      ? {}
      : { resolvedAt: row.resolved_at }),
    ...(row.resolution_note === null || row.resolution_note === undefined
      ? {}
      : { resolutionNote: row.resolution_note }),
  };

  const restored = Issue.restore(props);
  if (!restored.ok) throw corrupt(ISSUES_TABLE, row.id, restored.error);
  return restored.value;
}

/** Supabase/Postgres adapter for IssueRepository (ADR 0004). */
export class SupabaseIssueRepository implements IssueRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: IssueId): Promise<Issue | null> {
    const result = await this.client.from(ISSUES_TABLE).select("*").eq("id", id).maybeSingle();
    failed(ISSUES_TABLE, "select", result.error);
    if (!result.data) return null;
    return fromRow(result.data as IssueRow);
  }

  async save(issue: Issue): Promise<void> {
    const result = await this.client.from(ISSUES_TABLE).upsert(toRow(issue));
    failed(ISSUES_TABLE, "upsert", result.error);
  }

  async listByVillage(village: VillageId): Promise<Issue[]> {
    const result = await this.client
      .from(ISSUES_TABLE)
      .select("*")
      .eq("village_id", village)
      .order("reported_at", { ascending: true });
    failed(ISSUES_TABLE, "select", result.error);
    return ((result.data ?? []) as IssueRow[]).map(fromRow);
  }

  async listByStatus(status: IssueStatus): Promise<Issue[]> {
    const result = await this.client
      .from(ISSUES_TABLE)
      .select("*")
      .eq("status", status)
      .order("reported_at", { ascending: true });
    failed(ISSUES_TABLE, "select", result.error);
    return ((result.data ?? []) as IssueRow[]).map(fromRow);
  }
}
