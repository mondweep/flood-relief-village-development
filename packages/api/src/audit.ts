import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFRIP_SCHEMA,
  err,
  ok,
  type DomainEvent,
  type EventActor,
  type Result,
} from "@afrip/shared-kernel";

/**
 * The table `00006_audit_log.sql` creates. One row per domain event (ADR 0011).
 */
export const AUDIT_LOG_TABLE = "audit_log";

/**
 * Every column of that table, in its declared order.
 *
 * Spelled out rather than `select("*")` so that a column added to the migration
 * and not to `AuditEntry` is a compile error here instead of a field that
 * silently never reaches a report.
 */
export const AUDIT_COLUMNS =
  "id,event_name,occurred_at,recorded_at,actor_id,actor_email,actor_role,request_id,subject_type,subject_id,payload";

/** Rows returned when a filter does not say otherwise. */
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * The most rows one query may return, whatever the caller asked for.
 *
 * A ceiling rather than a suggestion: `GET /audit?limit=1000000` on a table that
 * grows monotonically forever is a denial of service against the API and a
 * memory spike in the browser, and the caller who wants everything has
 * `nextCursor` for exactly that.
 */
export const MAX_AUDIT_PAGE_SIZE = 200;

/**
 * How a `system` actor's process name is encoded into `actor_role`, and how an
 * `anonymous` actor's `via` is. See `flattenActor` for the full argument.
 */
export const SYSTEM_ACTOR_ROLE_PREFIX = "system:";
export const ANONYMOUS_ACTOR_ROLE_PREFIX = "anonymous:";

/**
 * One audit row, mirroring `assam_floods.audit_log`.
 *
 * `id` and `recordedAt` are assigned BY THE DATABASE and are therefore null on
 * an entry that has not been written yet — `auditEntryOf` builds one of those.
 * They are not optional fields: the difference between "not written yet" and
 * "written, and here is where it sits in the log" is worth being unable to
 * ignore.
 *
 * `id` is a string although the column is `bigint`, and it is normalised to one
 * here whichever way PostgREST renders int8 (a JSON number today, text under
 * some configurations). A JSON number is a double, so past 2^53 an id would
 * round — and a paging cursor that rounds silently skips rows. Text costs
 * nothing, survives every further JSON round trip through the browser, and goes
 * back into the `id < ?` predicate unchanged.
 *
 * Be clear about what that does NOT fix: if PostgREST hands us a rounded number,
 * the precision was lost before this code saw it. 2^53 audit rows is not a
 * volume this platform will reach, so the guard is against the cheap half of the
 * problem, which is everything downstream of here.
 */
