import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFRIP_SCHEMA,
  type OwnableRecordType,
  type OwnershipEntry,
  type OwnershipRegistry,
} from "@afrip/shared-kernel";

/**
 * The table `00005_record_ownership.sql` creates. One row per created record,
 * keyed on (record_type, record_id).
 */
export const RECORD_OWNERSHIP_TABLE = "record_ownership";

/**
 * The conflict target for `record`'s upsert — the table's primary key.
 *
 * Spelled out rather than inlined because it must match the primary key in
 * 00005 exactly. PostgREST resolves `on_conflict` against a real unique
 * constraint; a mismatch is not a silently different behaviour, it is a 42P10
 * from Postgres on every write.
 */
export const OWNERSHIP_CONFLICT_TARGET = "record_type,record_id";

/** Row shape of `assam_floods.record_ownership`. */
interface OwnershipRow {
  readonly record_type: string;
  readonly record_id: string;
  readonly owner_id: string;
}

/**
 * Durable `OwnershipRegistry` (ADR 0009): who created which record.
 *
 * Constructed like every other Supabase adapter — the service-role client plus
 * the schema — because ownership is stored beside the data it describes rather
 * than in a second place that can drift.
 *
 * Read and written through the service-role client, which bypasses RLS. The
 * row-level policy in 00005 exists for direct PostgREST access with a
 * publishable key, which is a different door; see that file's header for why
 * RLS is the second line here and not the mechanism.
 */
export class SupabaseOwnershipRegistry implements OwnershipRegistry {
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
    return this.client.schema(this.schema).from(RECORD_OWNERSHIP_TABLE);
  }

  /**
   * Records authorship. First writer wins and a replay is a no-op.
   *
   * `ignoreDuplicates: true` is the whole of that guarantee: it makes the write
   * an `insert ... on conflict do nothing`, so a re-published creation event
   * cannot reassign an owner, and cannot fail either. Without the flag the
   * upsert becomes `do update`, and the second delivery of the same event
   * silently hands the record to whoever replayed it. 00005 revokes UPDATE from
   * every role including service_role precisely so that mistake fails loudly at
   * the database rather than quietly changing history — but do not rely on that
   * to notice it; keep the flag.
   *
   * ON FAILURE THIS LOGS AND RETURNS. It does not throw, and that is a decision
   * with a visible consequence, so here is what the next reader needs:
   *
   *   SYMPTOM: a user creates a village (or issue, volunteer, plan, signal),
   *   the request succeeds and returns 201, and then their own edit of that
   *   record is refused with 403 "Not permitted: citizen may not ...". Nothing
   *   in the edit path is wrong; the ownership row was never written, so
   *   `isOwner` answers false forever. Grep the API logs for the marker below
   *   with the record id from the 403.
   *
   *   MOST LIKELY CAUSE: 00005 was not applied to the project. The insert then
   *   fails with a missing-relation error on EVERY create, so the log line will
   *   be one per creation rather than an isolated blip.
   *
   * The alternative — propagating the failure — was rejected. Ownership is
   * recorded after the creating use case has already succeeded and its event
   * has been published: the village IS registered and the row IS committed.
   * Failing the request at that point would report a failure that did not
   * happen, and the caller's retry would either duplicate the record or hit a
   * conflict on an id they were told did not exist. A degraded edit right is a
   * smaller harm than a lie about whether the write landed.
   *
   * REPAIR IS MANUAL, and do not assume otherwise. `domain_events_outbox` looks
   * like the obvious backfill source and is not: it exists and has never been
   * written to (see docs/incidents/2026-07-28-id-collision-data-loss.md, where
   * the same assumption cost a village record). Domain events go to an
   * in-process bus and are discarded. Until ADR 0011 makes the stream durable,
   * the only reconstruction available is the log line below, which is why it
   * carries the record id and the owner rather than just a failure.
   */
  async record(entry: OwnershipEntry): Promise<void> {
    const row: OwnershipRow = {
      record_type: entry.recordType,
      record_id: entry.recordId,
      owner_id: entry.ownerId,
    };

    try {
      const result = await this.table().upsert(row, {
        onConflict: OWNERSHIP_CONFLICT_TARGET,
        ignoreDuplicates: true,
      });
      if (result.error) this.warnRecordFailed(entry, result.error.message);
    } catch (error) {
      // A rejection rather than an error payload: DNS, TLS, a dead host. Same
      // consequence for the user, so the same handling and the same marker.
      this.warnRecordFailed(entry, reason(error));
    }
  }

  /**
   * Answers "did this account create this record?".
   *
   * Narrowed on all three keys server-side, so the row that comes back — if one
   * does — is by construction the one asked about. Dropping any `eq` would turn
   * this into "does anyone own a record of this type", which grants strangers
   * edit rights on everything.
   *
   * A missing row is `false`, not an error: "nobody recorded an owner" is a
   * perfectly ordinary state (a record created before 00005 landed, or by a
   * path that predates the ownership decorator) and it means exactly what false
   * means — we cannot say this person created it.
   *
   * A FAILURE is also `false`, never true. Ownership only ever widens rights
   * (ADR 0009), so false is the direction that refuses rather than the direction
   * that grants: a store we cannot read must not be able to hand out edit
   * permissions on records it knows nothing about. The operator gets the reason
   * in the log; the user gets a refusal they can report.
   */
  async isOwner(query: {
    readonly recordType: OwnableRecordType;
    readonly recordId: string;
    readonly ownerId: string;
  }): Promise<boolean> {
    try {
      const result = await this.table()
        .select("record_type,record_id,owner_id")
        .eq("record_type", query.recordType)
        .eq("record_id", query.recordId)
        .eq("owner_id", query.ownerId)
        .limit(1);

      if (result.error) {
        console.error(
          `[api] ownership lookup failed for ${query.recordType}:${query.recordId} ` +
            `(owner ${query.ownerId}): ${result.error.message} — refusing, ownership cannot be confirmed`,
        );
        return false;
      }

      const rows = (result.data ?? []) as OwnershipRow[];
      return rows.length > 0;
    } catch (error) {
      console.error(
        `[api] ownership lookup failed for ${query.recordType}:${query.recordId} ` +
          `(owner ${query.ownerId}): ${reason(error)} — refusing, ownership cannot be confirmed`,
      );
      return false;
    }
  }

  /**
   * The one log line that explains a future "I cannot edit my own entry" bug,
   * so it carries everything needed to fix it without a reproduction: the
   * record it is about, the account that should have owned it, the table and
   * schema it tried to write, and the symptom to search for.
   */
  private warnRecordFailed(entry: OwnershipEntry, detail: string): void {
    console.error(
      `[api] FAILED TO RECORD OWNERSHIP of ${entry.recordType}:${entry.recordId} ` +
        `for owner ${entry.ownerId} in ${this.schema}.${RECORD_OWNERSHIP_TABLE}: ${detail} — ` +
        "the record was created successfully but its author will be refused (403) when they try " +
        "to edit it; check that 00005_record_ownership.sql has been applied to this project",
    );
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
