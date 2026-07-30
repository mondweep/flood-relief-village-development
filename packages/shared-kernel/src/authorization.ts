/**
 * Authorization vocabulary (ADR 0009).
 *
 * This file holds the *nouns* — roles, actors, ownership — and nothing that
 * decides anything. The decision itself (which role may invoke which use case)
 * lives in `@afrip/platform`, because only the composition root can see all
 * nine contexts' use cases at once.
 *
 * Why the shared kernel rather than the API: the role list is ubiquitous
 * language. It appears in a Postgres check constraint, in the API's identity
 * gate, in an event's `actor`, and in the frontend. One list, imported; a second
 * copy would drift, and the way it would drift is by gaining a role in one place
 * that the other silently treats as unknown.
 *
 * Nothing here reaches into `src/domain/` of any context, and nothing in any
 * context's domain layer imports this. That separation IS the decision ADR 0009
 * records: `Village` and `Beneficiary` do not know that users exist.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * The five roles, mapping to the PRD's personas.
 *
 * Mirrors the check constraint on `assam_floods.user_profiles.role` and
 * `assam_floods.role_grants.role` (00004_user_profiles.sql). Adding a role means
 * changing both, and the constraint is the one that will catch you: a role added
 * here and not there produces a profile row Postgres refuses to write.
 */