export interface AuditEntry {
  readonly id: string | null;
  readonly eventName: string;
  readonly occurredAt: string;
  readonly recordedAt: string | null;
  readonly actorId: string | null;
  readonly actorEmail: string | null;
  readonly actorRole: string | null;
  readonly requestId: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * What the three reporting endpoints in ADR 0011 need, and nothing else.
 *
 * `subjectType` without `subjectId` is accepted and means "every village", which
 * the composite index serves. `subjectId` without `subjectType` is NOT: ids are
 * only unique within a type, so it would match a village and a beneficiary that
 * happen to share a string, and a report that mixes two subjects is worse than
 * one that refuses.
 */
export interface AuditFilter {
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly actorId?: string;
  readonly eventName?: string;
  /** Inclusive lower bound on `occurred_at`, ISO-8601. */
  readonly from?: string;
  /** Inclusive upper bound on `occurred_at`, ISO-8601. */
  readonly to?: string;
  readonly limit?: number;
  /** Opaque; hand back `AuditPage.nextCursor` verbatim. */
  readonly cursor?: string;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  /**
   * Pass as `cursor` for the next page, or null when this was the last one.
   *
   * KEYSET, NOT OFFSET, and the choice is not a matter of taste here. An offset
   * assumes the rows before it do not move; this table is append-only and
   * ordered newest-first, so every insert while a reader is paging shifts the
   * whole window by one and page 2 repeats a row page 1 already showed. In a
   * dashboard that is an annoyance. In an audit report it is a false statement
   * about history — the reader counts two deliveries where there was one — and
   * the entire point of this table is that it does not make false statements.
   *
   * The key is `id`, not `occurred_at`: `occurred_at` is neither unique nor
   * monotonic with insertion (00006's header explains why the two timestamps
   * diverge), and a keyset key must be both.
   */
  readonly nextCursor: string | null;
}

/**
 * Outbound port: the durable domain-event stream (ADR 0011).
 *
 * `record` returns `void` and THROWS on failure. That is deliberate and it is
 * not the failure policy — see `AuditLogSubscriber`, which is where the policy
 * lives, because deciding what to do about a failed audit write requires knowing
 * that the aggregate has already been saved, and an adapter does not know that.
 * An adapter that swallowed its own errors would leave the subscriber unable to
 * count them or log them.
 *
 * `query` returns a `Result` instead, because a failed read has a caller who can
 * be told. Returning an empty page on failure would render as "nothing ever
 * happened to this village", which is the single most misleading answer this
 * table could give.
 */
export interface AuditLog {
  record(event: DomainEvent): Promise<void>;
  query(filter: AuditFilter): Promise<Result<AuditPage>>;
}

/** What an event is about: which kind of thing, and which one. */
interface SubjectRule {
  readonly subjectType: string;
  /** The payload field holding the subject's id. */
  readonly idKey: string;
}

/**
 * Every event the platform emits, mapped to the aggregate it is about.
 *
 * THE RULE IS "the aggregate whose state changed", not "the most interesting id
 * in the payload". `ngo.assigned-to-village.v1` carries `assignmentId`,
 * `villageId` and `ngoId`; the subject is the assignment, because that is the
 * record that came into existence. The alternative — pick whichever id a
 * district officer would most like to search by — produces a column where
 * `subject_type = 'village'` sometimes means "this village changed" and
 * sometimes means "something adjacent to this village changed", and a filter
 * over it stops meaning anything precise.
 *
 * THE COST, stated plainly because it limits the endpoint ADR 0011 calls the one
 * that matters: `GET /audit/subjects/village/:id` will NOT return the NGO
 * assignment, the beneficiary registration or the sanctioned project that
 * mention that village in their payloads, because their subject is the
 * assignment, the beneficiary and the project. Answering "everything that ever
 * happened *around* this village" needs a second lookup keyed on the payload's
 * `villageId` — a jsonb index and a union query. That is real work with a real
 * design decision in it (does a village's history include its NGO's changes?),
 * and inventing an answer here by quietly reassigning subjects would make the
 * column dishonest in exchange for one nicer-looking report.
 *
 * Field names below are read from each emitting use case, never guessed. The
 * test `every emitted event name has a subject mapping` scans the source tree
 * for `*.v1` literals and fails if one is missing, so a new event cannot land
 * unmapped — which matters because an unmapped event is not loud (see
 * `subjectOf`: it is recorded with a null subject, correctly, and therefore
 * invisibly).
 */
export const AUDIT_SUBJECTS: Readonly<Record<string, SubjectRule>> = {
  // social-media-intelligence
  "alert.raised.v1": { subjectType: "alert", idKey: "alertId" },
  "signal.detected.v1": { subjectType: "signal", idKey: "signalId" },

  // ngo-coordination — all three are about the VillageAssignment aggregate.
  // `committee-member.added.v1` carries only `assignmentId` and `role`; the
  // committee member is not an aggregate of its own.
  "assignment.retired.v1": { subjectType: "assignment", idKey: "assignmentId" },
  "committee-member.added.v1": { subjectType: "assignment", idKey: "assignmentId" },
  "ngo.assigned-to-village.v1": { subjectType: "assignment", idKey: "assignmentId" },
  "ngo.registered.v1": { subjectType: "ngo", idKey: "ngoId" },

  // beneficiary-registry — follow-ups and aid records are entities inside the
  // Beneficiary aggregate, so the beneficiary is the subject for all five.
  "beneficiary.aid-recorded.v1": { subjectType: "beneficiary", idKey: "beneficiaryId" },
  "beneficiary.duplicate-aid-flagged.v1": { subjectType: "beneficiary", idKey: "beneficiaryId" },
  "beneficiary.follow-up-completed.v1": { subjectType: "beneficiary", idKey: "beneficiaryId" },
  "beneficiary.follow-up-scheduled.v1": { subjectType: "beneficiary", idKey: "beneficiaryId" },
  "beneficiary.registered.v1": { subjectType: "beneficiary", idKey: "beneficiaryId" },

  // issue-tracking
  "issue.progress-started.v1": { subjectType: "issue", idKey: "issueId" },
  "issue.reported.v1": { subjectType: "issue", idKey: "issueId" },
  "issue.resolved.v1": { subjectType: "issue", idKey: "issueId" },
  "issue.routed.v1": { subjectType: "issue", idKey: "issueId" },
  "issue.verified.v1": { subjectType: "issue", idKey: "issueId" },

  // development-planning — goals and milestones live inside the Plan aggregate.
  "plan.created.v1": { subjectType: "plan", idKey: "planId" },
  "plan.goal-added.v1": { subjectType: "plan", idKey: "planId" },
  "plan.milestone-added.v1": { subjectType: "plan", idKey: "planId" },
  "plan.milestone-completed.v1": { subjectType: "plan", idKey: "planId" },

  // fund-monitoring
  "project.anomaly-flagged.v1": { subjectType: "project", idKey: "projectId" },
  "project.completed.v1": { subjectType: "project", idKey: "projectId" },
  "project.expenditure-recorded.v1": { subjectType: "project", idKey: "projectId" },
  "project.funds-released.v1": { subjectType: "project", idKey: "projectId" },
  "project.sanctioned.v1": { subjectType: "project", idKey: "projectId" },
  "project.verified.v1": { subjectType: "project", idKey: "projectId" },

  // recovery-intelligence — the RecoveryIndex aggregate IS keyed by village
  // (`recovery_intelligence_indices.village_id` is its primary key), so this is
  // the one cross-context event whose natural subject really is the village.
  "recovery.score-calculated.v1": { subjectType: "village", idKey: "villageId" },

  // village-registry
  "village.damage-assessed.v1": { subjectType: "village", idKey: "villageId" },
  "village.profile-corrected.v1": { subjectType: "village", idKey: "villageId" },
  "village.registered.v1": { subjectType: "village", idKey: "villageId" },
  "village.severity-updated.v1": { subjectType: "village", idKey: "villageId" },

  // volunteer-management — an assignment is an entity inside the Volunteer
  // aggregate, so `volunteer.assigned.v1` is about the volunteer even though it
  // also carries `assignmentId` and `villageId`.
  "volunteer.assigned.v1": { subjectType: "volunteer", idKey: "volunteerId" },
  "volunteer.availability-changed.v1": { subjectType: "volunteer", idKey: "volunteerId" },
  "volunteer.hours-logged.v1": { subjectType: "volunteer", idKey: "volunteerId" },
  "volunteer.registered.v1": { subjectType: "volunteer", idKey: "volunteerId" },
};

/**
 * The subject of an event, or nulls when we cannot tell.
 *
 * AN UNMAPPED EVENT IS STILL RECORDED. This is the one behaviour in this file
 * that must never be "tidied up" into a throw or a skip: losing the row because
 * the map was not updated is exactly the failure an audit log exists to prevent,
 * and it is undetectable afterwards — you cannot notice the record that was
 * never written. A row with a null subject is a row that answers "who did what
 * and when" completely and "to what" only through its payload, which is a
 * degraded record rather than an absent one.
 *
 * A mapped event whose payload is missing the id (or holds a non-string there)
 * takes the same path, for the same reason.
 */
export function subjectOf(event: DomainEvent): {
  subjectType: string | null;
  subjectId: string | null;
} {
  const rule = AUDIT_SUBJECTS[event.name];
  if (rule === undefined) return { subjectType: null, subjectId: null };

  const raw = (event.payload as Record<string, unknown>)[rule.idKey];
  if (typeof raw !== "string" || raw.length === 0) {
    return { subjectType: rule.subjectType, subjectId: null };
  }
  return { subjectType: rule.subjectType, subjectId: raw };
}

/**
 * Flattens the three-case `EventActor` union onto three nullable columns.
 *
 * The union (ADR 0010) keeps `user`, `system` and `anonymous` apart precisely
 * because collapsing them loses a distinction that only an audit trail cares
 * about. Flattening it onto `actor_id` / `actor_email` / `actor_role` is exactly
 * the collapse the union was built to avoid, so the identifying detail has to go
 * somewhere or the whole point of ADR 0010 dies at the storage boundary:
 *
 *   user       → id, email, role verbatim.
 *   system     → 'system:anomaly-sweep' in actor_role, id and email null.
 *   anonymous  → 'anonymous:legacy-token' in actor_role, id and email null.
 *   unstamped  → all three null.
 *
 * WHY `actor_role` AND NOT A NEW COLUMN. ADR 0011 fixes the table's columns and
 * an `actor_kind` column would be a departure from the spec taken unilaterally;
 * more importantly, `actor_role` already answers the question "in what capacity
 * was this done", and "as the anomaly sweep" is a truthful answer to it.
 * `actor_email` was the other candidate and is wrong: a process name is not an
 * address, and any consumer that mails an actor would then mail
 * `system:anomaly-sweep`.
 *
 * WHY A PREFIX AND NOT A BARE NAME. Application roles are bare identifiers —
 * `admin`, `district_officer`, `ngo_coordinator` — and none contains a colon, so
 * `system:` and `anonymous:` cannot be mistaken for one and cannot collide with
 * a role invented later unless someone names a role `system:something`. A report
 * filtering `actor_role = 'admin'` is unaffected.
 *
 * WHAT IT COSTS, so the next reader is not surprised: anything that groups by
 * `actor_role` sees `system:anomaly-sweep` and `system:duplicate-sweep` as two
 * distinct roles rather than one kind, and any future code that parses this
 * column must know about the two prefixes. Both constants are exported above so
 * it can.
 *
 * ALL THREE NULLS MEAN A FOURTH THING and it is not "system". An unstamped event
 * (`event.actor === undefined`) was published through a composition path with no
 * `ActorStampingPublisher` — a gap in the wiring, not a fact about who acted.
 * Inventing a `system` actor for it would turn a wiring bug into a permanent,
 * plausible-looking lie in the audit trail; leaving all three columns null keeps
 * it visible as the gap it is.
 */
export function flattenActor(actor: EventActor | undefined): {
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
} {
  if (actor === undefined) return { actorId: null, actorEmail: null, actorRole: null };

  switch (actor.kind) {
    case "user":
      return { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role };
    case "system":
      return {
        actorId: null,
        actorEmail: null,
        actorRole: `${SYSTEM_ACTOR_ROLE_PREFIX}${actor.name}`,
      };
    case "anonymous":
      return {
        actorId: null,
        actorEmail: null,
        actorRole: `${ANONYMOUS_ACTOR_ROLE_PREFIX}${actor.via}`,
      };
  }
}

/** The row an event becomes, before the database assigns `id` and `recorded_at`. */
export function auditEntryOf(event: DomainEvent): AuditEntry {
  const actor = flattenActor(event.actor);
  const subject = subjectOf(event);
  return {
    id: null,
    eventName: event.name,
    occurredAt: event.occurredAt,
    recordedAt: null,
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    requestId: event.requestId ?? null,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    payload: event.payload as Record<string, unknown>,
  };
}

/** Row shape of `assam_floods.audit_log` on the way in. */
interface AuditInsertRow {
  readonly event_name: string;
  readonly occurred_at: string;
  readonly actor_id: string | null;
  readonly actor_email: string | null;
  readonly actor_role: string | null;
  readonly request_id: string | null;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly payload: Record<string, unknown>;
}

/** Row shape on the way out — the insert row plus what the database assigned. */
interface AuditSelectRow extends AuditInsertRow {
  readonly id: number | string;
  readonly recorded_at: string;
}

function insertRowOf(entry: AuditEntry): AuditInsertRow {
  return {
    event_name: entry.eventName,
    occurred_at: entry.occurredAt,
    actor_id: entry.actorId,
    actor_email: entry.actorEmail,
    actor_role: entry.actorRole,
    request_id: entry.requestId,
    subject_type: entry.subjectType,
    subject_id: entry.subjectId,
    payload: entry.payload,
  };
}

function entryOfRow(row: AuditSelectRow): AuditEntry {
  return {
    id: String(row.id),
    eventName: row.event_name,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    requestId: row.request_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload ?? {},
  };
}

/**
 * A filter checked at the boundary, with the caller's mistakes already turned
 * into refusals and their omissions into defaults.
 */
interface NormalisedFilter {
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly actorId: string | null;
  readonly eventName: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}

/**
 * Validates and defaults a filter. Shared by both adapters so "what does
 * `limit: 0` mean" has one answer rather than one per implementation.
 */
function normaliseFilter(filter: AuditFilter): Result<NormalisedFilter> {
  if (filter.subjectId !== undefined && filter.subjectType === undefined) {
    return err("subjectId requires subjectType: record ids are only unique within a type");
  }
  if (filter.from !== undefined && Number.isNaN(Date.parse(filter.from))) {
    return err(`from is not a valid ISO-8601 instant: ${filter.from}`);
  }
  if (filter.to !== undefined && Number.isNaN(Date.parse(filter.to))) {
    return err(`to is not a valid ISO-8601 instant: ${filter.to}`);
  }
  // The cursor is an `id` and ids are positive integers. Checked rather than
  // trusted because it arrives from a query string and goes into a predicate.
  if (filter.cursor !== undefined && !/^[0-9]+$/.test(filter.cursor)) {
    return err(`cursor is not a valid audit cursor: ${filter.cursor}`);
  }

  const requested = filter.limit ?? DEFAULT_AUDIT_PAGE_SIZE;
  if (!Number.isInteger(requested) || requested < 1) {
    return err(`limit must be a positive integer: ${String(filter.limit)}`);
  }

  return ok({
    subjectType: filter.subjectType ?? null,
    subjectId: filter.subjectId ?? null,
    actorId: filter.actorId ?? null,
    eventName: filter.eventName ?? null,
    from: filter.from ?? null,
    to: filter.to ?? null,
    // Clamped, not refused: a caller asking for more than the ceiling gets the
    // ceiling and a cursor, which is the same data one round trip later.
    limit: Math.min(requested, MAX_AUDIT_PAGE_SIZE),
    cursor: filter.cursor ?? null,
  });
}

/**
 * Durable `AuditLog` (ADR 0011): every domain event, append-only.
 *
 * Constructed like every other Supabase adapter — the service-role client plus
 * the schema. Writes and reads bypass RLS; 00006 grants this role `select` and
 * `insert` and revokes `update`, `delete` and `truncate`, so an `update` issued
 * from here fails at the database rather than succeeding quietly. Read that
 * file's header for what those privileges do and do not protect against.
 */
export class SupabaseAuditLog implements AuditLog {
  /**
   * @param schema Postgres schema holding the AFRIP tables. Defaults to
   * AFRIP_SCHEMA rather than the client's own default, which is `public` — a
   * schema owned by other applications in this shared project.
   */
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string = AFRIP_SCHEMA,
  ) {}

