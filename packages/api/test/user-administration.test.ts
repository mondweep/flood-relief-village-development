import { isSuperAdmin, type AuthenticatedActor } from "@afrip/shared-kernel";
import { describe, expect, it } from "vitest";
import {
  decideRoleChange,
  roleChangedEvent,
  ROLE_CHANGED_EVENT,
  InMemoryUserDirectory,
  type ManagedUser,
} from "../src/user-administration.js";

/**
 * The rules on changing somebody's role (ADR 0018), tested without HTTP.
 *
 * This is the platform's most dangerous write. Every other route changes a
 * record about the world; this one changes who may read the register of widows
 * and orphaned children. `decideRoleChange` does no I/O precisely so that every
 * rule can be walked directly here rather than inferred from status codes.
 */

const SUPER: AuthenticatedActor = {
  id: "user-owner",
  email: "owner@example.org",
  role: "admin",
  roleSource: "grant",
};

const APPOINTED_ADMIN: AuthenticatedActor = {
  id: "user-deputy",
  email: "deputy@example.org",
  role: "admin",
  roleSource: "appointed",
};

const CITIZEN: ManagedUser = {
  id: "user-citizen",
  email: "resident@example.org",
  role: "citizen",
  roleSource: "self",
  enrolledAt: "2026-07-01T00:00:00.000Z",
};

const GRANTED: ManagedUser = {
  id: "user-owner",
  email: "owner@example.org",
  role: "admin",
  roleSource: "grant",
  enrolledAt: "2026-06-01T00:00:00.000Z",
};

describe("who may change a role", () => {
  it("admits an administrator named in the grant list", () => {
    expect(decideRoleChange({ actor: SUPER, target: CITIZEN, role: "district_officer" }))
      .toMatchObject({ allowed: true });
  });

  /**
   * THE ONE THE WHOLE DESIGN RESTS ON.
   *
   * Same role, different provenance. An administrator appointed in-app can do
   * everything an administrator does — read the beneficiary register, the audit
   * trail, the feedback queue — except appoint another one. Without this, the
   * set of people holding unchecked access grows by clicking, and "who may
   * appoint administrators" stops being answerable from the repository.
   */
  it("refuses an administrator who was appointed in-app rather than granted", () => {
    expect(isSuperAdmin(APPOINTED_ADMIN)).toBe(false);
    expect(decideRoleChange({ actor: APPOINTED_ADMIN, target: CITIZEN, role: "admin" }))
      .toMatchObject({ allowed: false, refusal: "not_super_admin" });
  });

  it.each([
    ["district_officer" as const],
    ["ngo_coordinator" as const],
    ["village_committee" as const],
    ["citizen" as const],
  ])("refuses %s outright", (role) => {
    const actor: AuthenticatedActor = { id: "u", email: "u@e.org", role, roleSource: "grant" };
    expect(decideRoleChange({ actor, target: CITIZEN, role: "admin" }))
      .toMatchObject({ allowed: false, refusal: "not_super_admin" });
  });

  it("refuses an unidentified caller", () => {
    expect(decideRoleChange({ actor: null, target: CITIZEN, role: "citizen" }))
      .toMatchObject({ allowed: false, refusal: "not_super_admin" });
  });

  /**
   * An actor whose provenance is unknown is not a super admin. Fails closed:
   * a deployment that cannot say where a role came from must not conclude the
   * role came from version control.
   */
  it("refuses an admin whose role source is not recorded at all", () => {
    const legacy = { id: "u", email: "u@e.org", role: "admin" } as AuthenticatedActor;
    expect(isSuperAdmin(legacy)).toBe(false);
    expect(decideRoleChange({ actor: legacy, target: CITIZEN, role: "admin" }))
      .toMatchObject({ allowed: false, refusal: "not_super_admin" });
  });

  /**
   * Checked BEFORE the target is resolved, so a refused caller cannot use
   * varying responses to discover who is registered.
   */
  it("refuses a non-super-admin identically whether or not the target exists", () => {
    const real = decideRoleChange({ actor: APPOINTED_ADMIN, target: CITIZEN, role: "citizen" });
    const missing = decideRoleChange({ actor: APPOINTED_ADMIN, target: null, role: "citizen" });
    expect(real).toEqual(missing);
  });
});

