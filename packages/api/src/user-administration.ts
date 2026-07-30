import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AFRIP_SCHEMA,
  DEFAULT_ROLE,
  DEFAULT_ROLE_SOURCE,
  err,
  isRoleSource,
  isUserRole,
  ok,
  type AuthenticatedActor,
  type DomainEvent,
  type Result,
  type RoleSource,
  type UserRole,
} from "@afrip/shared-kernel";
import { USER_PROFILES_TABLE } from "./profiles.js";

/**
 * Appointing people (ADR 0018).
 *
 * WHY THIS IS NOT A BOUNDED CONTEXT. Every other guarded operation on this
 * platform is a use case on a bounded context and goes through the policy table.
 * This one is not: "who may act as a district officer" is a statement about the
 * platform's own access control, not about villages, NGOs or beneficiaries.
 * Inventing a `userAdministration` context purely so the existing gate could see
 * it would put a false context into the model to satisfy a mechanism — the same
 * argument `routes/feedback.ts` makes, for the same reason.
 *
 * The cost is the same too, and so is the mitigation: the checks are lines of
 * code in route handlers, so a fourth route added later can omit one.
 * `user-administration-routes.test.ts` therefore enumerates every registered
 * `/admin/*` route FROM THE ROUTER and requires each to refuse a non-super-admin.
 */

/** One row of `user_profiles`, as an administrator sees it. */
export interface ManagedUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly roleSource: RoleSource;
  readonly enrolledAt: string | null;
}

/** What a role change asks for. */
export interface RoleChange {
  readonly userId: string;
  readonly role: UserRole;
}

/**
 * Outbound port. Two reads and one write, and no more: this is the smallest
 * surface that supports appointing somebody, and every method added here is a
 * new way to reach the table that decides who holds unchecked access.
 *
 * `Result` rather than throwing, like `FeedbackStore` and for the same reason:
 * every caller is an administrator who can be told what went wrong.
 *
 * `changeRole` resolves to `null` for an id that matches no profile, separately
 * from an error, so the route can answer 404 rather than 502.
 */