  /** Every query goes through here, so no call can forget the schema. */
  private table() {
    return this.client.schema(this.schema).from(AUDIT_LOG_TABLE);
  }

  /**
   * Appends one row. THROWS if it does not land — see the `AuditLog` port for
   * why this adapter reports rather than decides.
   *
   * `insert`, never `upsert`. There is no conflict target to upsert on (`id` is
   * database-assigned) and, more to the point, an audit log has no notion of
   * "the same row again": two identical events genuinely happened twice, and
   * collapsing them would under-report. The consequence is that a redelivered
   * event produces a second row — duplication, which is visible and correctable
   * by a reader, rather than loss, which is not.
   */
  async record(event: DomainEvent): Promise<void> {
    const row = insertRowOf(auditEntryOf(event));
    const result = await this.table().insert(row);
    if (result.error) {
      throw new Error(
        `audit insert into ${this.schema}.${AUDIT_LOG_TABLE} failed: ${result.error.message}`,
      );
    }
  }

  /**
   * Reads a page of the log, newest first.
   *
   * Every filter is applied SERVER-SIDE. Fetching a window and filtering it in
   * the API would silently return fewer rows than the page size while claiming
   * there are more, which for an audit report reads as "there is nothing else".
   *
   * `limit + 1` rows are asked for and at most `limit` are returned: the extra
   * row is how we know whether a next page exists without a second count query,
   * and it is why `nextCursor` is null on the last page rather than pointing at
   * an empty one.
   */
  async query(filter: AuditFilter): Promise<Result<AuditPage>> {
    const normalised = normaliseFilter(filter);
    if (!normalised.ok) return normalised;
    const f = normalised.value;

    try {
      let builder = this.table().select(AUDIT_COLUMNS);
      if (f.subjectType !== null) builder = builder.eq("subject_type", f.subjectType);
      if (f.subjectId !== null) builder = builder.eq("subject_id", f.subjectId);
      if (f.actorId !== null) builder = builder.eq("actor_id", f.actorId);
      if (f.eventName !== null) builder = builder.eq("event_name", f.eventName);
      if (f.from !== null) builder = builder.gte("occurred_at", f.from);
      if (f.to !== null) builder = builder.lte("occurred_at", f.to);
      // Keyset: strictly older than the last row of the previous page. See
      // `AuditPage.nextCursor` for why this is not an offset.
      if (f.cursor !== null) builder = builder.lt("id", f.cursor);

      const result = await builder.order("id", { ascending: false }).limit(f.limit + 1);
      if (result.error) return err(`audit query failed: ${result.error.message}`);

      return ok(pageOf((result.data ?? []) as AuditSelectRow[], f.limit));
    } catch (error) {
      // A rejection rather than an error payload: DNS, TLS, a dead host.
      return err(`audit query failed: ${reason(error)}`);
    }
  }
}