describe("what a super admin may not do", () => {
  /**
   * A super admin who mis-clicks their own row has removed the only power that
   * could put it back — recovery is a migration and a deploy, which is the exact
   * bottleneck this feature exists to remove, hit at the worst moment.
   */
  it("refuses a change to your own role, in either direction", () => {
    expect(decideRoleChange({ actor: SUPER, target: GRANTED, role: "citizen" }))
      .toMatchObject({ allowed: false, refusal: "self" });
  });

  /**
   * A grant-sourced role is re-asserted by 00004's trailing update on every
   * migration run. Changing one here would appear to work, persist for days,
   * then silently revert on the next deploy — leaving an audit trail that says
   * the change happened and a database that disagrees.
   */
  it("refuses to edit a role that version control asserts", () => {
    const other: ManagedUser = { ...GRANTED, id: "user-other", email: "other@example.org" };
    const decision = decideRoleChange({ actor: SUPER, target: other, role: "citizen" });
    expect(decision).toMatchObject({ allowed: false, refusal: "grant_sourced" });
    expect(decision.because, "the refusal must say where to go instead")
      .toMatch(/grant list/i);
  });

  it("refuses a role the platform does not have", () => {
    expect(decideRoleChange({ actor: SUPER, target: CITIZEN, role: "superuser" }))
      .toMatchObject({ allowed: false, refusal: "unknown_role" });
  });

  it("reports a bad role before a missing user, so a typo names itself", () => {
    expect(decideRoleChange({ actor: SUPER, target: null, role: "wizard" }))
      .toMatchObject({ refusal: "unknown_role" });
  });

  it("refuses a user who has not registered — nobody is appointed in advance", () => {
    const decision = decideRoleChange({ actor: SUPER, target: null, role: "admin" });
    expect(decision).toMatchObject({ allowed: false, refusal: "unknown_user" });
    expect(decision.because).toMatch(/registered/i);
  });
});

describe("the audit event", () => {
  /**
   * BOTH ROLES, because "X is now a district officer" cannot be reviewed and "X
   * was a citizen and is now a district officer" can. The previous value is
   * unrecoverable after the write — audit_log is append-only and there is no
   * earlier row to join to — so it is captured before and carried here.
   */
  it("records what the role was as well as what it became", () => {
    const event = roleChangedEvent({
      target: CITIZEN,
      from: "citizen",
      to: "district_officer",
      occurredAt: "2026-07-30T10:00:00.000Z",
    });
    expect(event.name).toBe(ROLE_CHANGED_EVENT);
    expect(event.payload).toMatchObject({
      userId: CITIZEN.id,
      userEmail: CITIZEN.email,
      previousRole: "citizen",
      role: "district_officer",
      previousRoleSource: "self",
      roleSource: "appointed",
    });
  });

  /**
   * ADR 0010: the actor is stamped at the composition seam, never by the code
   * raising the event. A use case that stamps its own actor is one that can lie
   * about one.
   */
  it("does not stamp its own actor", () => {
    const event = roleChangedEvent({
      target: CITIZEN, from: "citizen", to: "admin", occurredAt: "2026-07-30T10:00:00.000Z",
    });
    expect(event.actor).toBeUndefined();
  });
});

describe("the directory refuses a grant-sourced write on its own", () => {
  /**
   * A SECOND LOCK on the rule `decideRoleChange` already enforces. It costs one
   * comparison and it means the dangerous edit needs two mistakes rather than
   * one — a future route that forgets to ask still cannot write the row.
   */
  it("will not change a grant-sourced profile even when asked directly", async () => {
    const directory = new InMemoryUserDirectory([{ ...GRANTED, id: "user-other" }]);
    const result = await directory.changeRole({ userId: "user-other", role: "citizen" });
    expect(result.ok && result.value).toBeNull();

    const after = await directory.find("user-other");
    expect(after.ok && after.value?.role, "the role was changed despite the lock").toBe("admin");
  });

  it("marks a successful change as appointed, never leaving the old source", async () => {
    const directory = new InMemoryUserDirectory([{ ...CITIZEN }]);
    const result = await directory.changeRole({ userId: CITIZEN.id, role: "district_officer" });
    expect(result.ok && result.value).toMatchObject({
      role: "district_officer",
      // A row that kept `grant` after being edited here would claim version
      // control asserts something it does not — making somebody a super admin
      // by accident, through a field nobody looked at.
      roleSource: "appointed",
    });
  });

  it("reports a missing user as null rather than as an error", async () => {
    const directory = new InMemoryUserDirectory([]);
    const result = await directory.changeRole({ userId: "nobody", role: "citizen" });
    expect(result.ok && result.value).toBeNull();
  });
});