export interface UserDirectory {
  list(): Promise<Result<readonly ManagedUser[]>>;
  find(userId: string): Promise<Result<ManagedUser | null>>;
  changeRole(change: RoleChange): Promise<Result<ManagedUser | null>>;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Why a role change was refused, as a machine-readable reason.
 *
 * A closed set rather than free-text messages, because the frontend distinguishes
 * them: "you cannot demote yourself" is a correction, "this person's role is set
 * in version control" is an explanation of where to go instead, and they should
 * not look alike.
 */
export const ROLE_CHANGE_REFUSALS = [
  "not_super_admin",
  "self",
  "grant_sourced",
  "unknown_role",
  "unknown_user",
] as const;
export type RoleChangeRefusal = (typeof ROLE_CHANGE_REFUSALS)[number];

export interface RoleChangeDecision {
  readonly allowed: boolean;
  readonly refusal?: RoleChangeRefusal;
  readonly because?: string;
}

const ALLOWED: RoleChangeDecision = { allowed: true };

/**
 * Every rule on changing somebody's role, in one function, decided before
 * anything is written.
 *
 * SEPARATED FROM THE ROUTE ON PURPOSE. These are the platform's most dangerous
 * write — the one that hands out access to the register of widows and orphaned
 * children — and a rule expressed as an early return inside an HTTP handler is a
 * rule that gets tested through HTTP, if at all. Here each one is a named branch
 * with a reason, and `user-administration.test.ts` walks them directly.
 *
 * The `target` is passed in rather than looked up, so this function does no I/O
 * and cannot be made to depend on the order of two awaits.
 */
export function decideRoleChange(input: {
  readonly actor: AuthenticatedActor | null;
  readonly target: ManagedUser | null;
  readonly role: unknown;
}): RoleChangeDecision {
  const { actor, target, role } = input;

  /*
   * 1. ONLY A SUPER ADMIN. Being an `admin` is not enough, and that is the
   *    whole of ADR 0018: an administrator appointed in-app can do everything
   *    an administrator does except appoint another one. Without this, the set
   *    of people holding unchecked access grows by clicking, and "who may
   *    appoint administrators" stops being answerable from the repository.
   *
   *    Checked FIRST so that a non-super-admin learns nothing about whether the
   *    target exists — a 403 that varies by target id is an enumeration oracle
   *    over the platform's user list.
   */
  if (actor === null || actor.role !== "admin" || actor.roleSource !== "grant") {
    return {
      allowed: false,
      refusal: "not_super_admin",
      because:
        "Only an administrator named in the platform's version-controlled grant list may change roles.",
    };
  }

  /*
   * 2. NOT YOURSELF, in either direction.
   *
   *    Demotion is the obvious hazard: a super admin who mis-clicks their own
   *    row has removed the only power that could put it back, and the recovery
   *    is a migration and a deploy — the exact bottleneck this feature exists to
   *    remove, hit at the worst possible moment.
   *
   *    Promotion is refused for a different reason: a self-change is the one
   *    role change with no second person in it, so the audit row would record
   *    somebody authorising themselves. On a platform whose founding complaint
   *    is that records cannot be trusted, that entry is worth refusing even
   *    though the actor could already do anything.
   */
  if (target !== null && target.id === actor.id) {
    return {
      allowed: false,
      refusal: "self",
      because:
        "You cannot change your own role. Ask another super administrator, or change the grant list.",
    };
  }

  /*
   * 3. THE ROLE MUST BE A REAL ONE. Checked before the target is resolved as
   *    unknown, so a typo in the role reports the typo rather than sending
   *    somebody looking for a missing user.
   */
  if (!isUserRole(role)) {
    return {
      allowed: false,
      refusal: "unknown_role",
      because: "That is not a role this platform has.",
    };
  }

  if (target === null) {
    return {
      allowed: false,
      refusal: "unknown_user",
      because:
        "No such user. People appear here once they have registered — they cannot be appointed in advance.",
    };
  }

  /*
   * 4. A GRANT-SOURCED ROLE IS NOT EDITABLE HERE, and this is the rule most
   *    likely to be mistaken for an oversight.
   *
   *    `role_grants` is re-asserted by migration 00004's trailing `update` every
   *    time the migration set runs. So an in-app change to somebody whose role
   *    came from a grant would appear to work, persist for days, and then
   *    silently revert on the next deploy — leaving an audit trail that says the
   *    change happened and a database that disagrees. That is worse than
   *    refusing, on a platform built so that records can be trusted.
   *
   *    The honest remedy is the one the message names: change the grant list,
   *    which is a diff somebody reviews.
   */
  if (target.roleSource === "grant") {
    return {
      allowed: false,
      refusal: "grant_sourced",
      because:
        "This person's role is set in the platform's grant list, in version control. " +
        "Changing it here would be undone by the next deployment — edit the grant list instead.",
    };
  }

  return ALLOWED;
}

// ---------------------------------------------------------------------------
// The audit event
// ---------------------------------------------------------------------------

/**
 * The event name recorded for every role change.
 *
 * It goes to `audit_log` (ADR 0011) rather than to a table of its own. That log
 * has `update` and `delete` revoked from `service_role` itself, so a role change
 * cannot be edited or erased even by the process that wrote it — which is
 * exactly the property this particular record needs. A parallel history table
 * would be a second thing to keep in step, and the weaker of the two would
 * become the one somebody trusts.
 */
export const ROLE_CHANGED_EVENT = "user.role-changed.v1";

/**
 * Builds the audit event for a completed role change.
 *
 * BOTH ROLES ARE IN THE PAYLOAD. "X is now a district officer" cannot be
 * reviewed; "X was a citizen and is now a district officer" can. The previous
 * value is unrecoverable after the write, so it is captured before it and
 * carried here — the log is append-only and there is no earlier row to join to.
 *
 * The ACTOR is not set here. `ActorStampingPublisher` (ADR 0010) is what puts
 * the acting identity onto an event, at the composition seam, and a use case
 * that stamps its own actor is a use case that can lie about one.
 */
export function roleChangedEvent(input: {
  readonly target: ManagedUser;
  readonly from: UserRole;
  readonly to: UserRole;
  readonly occurredAt: string;
}): DomainEvent {
  return {
    name: ROLE_CHANGED_EVENT,
    occurredAt: input.occurredAt,
    payload: {
      userId: input.target.id,
      // The subject's email, deliberately. An audit entry naming only a uuid
      // cannot be reviewed by the person who has to review it, and this is an
      // address the platform already holds and shows to administrators.
      userEmail: input.target.email,
      previousRole: input.from,
      role: input.to,
      // How the target came to hold the role being replaced, so that a reader
      // can tell an appointment from a correction of a self-registration.
      previousRoleSource: input.target.roleSource,
      roleSource: "appointed",
    },
  };
}

/**
 * Narrows an unknown body to a role change. Kept out of the route for the same
 * reason `decideRoleChange` is: it is testable without an HTTP server.
 */
export function readRoleChange(
  userId: unknown,
  role: unknown,
): Result<RoleChange> {
  if (typeof userId !== "string" || userId.trim() === "") return err("userId is required");
  if (!isUserRole(role)) return err("role is not a role this platform has");
  return ok({ userId: userId.trim(), role });
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * `user_profiles`, over Supabase.
 *
 * NOTE WHAT IS ABSENT: there is no `create`. A person appears here by
 * registering, through `enrol_user`, and cannot be appointed in advance. That
 * follows from `role_grants` remaining the only pre-authorisation mechanism —
 * and pre-authorisation is the one thing that must stay in version control,
 * because it is how somebody becomes an administrator without anybody meeting
 * them.
 */
export class SupabaseUserDirectory implements UserDirectory {
  constructor(
    private readonly client: SupabaseClient,
    private readonly schema: string = AFRIP_SCHEMA,
  ) {}

  /** Every query goes through here, so no call can forget the schema. */
  private table() {
    return this.client.schema(this.schema).from(USER_PROFILES_TABLE);
  }

  async list(): Promise<Result<readonly ManagedUser[]>> {
    const result = await this.table()
      .select("id,email,role,role_source,enrolled_at")
      .order("enrolled_at", { ascending: true })
      .limit(MAX_MANAGED_USERS);

    if (result.error) return err(result.error.message);
    const rows = (result.data ?? []) as Record<string, unknown>[];
    return ok(rows.map(toManagedUser).filter((user): user is ManagedUser => user !== null));
  }

  async find(userId: string): Promise<Result<ManagedUser | null>> {
    const result = await this.table()
      .select("id,email,role,role_source,enrolled_at")
      .eq("id", userId)
      .limit(1);

    if (result.error) return err(result.error.message);
    const row = ((result.data ?? []) as Record<string, unknown>[])[0];
    return ok(row === undefined ? null : toManagedUser(row));
  }

  /**
   * `role_source: "appointed"` is written with the role, always, and never
   * conditionally. A role changed in-app IS an appointment by definition, and a
   * row that kept `grant` after being edited here would claim version control
   * asserts something it does not — which would make the person a super admin
   * by accident, through a field nobody looked at.
   *
   * The `neq` on `role_source` is a second lock on the same rule
   * `decideRoleChange` already enforces: a grant-sourced profile cannot be
   * written by this path even if a future route forgets to ask. It costs one
   * predicate and it means the dangerous edit needs two mistakes, not one.
   */
  async changeRole(change: RoleChange): Promise<Result<ManagedUser | null>> {
    const result = await this.table()
      .update({ role: change.role, role_source: "appointed" })
      .eq("id", change.userId)
      .neq("role_source", "grant")
      .select("id,email,role,role_source,enrolled_at")
      .limit(1);

    if (result.error) return err(result.error.message);
    const row = ((result.data ?? []) as Record<string, unknown>[])[0];
    return ok(row === undefined ? null : toManagedUser(row));
  }
}

/**
 * A ceiling rather than a suggestion, matching `MAX_AUDIT_PAGE_SIZE` and
 * `MAX_FEEDBACK_PAGE_SIZE`. There is no paging here because the list is
 * "everyone who has registered with AFRIP", which is a handful of people and is
 * meant to stay that way — but an unbounded select is how a handful becomes a
 * timeout without anybody choosing it.
 */
export const MAX_MANAGED_USERS = 500;

/** Row -> ManagedUser, or null when the row is unusable. */
function toManagedUser(row: Record<string, unknown>): ManagedUser | null {
  const id = row["id"];
  const email = row["email"];
  if (typeof id !== "string" || typeof email !== "string") return null;
  return {
    id,
    email,
    // Same reasoning as `SupabaseProfileDirectory`: an unrecognised value is
    // read as the least privileged one rather than raised as an error. An
    // administrator seeing "citizen" against a row whose column says something
    // this build cannot name is a smaller problem than a list that will not load.
    role: isUserRole(row["role"]) ? row["role"] : DEFAULT_ROLE,
    roleSource: isRoleSource(row["role_source"]) ? row["role_source"] : DEFAULT_ROLE_SOURCE,
    enrolledAt: typeof row["enrolled_at"] === "string" ? row["enrolled_at"] : null,
  };
}

/**
 * The in-memory directory, for `PERSISTENCE=memory`.
 *
 * Seeded empty. The in-memory auth path pins everyone to `citizen` and has no
 * `user_profiles` table behind it, so there is nobody to appoint — and inventing
 * a fake super admin here would make the development server disagree with every
 * real deployment about the one thing this feature is careful about.
 */
export class InMemoryUserDirectory implements UserDirectory {
  constructor(private readonly rows: ManagedUser[] = []) {}

  async list(): Promise<Result<readonly ManagedUser[]>> {
    return ok([...this.rows]);
  }

  async find(userId: string): Promise<Result<ManagedUser | null>> {
    return ok(this.rows.find((row) => row.id === userId) ?? null);
  }

  async changeRole(change: RoleChange): Promise<Result<ManagedUser | null>> {
    const index = this.rows.findIndex((row) => row.id === change.userId);
    if (index === -1) return ok(null);
    const existing = this.rows[index] as ManagedUser;
    // The same second lock the Supabase adapter carries, for the same reason.
    if (existing.roleSource === "grant") return ok(null);
    const updated: ManagedUser = { ...existing, role: change.role, roleSource: "appointed" };
    this.rows[index] = updated;
    return ok(updated);
  }
}
