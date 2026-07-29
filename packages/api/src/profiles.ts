import type { SupabaseClient } from "@supabase/supabase-js";
import { AFRIP_SCHEMA } from "@afrip/shared-kernel";
import {
  DEFAULT_ROLE,
  isUserRole,
  type ActorContext,
  type ProfileDirectory,
  type VerifiedClaims,
} from "./auth.js";

/**
 * The table `00004_user_profiles.sql` creates. One row per `auth.users` row,
 * kept in step by an `after insert` trigger.
 */
export const USER_PROFILES_TABLE = "user_profiles";

interface ProfileRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly role: unknown;
}

/**
 * Resolves a verified `sub` against `assam_floods.user_profiles` (ADR 0008).
 *
 * The role comes from this row and nowhere else. Supabase will happily put
 * arbitrary `user_metadata` into a token, and a user controls their own signup
 * payload — so a role claim carried by the token is a role the user chose for
 * themselves. Reading it from a table the API writes and the user cannot is the
 * whole point.
 *
 * Read through the service-role client, which bypasses RLS: the request has not
 * been authorised yet, so there is no user session to read as. The row-level
 * policy in 00004 exists for direct PostgREST access by the browser, which is a
 * different door.
 */
export class SupabaseProfileDirectory implements ProfileDirectory {
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string = AFRIP_SCHEMA,
  ) {}

  async resolve(claims: VerifiedClaims): Promise<ActorContext | null> {
    const result = await this.client
      .schema(this.schema)
      .from(USER_PROFILES_TABLE)
      .select("id,email,role")
      .eq("id", claims.sub)
      .limit(1);

    if (result.error) {
      // A lookup failure is not an identity: refusing is the safe direction, and
      // the operator gets the reason in the log rather than the client getting a
      // silent privilege downgrade.
      console.error(`[api] user profile lookup failed for ${claims.sub}: ${result.error.message}`);
      return null;
    }

    // No row means "not a user of this application", which on a SHARED Supabase
    // project is a different and much larger set than "not a user at all" — see
    // the authorization-boundary note in auth.ts where this null is turned into
    // a 401. Returning a default actor here instead would move that boundary,
    // quietly, from this file.
    //
    // Do not read that as a claim the boundary currently holds: 00004's signup
    // trigger enrols neighbouring applications' users, so many of them never
    // reach this null at all. That gap is recorded and escalated at the top of
    // 00004; this comment describes only what this line must not do.
    const row = (result.data as ProfileRow[] | null)?.[0];
    if (row === undefined) return null;

    const id = typeof row.id === "string" ? row.id : claims.sub;
    const email = typeof row.email === "string" ? row.email : (claims.email ?? "");
    // An unrecognised role in the column (a hand-edited row, or a role added to
    // the check constraint but not yet to this build) is treated as the least
    // privileged one rather than as an error — ADR 0009 will decide what each
    // role may do; this file only refuses to invent authority it cannot name.
    const role = isUserRole(row.role) ? row.role : DEFAULT_ROLE;

    return { id, email, role };
  }
}
