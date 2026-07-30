import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFRIP_SCHEMA,
  RandomIdGenerator,
  err,
  ok,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";

/**
 * In-app feedback (ADR 0016): a report filed from inside the application by the
 * person using it, with the build, the view and the account already attached.
 *
 * Shaped like `audit.ts` on purpose — a port, a Supabase adapter, an in-memory
 * adapter, and one shared normaliser so that "what does `limit: 0` mean" has a
 * single answer rather than one per implementation. The differences from the
 * audit log are the interesting part and each is argued where it appears:
 * this table is not append-only, the reader set is narrower, and the ids carry
 * no order so the paging key is not the id.
 */

/** The table `00009_feedback.sql` creates. One row per report. */
export const FEEDBACK_TABLE = "feedback";

/**
 * Every column of that table, in its declared order.
 *
 * Spelled out rather than `select("*")` so that a column added to the migration
 * and not to `FeedbackReport` is a compile error here instead of a field that
 * silently never reaches an administrator.
 */
export const FEEDBACK_COLUMNS =
  "id,kind,summary,detail,build_commit,build_branch,view_path,user_agent," +
  "reporter_id,reporter_email,reporter_role,status,created_at";

/**
 * What a report is about. ADR 0016 §Storage, and the same three values as the
 * `check` constraint on `feedback.kind` — a fourth added here and not there
 * produces a row Postgres refuses to write.
 */
