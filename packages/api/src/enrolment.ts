import type { SupabaseClient } from "@supabase/supabase-js";
import { AFRIP_SCHEMA, err, ok, type Result } from "@afrip/shared-kernel";
import {
  DEFAULT_ROLE,
  isUserRole,
  type ActorContext,
  type VerifiedClaims,
} from "./auth.js";

/**
 * The SECURITY DEFINER function `00004_user_profiles.sql` creates. Called
 * through PostgREST's RPC endpoint, in the AFRIP schema.
 *
 * Spelled out rather than inlined because it must match the function name in
 * 00004 exactly — a mismatch is a 404 from PostgREST on every registration.
 */
export const ENROL_USER_FUNCTION = "enrol_user";

/** Row shape returned by `assam_floods.enrol_user`. */
interface EnrolledRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly role: unknown;
}

/**
 * Creates the AFRIP profile for a verified identity.
 *
 * This is the ONLY path by which an ordinary user gets a `user_profiles` row.
 * 00004 used to create one from an `after insert` trigger on `auth.users`; on a
 * Supabase project shared with four unrelated applications that enrolled their
 * users as AFRIP citizens without any AFRIP involvement at all. The trigger is
 * gone and this took its place, so that a profile records a deliberate act.
 *
 * Read 00004's decision note before changing anything here — in particular,
 * this interface takes no role: what a registrant becomes is decided in SQL
 * from `role_grants`, and there is deliberately no parameter through which a
 * caller could suggest otherwise.
 */
export interface EnrolmentService {
  /** Creates this verified identity's AFRIP profile. Idempotent. */
  enrol(claims: VerifiedClaims): Promise<Result<ActorContext>>;
}

/**
 * `EnrolmentService` backed by `assam_floods.enrol_user` (ADR 0008).
 *
 * Constructed like every other Supabase adapter — the service-role client plus
 * the schema — and, like `SupabaseProfileDirectory`, it reads the resulting
 * role from the row the database returns rather than from anything the token
 * carried.
 *
 * The work happens in a database function rather than in an insert from here
 * for two reasons, both in 00004's header: the API cannot see the `auth` schema
 * through PostgREST (so `auth_created_at` provenance has to be filled in on
 * that side), and keeping the `role_grants` lookup in SQL means there is no
 * wire on which a role could be supplied.
 */
export class SupabaseEnrolmentService implements EnrolmentService {
  /**
   * @param schema Postgres schema holding the AFRIP tables. Defaults to
   * AFRIP_SCHEMA rather than the client's own default, which is `public` — a
   * schema owned by other applications in this shared project.
   */
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string = AFRIP_SCHEMA,
  ) {}

  async enrol(claims: VerifiedClaims): Promise<Result<ActorContext>> {
    const email = typeof claims.email === "string" ? claims.email.trim() : "";

    // REFUSE rather than enrol with ''. `user_profiles.email` is `not null
    // unique`, so an empty string is not a harmless placeholder: the first
    // emailless registrant would take that row and every later one would
    // collide on the unique index, producing a failure whose message points at
    // a duplicate email rather than at the missing one. A verified token with
    // no email is also not something AFRIP can act on later — no recovery, no
    // way for an administrator to tell two such accounts apart — so the honest
    // answer is that we cannot register this identity, said here, once.
    if (email === "") {
      console.error(
        `[api] refusing to enrol ${claims.sub}: the verified token carries no email address`,
      );
      return err(
        "registration requires an email address on your account; " +
          "this sign-in method did not provide one",
      );
    }

    try {
      const result = await this.client
        .schema(this.schema)
        .rpc(ENROL_USER_FUNCTION, { p_user_id: claims.sub, p_email: email });

      if (result.error) {
        return this.failed(claims.sub, result.error.message);
      }

      // `returns table (...)` comes back as an array of rows, but PostgREST
      // will hand back a bare object for a single-row result in some versions.
      // Accept either rather than depending on which one is deployed.
      const data = result.data as EnrolledRow[] | EnrolledRow | null;
      const row = Array.isArray(data) ? data[0] : (data ?? undefined);

      if (row === undefined || row === null) {
        // The function always reads its row back after the insert, so an empty
        // result means it did not do what it says it does — a redeployed
        // function, or a different one behind the same name. Never invent an
        // actor to paper over that.
        return this.failed(claims.sub, "enrol_user returned no profile row");
      }

      const id = typeof row.id === "string" ? row.id : claims.sub;
      const rowEmail = typeof row.email === "string" ? row.email : email;
      // An unrecognised role in the column (a hand-edited row, or a role added
      // to the check constraint but not yet to this build) is treated as the
      // least privileged one rather than as an error — the same rule
      // `SupabaseProfileDirectory` applies on the read path, so a registration
      // and the next request agree about who somebody is.
      const role = isUserRole(row.role) ? row.role : DEFAULT_ROLE;

      return ok({ id, email: rowEmail, role });
    } catch (error) {
      // A rejection rather than an error payload: DNS, TLS, a dead host. Same
      // consequence for the user, so the same handling.
      return this.failed(claims.sub, reason(error));
    }
  }

  /**
   * THIS FAILURE REACHES THE USER, unlike the ownership registry's, and the
   * difference is deliberate. Ownership is recorded after a write that already
   * succeeded, so failing the request there would report a failure that did not
   * happen. Here the user asked to register and the registration did not
   * happen: they have no profile, so the very next authenticated request will
   * be refused as an unknown user. Telling them it worked would be a lie they
   * discover on the next click, with nothing to report and nothing to retry.
   *
   * The log line carries what an operator needs to act: the subject, the
   * schema-qualified function, and the database's own message. The most likely
   * cause of a blanket failure is that 00004 has not been applied to the
   * project, or that `execute` on the function was not granted to service_role
   * — in which case this fires on every registration rather than on one.
   */
  private failed(sub: string, detail: string): Result<ActorContext> {
    console.error(
      `[api] ENROLMENT FAILED for ${sub} via ${this.schema}.${ENROL_USER_FUNCTION}: ${detail} — ` +
        "no profile row was created, so this account will be refused (401) on its next " +
        "authenticated request; check that 00004_user_profiles.sql has been applied to this " +
        "project and that execute on enrol_user is granted to service_role",
    );
    return err(`could not complete registration: ${detail}`);
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