function pageOf(rows: readonly AuditSelectRow[], limit: number): AuditPage {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(entryOfRow);
  const last = page[page.length - 1];
  return {
    entries: page,
    nextCursor: hasMore && last !== undefined ? last.id : null,
  };
}

/**
 * `AuditLog` for memory-mode runtimes and tests.
 *
 * Memory mode is what `PERSISTENCE=memory` and four still-undurable bounded
 * contexts run on, and an audit log that only exists when Supabase is configured
 * would leave those paths silently unaudited — the failure mode ADR 0011's
 * subscriber design exists to rule out. Its rows die with the process, which is
 * the same guarantee the data it describes has in that mode, so nothing is
 * inconsistent; it is not a durability claim.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly rows: AuditEntry[] = [];
  private nextId = 1;

  /**
   * @param now Injected so tests can pin `recordedAt`. The database assigns this
   * column in the Supabase adapter, which is why it is not on `DomainEvent`.
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(event: DomainEvent): Promise<void> {
    const entry = auditEntryOf(event);
    this.rows.push({
      ...entry,
      id: String(this.nextId),
      recordedAt: this.now().toISOString(),
    });
    this.nextId += 1;
  }

  async query(filter: AuditFilter): Promise<Result<AuditPage>> {
    const normalised = normaliseFilter(filter);
    if (!normalised.ok) return normalised;
    const f = normalised.value;

    // Newest first, matching the adapter's `order("id", desc)` — the two must
    // agree or a runtime behaves differently under `PERSISTENCE=memory` than it
    // does in production, which is the class of bug tests cannot see.
    const matched = this.rows
      .filter((row) => {
        if (f.subjectType !== null && row.subjectType !== f.subjectType) return false;
        if (f.subjectId !== null && row.subjectId !== f.subjectId) return false;
        if (f.actorId !== null && row.actorId !== f.actorId) return false;
        if (f.eventName !== null && row.eventName !== f.eventName) return false;
        if (f.from !== null && Date.parse(row.occurredAt) < Date.parse(f.from)) return false;
        if (f.to !== null && Date.parse(row.occurredAt) > Date.parse(f.to)) return false;
        if (f.cursor !== null && Number(row.id) >= Number(f.cursor)) return false;
        return true;
      })
      .sort((a, b) => Number(b.id) - Number(a.id));

    const hasMore = matched.length > f.limit;
    const page = matched.slice(0, f.limit);
    const last = page[page.length - 1];
    return ok({ entries: page, nextCursor: hasMore && last !== undefined ? last.id : null });
  }

  /** Everything recorded, oldest first. For assertions, not for reporting. */
  get recorded(): readonly AuditEntry[] {
    return this.rows;
  }
}