export const USER_ROLES = [
  "admin",
  "district_officer",
  "ngo_coordinator",
  "village_committee",
  "citizen",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * What self-registration produces, and the only role it can ever produce.
 * Elevation is an administrative act (a `role_grants` row), never self-service —
 * a platform whose purpose is accountability cannot let someone grant themselves
 * authority over fund records by filling in a form.
 */
export const DEFAULT_ROLE: UserRole = "citizen";

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Where somebody's role came from — the `role_source` column added by 00010.
 *
 * Provenance rather than a sixth role, and the distinction is the whole design.
 * The platform still has exactly five roles; what this adds is the answer to
 * "who said so", which is what decides who may appoint whom.
 *
 *   grant      asserted by `role_grants`, i.e. by a migration in version
 *              control. An `admin` from this source is a SUPER ADMIN.
 *   appointed  set in-app by a super admin.
 *   self       nobody assigned it — the `citizen` floor from self-registration.
 */
export const ROLE_SOURCES = ["grant", "appointed", "self"] as const;
export type RoleSource = (typeof ROLE_SOURCES)[number];

export function isRoleSource(value: unknown): value is RoleSource {
  return typeof value === "string" && (ROLE_SOURCES as readonly string[]).includes(value);
}

/** What a profile with no recorded provenance is treated as. */
export const DEFAULT_ROLE_SOURCE: RoleSource = "self";

/** Who a request is acting as. Null, at the call sites, means "nobody named". */
export interface AuthenticatedActor {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  /**
   * OPTIONAL, and it must stay optional.
   *
   * Every existing caller — forty-odd use cases, the in-memory dev runtime, and
   * every test that builds an actor by hand — constructs this object without
   * knowing what a role source is, and none of them should have to. Only the
   * role-administration route asks.
   *
   * ABSENT MEANS NOT A SUPER ADMIN, which is the safe direction: a deployment
   * that cannot say where a role came from must not conclude the role came from
   * version control. `isSuperAdmin` below is the only thing that reads it, and
   * it fails closed by construction rather than by remembering to.
   */
  readonly roleSource?: RoleSource;
}

/**
 * May this actor change other people's roles?
 *
 * TWO CONDITIONS, AND BOTH ARE LOAD-BEARING. Being an `admin` is not enough —
 * that is the entire point of 00010. An administrator appointed in-app can do
 * everything an administrator does *except* appoint another one, so the set of
 * people who can hand out unchecked access stays exactly the set named in the
 * repository, reviewable in a diff, and cannot grow by somebody clicking.
 *
 * Fails closed on a missing `roleSource`: no provenance, no appointment power.
 */
export function isSuperAdmin(actor: AuthenticatedActor | null): boolean {
  return actor !== null && actor.role === "admin" && actor.roleSource === "grant";
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * The kinds of record that can be owned.
 *
 * Deliberately a small closed list rather than "every aggregate": ownership
 * exists to satisfy one requirement — *a user may edit entries they made* — and
 * only records a non-privileged user can create are in scope. A `project` is
 * sanctioned by a district officer who already has the role to edit it, so
 * recording ownership for it would add a row nothing reads.
 */
export const OWNABLE_RECORD_TYPES = ["village", "issue", "volunteer", "plan", "signal"] as const;

export type OwnableRecordType = (typeof OWNABLE_RECORD_TYPES)[number];

export interface OwnershipEntry {
  readonly recordType: OwnableRecordType;
  readonly recordId: string;
  /** The authenticated subject id (Supabase `sub`) of whoever created it. */
  readonly ownerId: string;
}

/**
 * Outbound port for "who created this record?".
 *
 * A table of its own rather than a `created_by` column on twenty-three tables —
 * see ADR 0009 for the trade-off. The cost is a join table that can drift from
 * the records it describes; the mitigation is that ownership is recorded by the
 * same decorator that publishes the creation event (see
 * `OwnershipRecordingPublisher`), so a creating use case cannot do one without
 * the other.
 *
 * `record` is deliberately idempotent-on-conflict rather than failing: a
 * re-published creation event must not turn into an error, and the first writer
 * is the truthful owner.
 */
export interface OwnershipRegistry {
  record(entry: OwnershipEntry): Promise<void>;
  isOwner(query: {
    readonly recordType: OwnableRecordType;
    readonly recordId: string;
    readonly ownerId: string;
  }): Promise<boolean>;
}

/**
 * In-memory adapter. The default in `createPlatform`, and the whole registry in
 * the dev server — where it is honest rather than merely convenient, because a
 * dev server has no durable records to own either.
 */
export class InMemoryOwnershipRegistry implements OwnershipRegistry {
  private readonly owners = new Map<string, string>();

  private static key(recordType: string, recordId: string): string {
    return `${recordType}:${recordId}`;
  }

  async record(entry: OwnershipEntry): Promise<void> {
    const key = InMemoryOwnershipRegistry.key(entry.recordType, entry.recordId);
    // First writer wins: a replayed creation event must not reassign ownership.
    if (!this.owners.has(key)) this.owners.set(key, entry.ownerId);
  }

  async isOwner(query: {
    recordType: OwnableRecordType;
    recordId: string;
    ownerId: string;
  }): Promise<boolean> {
    return this.owners.get(InMemoryOwnershipRegistry.key(query.recordType, query.recordId)) === query.ownerId;
  }
}

/**
 * A registry that owns nothing, for compositions with no ownership store.
 *
 * `isOwner` answers false, never true: with no record of who created what, the
 * safe answer to "did this person create it?" is "we cannot say", and the
 * consequence of the safe answer is a refused edit rather than a granted one.
 */
export const NO_OWNERSHIP: OwnershipRegistry = {
  async record(): Promise<void> {
    /* nothing to record into */
  },
  async isOwner(): Promise<boolean> {
    return false;
  },
};

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/**
 * The marker that makes a refusal a 403 rather than a 400.
 *
 * Use cases across all nine contexts fail with a plain string (`Result<T,
 * string>`), and the API maps that string onto a status code. Rather than teach
 * `statusForError` another regex to guess with, an authorization refusal carries
 * this exact prefix and the mapping is an equality test on a shared constant.
 * Guessed patterns are how a validation message that happens to read "not
 * permitted" becomes a 403; a constant both sides import cannot do that.
 */
export const FORBIDDEN_PREFIX = "Not permitted:";

export function isForbiddenError(message: unknown): boolean {
  return typeof message === "string" && message.startsWith(FORBIDDEN_PREFIX);
}

/** Builds the refusal message for an operation an actor may not invoke. */
export function forbiddenMessage(operation: string, role: string): string {
  return `${FORBIDDEN_PREFIX} ${role} may not ${operation}`;
}