export const FEEDBACK_KINDS = ["bug", "feature", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * Where a report has got to. Mirrors the `check` constraint on
 * `feedback.status`, same caveat as above.
 *
 * There is no assignment, no comment thread and no notification, and ADR 0016
 * §Status says why: those are the parts of an issue tracker that earn their keep
 * at a scale this platform is nowhere near, and building them now would produce
 * a worse GitHub with one user. This column is the whole workflow.
 */
export const FEEDBACK_STATUSES = ["open", "acknowledged", "resolved", "declined"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** What a report starts as, and the column default in 00009. */
export const DEFAULT_FEEDBACK_STATUS: FeedbackStatus = "open";

/**
 * The one line of a feature request that other signed-in users may read.
 *
 * WHY THIS TYPE EXISTS AT ALL, given ADR 0016 argued for `admin` alone.
 *
 * The argument that produced `admin` alone was about *free text written by
 * somebody nobody has briefed* — it will name beneficiaries, and the reader set
 * for that should be the smallest set that can act on it. That argument is
 * untouched and still governs `GET /feedback`.
 *
 * What it did not anticipate is the cost of a suggestion box nobody can see
 * into: the same idea arrives five times, each reporter believing they are the
 * first, and none of them can tell whether the thing they want is already
 * agreed, already built, or already declined. A backlog only one person can read
 * is not a backlog.
 *
 * SO THE SHAPE IS THE CONTROL, not the role. This is a strictly narrower
 * projection of `FeedbackReport`, and every field absent from it is absent
 * deliberately:
 *
 *   detail        — the long free-text box. This is where a name would be
 *                   written, and it is exactly what ADR 0016 restricted.
 *   reporterId / reporterEmail / reporterRole
 *                 — who complained about what is nobody else's business, and
 *                   an idea's merit does not depend on whose it was.
 *   buildCommit / buildBranch / viewPath / userAgent
 *                 — diagnostics. Useless to a reader, and `viewPath` leaks
 *                   which part of the platform somebody was working in.
 *
 * `summary` remains, because without it there is nothing to read, and it is
 * capped at 200 characters — one line, typed under a heading that now says it
 * will be visible to other signed-in users. That disclosure is the second half
 * of this decision and is not optional: `bug` and `other` reports are NOT
 * exposed, so nobody's private report becomes public retroactively.
 */
export interface FeedbackSuggestion {
  readonly id: string;
  readonly summary: string;
  readonly status: FeedbackStatus;
  readonly createdAt: string;
}

/**
 * The only kind of report that is readable by every signed-in user.
 *
 * A single value rather than a list, and it is `feature` rather than `bug`
 * because of what each one IS. A feature request describes something the
 * platform does not do — it is about the software. A bug report describes
 * something that went wrong, and the way anybody describes what went wrong is
 * by naming the record it went wrong on. "The aid record for X shows twice" is
 * the useful form of a bug report and the dangerous form of a public one.
 */
export const SHARED_FEEDBACK_KIND: FeedbackKind = "feature";

/**
 * Narrows a stored report to what other signed-in users may see.
 *
 * IN ONE PLACE, and callers must not assemble this shape by hand. A route that
 * spreads the row and deletes three fields is a route that leaks the fourth one
 * added next year; this drops everything by construction, so a new column on
 * `FeedbackReport` is invisible here until somebody deliberately adds it.
 */
export function toSuggestion(report: FeedbackReport): FeedbackSuggestion {
  return {
    id: report.id,
    summary: report.summary,
    status: report.status,
    createdAt: report.createdAt,
  };
}

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === "string" && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Length caps
// ---------------------------------------------------------------------------

/**
 * THE CAPS, AND WHY THEY ARE NOT OPTIONAL.
 *
 * `POST /feedback` is reachable by EVERY signed-in user — that is the point of
 * ADR 0016 — and it writes into two unbounded `text` columns. Without a limit,
 * one account with a script fills the database a megabyte at a time, and the
 * request-body ceiling is no defence: `MAX_BODY_BYTES` is 1 MiB per request and
 * says nothing about how many requests may arrive. An endpoint that any user can
 * reach and that stores whatever it is handed is a storage-exhaustion primitive,
 * not a form.
 *
 * The numbers are chosen to be generous for a real report and useless for
 * filling a disk:
 *
 *   summary     200 — a one-line title. Long enough for "the aid record for the
 *                     beneficiary in Nazira shows twice on the follow-ups tab",
 *                     short enough to render in a list without truncation.
 *   detail    4,000 — several paragraphs, or a pasted stack trace. Roughly two
 *                     sides of A4. Somebody with more to say than this has a
 *                     conversation, not a form field.
 *   context     300 — `buildCommit`, `buildBranch` and `viewPath`. A git SHA is
 *                     40, a branch name rarely 60, a path with query string
 *                     comfortably under 300. Not a guess about what is useful:
 *                     these are machine-supplied, so anything near the cap is a
 *                     client sending something it should not.
 *   userAgent   500 — real UA strings reach ~350 on some Android WebViews.
 *
 * MEASURED IN UTF-16 CODE UNITS (JavaScript `.length`), not characters and not
 * bytes. Assamese and Devanagari are on the basic plane so one unit is one
 * character there, but an emoji counts two and a byte-oriented reader would
 * count four. Nothing downstream depends on the exact unit — the column is
 * unbounded `text` and 00009 explains why the cap lives here rather than in a
 * check constraint — so the cheapest consistent measure is the honest one. What
 * matters is that it is bounded, and by how much.
 *
 * Enforced at the HTTP boundary with a 400 (`routes/feedback.ts`), and again in
 * `normaliseDraft` below so that a caller reaching a store directly cannot slip
 * past the route.
 */
export const MAX_SUMMARY_LENGTH = 200;
export const MAX_DETAIL_LENGTH = 4_000;
export const MAX_CONTEXT_LENGTH = 300;
export const MAX_USER_AGENT_LENGTH = 500;

/** Rows returned when a filter does not say otherwise. */
export const DEFAULT_FEEDBACK_PAGE_SIZE = 50;

/**
 * The most rows one query may return, whatever the caller asked for. Same
 * reasoning as `MAX_AUDIT_PAGE_SIZE`: a ceiling rather than a suggestion, and
 * the caller who wants everything has `nextCursor` for exactly that.
 */
export const MAX_FEEDBACK_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The context captured automatically. The user types none of it (ADR 0016).
 *
 * Every field is nullable because every field can genuinely be unknown: an
 * un-stamped build has no commit, and a client that sends none of this still
 * files a valid report. A missing commit is worth having as a null — "we do not
 * know which revision this was" — rather than as an invented empty string.
 *
 * What is deliberately NOT here: geolocation, IP, or any identifier beyond the
 * account already signed in (ADR 0016 §"Context is captured, location is not").
 * If you are about to add one, that section is the argument you have to beat.
 */
export interface FeedbackContext {
  readonly buildCommit: string | null;
  readonly buildBranch: string | null;
  readonly viewPath: string | null;
  readonly userAgent: string | null;
}

/**
 * Who filed it, flattened onto three columns for the same reason `audit_log`
 * denormalises its actor (ADR 0011): a report that resolves its reporter through
 * a foreign key becomes unreadable the moment the account is deleted, which on a
 * report still being worked is exactly when the reader needs to know whom to go
 * back to.
 *
 * THIS IS NEVER BUILT FROM A REQUEST BODY. `routes/feedback.ts` builds it from
 * `ctx.actor` and nothing else; a client that puts `reporterEmail` in its JSON
 * is ignored. See that file for the argument and `feedback-routes.test.ts` for
 * the test that fails if somebody changes it.
 */
export interface FeedbackReporter {
  readonly id: string | null;
  readonly email: string | null;
  readonly role: string | null;
}

/** A report on the way in, before the store assigns `id`, `status` and `createdAt`. */
export interface FeedbackDraft {
  readonly kind: FeedbackKind;
  readonly summary: string;
  readonly detail: string | null;
  readonly context: FeedbackContext;
  readonly reporter: FeedbackReporter;
}

/**
 * One row of `assam_floods.feedback`.
 *
 * Flat rather than nesting `context` and `reporter`, because this is what an
 * administrator's list renders and what the table stores; the nested shapes
 * above exist on the write path, where "the caller supplies the context but
 * never the reporter" is the distinction worth making unmissable in the types.
 */
export interface FeedbackReport {
  readonly id: string;
  readonly kind: FeedbackKind;
  readonly summary: string;
  readonly detail: string | null;
  readonly buildCommit: string | null;
  readonly buildBranch: string | null;
  readonly viewPath: string | null;
  readonly userAgent: string | null;
  readonly reporterId: string | null;
  readonly reporterEmail: string | null;
  readonly reporterRole: string | null;
  readonly status: FeedbackStatus;
  readonly createdAt: string;
}

/** What `GET /feedback` accepts. Both filters are exact-match on a closed set. */
export interface FeedbackFilter {
  readonly kind?: string;
  readonly status?: string;
  readonly limit?: number;
  /** Opaque; hand back `FeedbackPage.nextCursor` verbatim. */
  readonly cursor?: string;
}

export interface FeedbackPage {
  readonly reports: readonly FeedbackReport[];
  /**
   * Pass as `cursor` for the next page, or null when this was the last one.
   *
   * KEYSET ON `(created_at, id)`, NOT OFFSET, and not on the id alone.
   *
   * Not an offset for the reason `AuditPage.nextCursor` gives: rows arrive while
   * a reader is paging, the list is newest-first, so every insert shifts the
   * window by one and page 2 repeats a row page 1 already showed. In a triage
   * queue that is not merely untidy — a report seen twice and a report never seen
   * look the same to the person working through the list, and the one that is
   * never seen is the failure this whole ADR exists to prevent.
   *
   * Not the id alone, which is where this differs from the audit log: `audit_log`
   * has a `bigint identity` primary key that is monotonic with insertion, so its
   * id IS a valid keyset key. Feedback ids are `feedback-<uuid4>` (00009 explains
   * the choice), and a random id has no order at all — keying on it would page in
   * an arbitrary sequence that has nothing to do with the sort the reader sees.
   * So the key is the sort column plus the id as a tiebreaker, which is unique by
   * construction and therefore cannot skip or repeat a row when two reports share
   * a timestamp.
   */
  readonly nextCursor: string | null;
}

/**
 * Outbound port: the feedback queue (ADR 0016).
 *
 * All three methods return a `Result` rather than throwing, because all three
 * have a caller who can be told. That is the opposite of `AuditLog.record`,
 * which throws — and the difference is not a style choice. An audit write
 * happens AFTER a use case has already committed, so its failure is nobody's
 * request to fail; a feedback submission IS the request, and the honest answer to
 * "did my bug report get through?" is yes or no. Reporting success for a row that
 * was never written would send the user away believing they had been heard.
 *
 * `setStatus` resolves to `null` for an id that matches no row, so the route can
 * answer 404. An error is reserved for "the store could not be asked".
 */
export interface FeedbackStore {
  submit(draft: FeedbackDraft): Promise<Result<FeedbackReport>>;
  query(filter: FeedbackFilter): Promise<Result<FeedbackPage>>;
  setStatus(id: string, status: FeedbackStatus): Promise<Result<FeedbackReport | null>>;
}

// ---------------------------------------------------------------------------
// Normalisation, shared by both adapters
// ---------------------------------------------------------------------------

/**
 * Validates and tidies a draft: the caps above, the closed `kind` set, and the
 * whitespace rules.
 *
 * Called by BOTH adapters and by the route. The route's copy is what turns a bad
 * draft into a 400 with a message the user can act on; the adapters' copies are
 * why a future caller that reaches a store directly — a CLI, a backfill, a
 * second route — cannot write an unbounded row by not knowing about the caps.
 * Duplicated work on the happy path, and the duplication is the point: a limit
 * enforced in exactly one place is a limit that a second call site removes.
 *
 * `summary` is trimmed and must be non-empty afterwards. A report whose title is
 * three spaces is not a report, and storing it would put a blank line in the
 * administrator's list that nobody can act on or tell apart from the next one.
 * `detail` is trimmed too, and an empty result becomes null rather than "" —
 * "they wrote nothing" and "they wrote a space" are the same fact and should
 * have one representation in the column.
 */
export function normaliseDraft(draft: FeedbackDraft): Result<FeedbackDraft> {
  if (!isFeedbackKind(draft.kind)) {
    return err(`kind must be one of ${FEEDBACK_KINDS.join(", ")}: ${String(draft.kind)}`);
  }

  const summary = draft.summary.trim();
  if (summary.length === 0) return err("summary is required");
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return err(`summary must be at most ${MAX_SUMMARY_LENGTH} characters`);
  }

  const detail = draft.detail === null ? null : draft.detail.trim();
  if (detail !== null && detail.length > MAX_DETAIL_LENGTH) {
    return err(`detail must be at most ${MAX_DETAIL_LENGTH} characters`);
  }

  const context = normaliseContext(draft.context);
  if (!context.ok) return context;

  return ok({
    kind: draft.kind,
    summary,
    detail: detail === null || detail.length === 0 ? null : detail,
    context: context.value,
    reporter: draft.reporter,
  });
}

/** Caps and blank-collapsing for the four automatically-captured fields. */
function normaliseContext(context: FeedbackContext): Result<FeedbackContext> {
  const fields: ReadonlyArray<[keyof FeedbackContext, number]> = [
    ["buildCommit", MAX_CONTEXT_LENGTH],
    ["buildBranch", MAX_CONTEXT_LENGTH],
    ["viewPath", MAX_CONTEXT_LENGTH],
    ["userAgent", MAX_USER_AGENT_LENGTH],
  ];

  const out: Record<string, string | null> = {};
  for (const [field, cap] of fields) {
    const raw = context[field];
    if (raw === null) {
      out[field] = null;
      continue;
    }
    if (raw.length > cap) return err(`${field} must be at most ${cap} characters`);
    const trimmed = raw.trim();
    out[field] = trimmed.length === 0 ? null : trimmed;
  }
  return ok(out as unknown as FeedbackContext);
}

/** A cursor, decomposed. See `FeedbackPage.nextCursor` for why it has two parts. */
interface FeedbackCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * The separator between the two halves of a cursor.
 *
 * `|` because a Postgres timestamp cannot contain one, so splitting on the first
 * occurrence is unambiguous however the id is spelled.
 */
const CURSOR_SEPARATOR = "|";

export function encodeFeedbackCursor(report: FeedbackReport): string {
  return `${report.createdAt}${CURSOR_SEPARATOR}${report.id}`;
}

/**
 * Parses a cursor, STRICTLY.
 *
 * This is checked rather than trusted for a reason beyond ordinary hygiene: in
 * the Supabase adapter the two halves are interpolated into a PostgREST `or=(…)`
 * expression, whose mini-language uses `,` `(` `)` and `.` as syntax. A cursor
 * carrying a comma would not be a broken filter, it would be an EXTRA one, and
 * the caller supplies this string from a query parameter. The character classes
 * below admit exactly what our own values contain — an ISO-8601 instant and a
 * `feedback-<uuid4>` id — and nothing that the filter grammar would read as
 * structure.
 */
function parseCursor(raw: string): Result<FeedbackCursor> {
  const at = raw.indexOf(CURSOR_SEPARATOR);
  if (at < 0) return err(`cursor is not a valid feedback cursor: ${raw}`);

  const createdAt = raw.slice(0, at);
  const id = raw.slice(at + 1);

  // Digits, the date/time punctuation, and the zone suffix. No commas, no
  // parentheses, no spaces beyond the one SQL-style separator Postgres may use.
  if (!/^[0-9T:.+\-Z ]{10,40}$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    return err(`cursor timestamp is not an ISO-8601 instant: ${createdAt}`);
  }
  // Our ids are `feedback-<uuid4>`; the class is a little wider so that a
  // hand-inserted row with a different id spelling can still be paged past.
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
    return err(`cursor id is not a valid feedback id: ${id}`);
  }
  return ok({ createdAt, id });
}