/** The slice of the event bus the subscriber needs (ADR 0011, London-style seam). */
export interface EventBusSubscription {
  subscribeAll(handler: (event: DomainEvent) => Promise<void>): void;
}

/** What `GET /health` can disclose about audit writes that did not land. */
export interface AuditWriteFailure {
  readonly eventName: string;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface AuditWriteStats {
  readonly failedWrites: number;
  readonly lastFailure: AuditWriteFailure | null;
}

/** The marker to grep for in the API logs. Exported so a test can assert it. */
export const AUDIT_WRITE_FAILED_MARKER = "[api] AUDIT WRITE FAILED";

/**
 * Writes every published domain event to the audit log (ADR 0011).
 *
 * Registered against the bus in the composition root via `subscribeAll`. No use
 * case calls it and no use case knows it exists, which is the point: a developer
 * cannot forget to audit a new operation because the obligation was never
 * theirs, and a tenth bounded context is audited the day it is wired.
 *
 * ===========================================================================
 * FAILURE POLICY: A FAILED WRITE IS SWALLOWED, LOGGED IN FULL, AND COUNTED.
 * ===========================================================================
 * It does not throw. This is the most consequential decision in the file and
 * both options are genuinely bad, so here is the whole argument.
 *
 * ADR 0011 says the write must "never be made asynchronous-and-lossy — a dropped
 * audit row is worse than a slow request". That sentence is honoured, and it is
 * about a different axis than this one: the write stays SYNCHRONOUS and AWAITED
 * inside `publish`, so a slow audit store back-pressures the request instead of
 * being fired into the background (see `InMemoryEventBus.subscribeAll`). What
 * the ADR does not decide is what to do when the write does not merely take a
 * long time but fails outright.
 *
 * THROWING WOULD LIE. This subscriber runs after the use case has saved its
 * aggregate and published its event: the village IS registered and the row IS
 * committed by the time we get here. Propagating the failure would fail an HTTP
 * request whose data change has already happened — the same lie
 * `SupabaseOwnershipRegistry.record` refuses to tell, and with a worse
 * consequence, because the caller's natural response to a 500 is to retry. A
 * retried registration either duplicates the record or collides on an id the
 * client was told did not exist. That trades a missing audit row for a
 * fabricated village, and this platform has already learned which of those is
 * worse: the 2026-07-28 incident's own conclusion is that "fabrication is worse
 * than deletion and harder to notice".
 *
 * SWALLOWING LOSES A ROW, and an audit gap is invisible by construction — you
 * cannot see the record that was never written. That is why "swallow" here means
 * something quite specific, and none of it is optional:
 *
 *   1. The complete row is logged as JSON under a fixed marker. Cloud Run's logs
 *      are outside the API's control and retained independently, so the log line
 *      IS a degraded second copy: the row can be reconstructed and inserted by
 *      hand from it. This is the concrete lesson of the id-collision incident,
 *      where the equivalent line did not exist and a village became
 *      unrecoverable.
 *   2. `failedWrites` counts them and `lastFailure` names the most recent, so
 *      `GET /health` can report a number an operator can alert on. A gap you can
 *      count is a different thing from a gap you cannot.
 *   3. The failure is never summarised. Every failed event gets its own line,
 *      because one line per lost row is what makes reconstruction possible.
 *
 * THE REAL FIX IS NEITHER OF THESE. The audit row should be written in the SAME
 * TRANSACTION as the aggregate, so that "the change happened" and "the change
 * was recorded" are one atomic fact and this dilemma cannot arise. This
 * architecture cannot currently do that: each repository issues its own PostgREST
 * call over HTTP, there is no unit of work spanning a use case, and the
 * subscriber sits downstream of the save by design. The two routes there are a
 * transactional outbox (write the event beside the aggregate, deliver later —
 * note `domain_events_outbox` already exists and has never been written to) or
 * event sourcing, which ADR 0011 names as the natural end state and rejects as
 * too large a change now. Until one of those lands, this class is choosing which
 * of two failures to have, and it chooses the loud, countable, reconstructible
 * one.
 */
export class AuditLogSubscriber {
  private failures = 0;
  private lastFailure: AuditWriteFailure | null = null;