/** A filter with the caller's mistakes turned into refusals and omissions into defaults. */
export interface NormalisedFeedbackFilter {
  readonly kind: FeedbackKind | null;
  readonly status: FeedbackStatus | null;
  readonly limit: number;
  readonly cursor: FeedbackCursor | null;
}

/**
 * Validates and defaults a filter. Shared by both adapters — and by the route,
 * for the same reason `normaliseDraft` is: the route needs to turn a caller's
 * mistake into a 400 that names the field, and the adapters need to be unable to
 * be handed one by a caller that skipped the route.
 *
 * An unrecognised `kind` or `status` is REFUSED rather than ignored. Ignoring it
 * would answer `?status=opne` with every report on the platform while the reader
 * believes they are looking at the open ones — a wrong answer that looks exactly
 * like a right one, which is the class of mistake this endpoint can least afford
 * given nobody is notified and the list is all anyone ever sees.
 */
export function normaliseFeedbackFilter(filter: FeedbackFilter): Result<NormalisedFeedbackFilter> {
  if (filter.kind !== undefined && !isFeedbackKind(filter.kind)) {
    return err(`kind must be one of ${FEEDBACK_KINDS.join(", ")}: ${filter.kind}`);
  }
  if (filter.status !== undefined && !isFeedbackStatus(filter.status)) {
    return err(`status must be one of ${FEEDBACK_STATUSES.join(", ")}: ${filter.status}`);
  }

  const requested = filter.limit ?? DEFAULT_FEEDBACK_PAGE_SIZE;
  if (!Number.isInteger(requested) || requested < 1) {
    return err(`limit must be a positive integer: ${String(filter.limit)}`);
  }

  let cursor: FeedbackCursor | null = null;
  if (filter.cursor !== undefined && filter.cursor !== "") {
    const parsed = parseCursor(filter.cursor);
    if (!parsed.ok) return err(parsed.error);
    cursor = parsed.value;
  }

  return ok({
    kind: filter.kind ?? null,
    status: filter.status ?? null,
    // Clamped, not refused: a caller asking for more than the ceiling gets the
    // ceiling and a cursor, which is the same data one round trip later.
    limit: Math.min(requested, MAX_FEEDBACK_PAGE_SIZE),
    cursor,
  });
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** Row shape of `assam_floods.feedback` on the way in. `status` and `created_at` are the column defaults. */
interface FeedbackInsertRow {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly build_commit: string | null;
  readonly build_branch: string | null;
  readonly view_path: string | null;
  readonly user_agent: string | null;
  readonly reporter_id: string | null;
  readonly reporter_email: string | null;
  readonly reporter_role: string | null;
}

/** Row shape on the way out — the insert row plus what the database assigned. */
interface FeedbackSelectRow extends FeedbackInsertRow {
  readonly status: string;
  readonly created_at: string;
}

function insertRowOf(id: string, draft: FeedbackDraft): FeedbackInsertRow {
  return {
    id,
    kind: draft.kind,
    summary: draft.summary,
    detail: draft.detail,
    build_commit: draft.context.buildCommit,
    build_branch: draft.context.buildBranch,
    view_path: draft.context.viewPath,
    user_agent: draft.context.userAgent,
    reporter_id: draft.reporter.id,
    reporter_email: draft.reporter.email,
    reporter_role: draft.reporter.role,
  };
}

/**
 * Maps a row back onto a report.
 *
 * `kind` and `status` are narrowed defensively rather than cast: the check
 * constraints in 00009 make an out-of-range value impossible through this
 * application, but a hand-edited row or a constraint relaxed in a later
 * migration would otherwise produce a `FeedbackReport` whose type is a lie. An
 * unrecognised status reads as `open`, which is the answer that keeps a report
 * in front of somebody rather than quietly filing it away.
 */
function reportOfRow(row: FeedbackSelectRow): FeedbackReport {
  return {
    id: String(row.id),
    kind: isFeedbackKind(row.kind) ? row.kind : "other",
    summary: row.summary,
    detail: row.detail,
    buildCommit: row.build_commit,
    buildBranch: row.build_branch,
    viewPath: row.view_path,
    userAgent: row.user_agent,
    reporterId: row.reporter_id,
    reporterEmail: row.reporter_email,
    reporterRole: row.reporter_role,
    status: isFeedbackStatus(row.status) ? row.status : DEFAULT_FEEDBACK_STATUS,
    createdAt: row.created_at,
  };
}

function pageOf(reports: readonly FeedbackReport[], limit: number): FeedbackPage {
  const hasMore = reports.length > limit;
  const page = reports.slice(0, limit);
  const last = page[page.length - 1];
  return {
    reports: page,
    nextCursor: hasMore && last !== undefined ? encodeFeedbackCursor(last) : null,
  };
}

/** Newest first, with the id breaking ties. The order both adapters must agree on. */
function newestFirst(a: FeedbackReport, b: FeedbackReport): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when `report` sits strictly after `cursor` in that order. */
function isAfterCursor(report: FeedbackReport, cursor: FeedbackCursor): boolean {
  const reportAt = Date.parse(report.createdAt);
  const cursorAt = Date.parse(cursor.createdAt);
  if (reportAt !== cursorAt) return reportAt < cursorAt;
  return report.id < cursor.id;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Durable `FeedbackStore` (ADR 0016), backed by `assam_floods.feedback`.
 *
 * Constructed like every other Supabase adapter — the service-role client plus
 * the schema. Writes and reads bypass RLS; 00009 grants this role `select`,
 * `insert` and `update` and revokes `delete` and `truncate`, so a delete issued
 * from here fails at the database rather than succeeding quietly. Read that
 * file's header for what those privileges do and do not protect against — in
 * particular, `update` IS granted, so nothing in SQL stops this application from
 * rewriting a user's words. Only `setStatus` below does, and only because it is
 * the sole update this adapter can issue.
 */
export class SupabaseFeedbackStore implements FeedbackStore {
  private readonly ids: IdGenerator;

  /**
   * @param schema Postgres schema holding the AFRIP tables. Defaults to
   * AFRIP_SCHEMA rather than the client's own default, which is `public` — a
   * schema owned by other applications in this shared project.
   * @param ids Injected so tests can pin ids. Production's default is the same
   * CSPRNG-backed generator every other AFRIP id comes from; see
   * `RandomIdGenerator` for the incident that made a counter unacceptable.
   */
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string = AFRIP_SCHEMA,
    ids: IdGenerator = new RandomIdGenerator("feedback"),
  ) {
    this.ids = ids;
  }

  /** Every query goes through here, so no call can forget the schema. */
  private table() {
    return this.client.schema(this.schema).from(FEEDBACK_TABLE);
  }

  /**
   * Writes one report and hands back the row the database actually holds.
   *
   * The insert is followed by a select of the same row, rather than echoing back
   * what we sent, because `status` and `created_at` are column defaults: the API
   * does not know the instant Postgres stamped, and inventing one from the API's
   * clock would put a timestamp in the response that does not match the timestamp
   * in the table — and the response's is the one the page would show.
   *
   * `insert`, never `upsert`. The id is freshly generated, so there is no
   * conflict to resolve, and an upsert would turn an id collision (a bug) into a
   * silent overwrite of somebody else's report — which is precisely the failure
   * mode of the 2026-07-28 incident.
   */
  async submit(draft: FeedbackDraft): Promise<Result<FeedbackReport>> {
    const normalised = normaliseDraft(draft);
    if (!normalised.ok) return normalised;

    const row = insertRowOf(this.ids.next(), normalised.value);
    try {
      const result = await this.table().insert(row).select(FEEDBACK_COLUMNS).maybeSingle();
      if (result.error) return err(`feedback insert failed: ${result.error.message}`);
      if (result.data == null) {
        // The insert reported no error and returned no row. Never report success
        // for a report we cannot show was written: the user would be told they
        // had been heard.
        return err("feedback insert returned no row");
      }
      return ok(reportOfRow(result.data as unknown as FeedbackSelectRow));
    } catch (error) {
      // A rejection rather than an error payload: DNS, TLS, a dead host.
      return err(`feedback insert failed: ${reason(error)}`);
    }
  }

  /**
   * Reads a page of reports, newest first.
   *
   * Every filter is applied SERVER-SIDE, for the reason `SupabaseAuditLog.query`
   * gives: fetching a window and filtering it here would return fewer rows than
   * the page size while claiming there are more.
   *
   * `limit + 1` rows are asked for and at most `limit` are returned: the extra
   * row is how we know whether a next page exists without a second count query,
   * and it is why `nextCursor` is null on the last page rather than pointing at
   * an empty one.
   */
  async query(filter: FeedbackFilter): Promise<Result<FeedbackPage>> {
    const normalised = normaliseFeedbackFilter(filter);
    if (!normalised.ok) return normalised;
    const f = normalised.value;

    try {
      let builder = this.table().select(FEEDBACK_COLUMNS);
      if (f.kind !== null) builder = builder.eq("kind", f.kind);
      if (f.status !== null) builder = builder.eq("status", f.status);
      if (f.cursor !== null) {
        // Keyset on (created_at, id): strictly older, or the same instant and a
        // lower id. Both halves are validated in `parseCursor` before they reach
        // this expression — see the note there about the `or` grammar.
        builder = builder.or(
          `created_at.lt.${f.cursor.createdAt},` +
            `and(created_at.eq.${f.cursor.createdAt},id.lt.${f.cursor.id})`,
        );
      }

      const result = await builder
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(f.limit + 1);
      if (result.error) return err(`feedback query failed: ${result.error.message}`);

      const rows = (result.data ?? []) as unknown as FeedbackSelectRow[];
      return ok(pageOf(rows.map(reportOfRow), f.limit));
    } catch (error) {
      return err(`feedback query failed: ${reason(error)}`);
    }
  }

  /**
   * Moves a report's status, and NOTHING ELSE.
   *
   * This is the only update this adapter can issue, and that is the whole of the
   * protection for a reporter's words: 00009 must grant `update` on the table for
   * `status` to move at all, so SQL cannot distinguish "change the status" from
   * "rewrite the summary". The narrow method is where the distinction lives.
   *
   * Resolves to `null` — not an error — when no row matched, so the route can
   * tell "no such report" from "the store could not be asked". `maybeSingle`
   * rather than `single`, because `single` treats an empty result as an error and
   * we would then be unable to tell those two cases apart.
   */
  async setStatus(id: string, status: FeedbackStatus): Promise<Result<FeedbackReport | null>> {
    if (!isFeedbackStatus(status)) {
      return err(`status must be one of ${FEEDBACK_STATUSES.join(", ")}: ${String(status)}`);
    }
    try {
      const result = await this.table()
        .update({ status })
        .eq("id", id)
        .select(FEEDBACK_COLUMNS)
        .maybeSingle();
      if (result.error) return err(`feedback status update failed: ${result.error.message}`);
      if (result.data == null) return ok(null);
      return ok(reportOfRow(result.data as unknown as FeedbackSelectRow));
    } catch (error) {
      return err(`feedback status update failed: ${reason(error)}`);
    }
  }
}

/**
 * `FeedbackStore` for memory-mode runtimes and tests.
 *
 * Memory mode is what `PERSISTENCE=memory` runs on, and a feedback endpoint that
 * only existed when Supabase was configured would answer 501 on the dev server —
 * so the form could never be exercised before it was deployed, which is the
 * worst moment to discover it does not work. Its rows die with the process,
 * which is the same guarantee the data they describe has in that mode, so
 * nothing is inconsistent; it is not a durability claim.
 */
export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly rows: FeedbackReport[] = [];

  /**
   * @param now Injected so tests can pin `createdAt`. The database assigns this
   * column in the Supabase adapter, which is why it is not on the draft.
   * @param ids Injected for the same reason the Supabase adapter takes one.
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly ids: IdGenerator = new RandomIdGenerator("feedback"),
  ) {}

  async submit(draft: FeedbackDraft): Promise<Result<FeedbackReport>> {
    const normalised = normaliseDraft(draft);
    if (!normalised.ok) return normalised;
    const d = normalised.value;

    const report: FeedbackReport = {
      id: this.ids.next(),
      kind: d.kind,
      summary: d.summary,
      detail: d.detail,
      buildCommit: d.context.buildCommit,
      buildBranch: d.context.buildBranch,
      viewPath: d.context.viewPath,
      userAgent: d.context.userAgent,
      reporterId: d.reporter.id,
      reporterEmail: d.reporter.email,
      reporterRole: d.reporter.role,
      status: DEFAULT_FEEDBACK_STATUS,
      createdAt: this.now().toISOString(),
    };
    this.rows.push(report);
    return ok(report);
  }

  async query(filter: FeedbackFilter): Promise<Result<FeedbackPage>> {
    const normalised = normaliseFeedbackFilter(filter);
    if (!normalised.ok) return normalised;
    const f = normalised.value;

    // Newest first, matching the adapter's two `order` calls — the two must agree
    // or a runtime behaves differently under `PERSISTENCE=memory` than it does in
    // production, which is the class of bug tests cannot see.
    const matched = this.rows
      .filter((row) => {
        if (f.kind !== null && row.kind !== f.kind) return false;
        if (f.status !== null && row.status !== f.status) return false;
        if (f.cursor !== null && !isAfterCursor(row, f.cursor)) return false;
        return true;
      })
      .sort(newestFirst);

    return ok(pageOf(matched, f.limit));
  }

  async setStatus(id: string, status: FeedbackStatus): Promise<Result<FeedbackReport | null>> {
    if (!isFeedbackStatus(status)) {
      return err(`status must be one of ${FEEDBACK_STATUSES.join(", ")}: ${String(status)}`);
    }
    const at = this.rows.findIndex((row) => row.id === id);
    if (at < 0) return ok(null);

    // Replaced wholesale rather than mutated, so a caller holding an earlier
    // `FeedbackReport` still sees the value it was given — the same immutability
    // the Supabase adapter has for free.
    const updated: FeedbackReport = { ...(this.rows[at] as FeedbackReport), status };
    this.rows[at] = updated;
    return ok(updated);
  }

  /** Everything submitted, oldest first. For assertions, not for reporting. */
  get submitted(): readonly FeedbackReport[] {
    return this.rows;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