  constructor(private readonly log: AuditLog) {}

  /**
   * Wires this subscriber to a bus. Separate from the constructor so that
   * constructing one has no side effect — a composition root that builds the
   * object and then decides not to use it should not have subscribed.
   */
  subscribeTo(bus: EventBusSubscription): void {
    bus.subscribeAll(async (event) => {
      await this.handle(event);
    });
  }

  /** Exposed for tests and for any caller that wants to write one event by hand. */
  async handle(event: DomainEvent): Promise<void> {
    try {
      await this.log.record(event);
    } catch (error) {
      this.failures += 1;
      this.lastFailure = {
        eventName: event.name,
        occurredAt: event.occurredAt,
        reason: reason(error),
      };
      this.warn(event, reason(error));
    }
  }

  /** Failed audit writes since this process started. Surfaced on `GET /health`. */
  get failedWrites(): number {
    return this.failures;
  }

  /** The counter plus the most recent failure, for `GET /health` to render. */
  stats(): AuditWriteStats {
    return { failedWrites: this.failures, lastFailure: this.lastFailure };
  }

  /**
   * The one log line that makes a lost audit row recoverable.
   *
   * It carries the ENTIRE row rather than a summary, because the point is not to
   * announce that something went wrong — the counter does that — but to let an
   * operator paste the row back in. Anything omitted here is gone for good.
   *
   * `console.error`, not `warn`: a missing audit row on a platform whose stated
   * purpose is that records do not vanish is an error, and it should be visible
   * at whatever severity the deployment filters to.
   */
  private warn(event: DomainEvent, detail: string): void {
    let row: string;
    try {
      row = JSON.stringify(insertRowOf(auditEntryOf(event)));
    } catch {
      // A payload that will not serialise (a cycle, a BigInt) must not cost us
      // the log line as well as the row.
      row = `<unserialisable payload for ${event.name} at ${event.occurredAt}>`;
    }
    console.error(
      `${AUDIT_WRITE_FAILED_MARKER} ${event.name}: ${detail} — the change it describes DID happen ` +
        `and is committed; only this audit row was lost. Reinsert it into ` +
        `${AUDIT_LOG_TABLE} from the row below, and check that ` +
        `00006_audit_log.sql has been applied to this project. row=${row}`,
    );
  }
}

/**
 * Builds a subscriber and wires it to the bus in one step, for composition
 * roots that have no reason to hold the intermediate object.
 */
export function attachAuditLog(bus: EventBusSubscription, log: AuditLog): AuditLogSubscriber {
  const subscriber = new AuditLogSubscriber(log);
  subscriber.subscribeTo(bus);
  return subscriber;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
