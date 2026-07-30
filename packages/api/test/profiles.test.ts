import { AFRIP_SCHEMA, isSuperAdmin } from "@afrip/shared-kernel";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedClaims } from "../src/auth.js";
import { SupabaseProfileDirectory, USER_PROFILES_TABLE } from "../src/profiles.js";
import { createFakeSupabase } from "./fake-supabase-client.js";

const SUB = "11111111-2222-3333-4444-555555555555";

function claims(overrides: Partial<VerifiedClaims> = {}): VerifiedClaims {
  return { sub: SUB, email: "token@example.org", payload: {}, ...overrides };
}

function profiles(rows: Record<string, unknown>[]) {
  const fake = createFakeSupabase({ tables: { [USER_PROFILES_TABLE]: rows } });
  return { fake, directory: new SupabaseProfileDirectory(fake.client, AFRIP_SCHEMA) };
}

describe("SupabaseProfileDirectory", () => {
  it("resolves a verified subject into an actor", async () => {
    const { directory } = profiles([
      { id: SUB, email: "officer@darbhanga.gov.in", role: "district_officer" },
    ]);

    expect(await directory.resolve(claims())).toEqual({
      id: SUB,
      email: "officer@darbhanga.gov.in",
      role: "district_officer",
      // 00010. A row with no `role_source` reads as "self" — nobody assigned
      // this, so no appointment power attaches to it.
      roleSource: "self",
    });
  });

  /**
   * The one that matters most: the row wins over the token. A user controls
   * their own signup metadata, so a role claimed by the token is a role the
   * user chose for themselves.
   */
  it("takes email and role from the row, not from the token's claims", async () => {
    const { directory } = profiles([{ id: SUB, email: "real@example.org", role: "citizen" }]);

    const actor = await directory.resolve(
      claims({ email: "spoofed@example.com", payload: { role: "admin" } }),
    );

    expect(actor).toEqual({
      id: SUB,
      email: "real@example.org",
      role: "citizen",
      roleSource: "self",
    });
  });

  it("reads user_profiles in the AFRIP schema, not public", async () => {
    const { fake, directory } = profiles([{ id: SUB, email: "a@b.c", role: "citizen" }]);

    await directory.resolve(claims());

    expect(fake.tablesTouched()).toEqual([USER_PROFILES_TABLE]);
    expect(fake.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.schemasUsed()).not.toContain("public");
  });

  it("returns null for a subject with no profile row", async () => {
    const { directory } = profiles([]);

    expect(await directory.resolve(claims())).toBeNull();
  });

  /**
   * Fail closed. A lookup that errored is not evidence of an identity, and
   * inventing a default actor here would turn a transient database blip into a
   * silent privilege decision.
   */
  it("returns null — and logs — when the lookup itself fails", async () => {
    const fake = createFakeSupabase({ failOn: { table: USER_PROFILES_TABLE, message: "boom" } });
    const directory = new SupabaseProfileDirectory(fake.client, AFRIP_SCHEMA);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await directory.resolve(claims())).toBeNull();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * A role this build cannot name (a hand-edited row, or one added to the check
   * constraint ahead of the code) resolves to the least privileged role rather
   * than being passed through as an unknown string.
   */
  it("downgrades an unrecognised role to citizen instead of trusting it", async () => {
    const { directory } = profiles([{ id: SUB, email: "a@b.c", role: "superuser" }]);

    expect(await directory.resolve(claims())).toMatchObject({ role: "citizen" });
  });
});

/**
 * Where the role came from (00010), which is what decides who may appoint others.
 *
 * The failure this guards against is not subtle but it is silent: read the
 * column wrong, or not at all, and an administrator either loses the ability to
 * appoint anyone (visible, annoying) or GAINS it without being named in version
 * control (invisible, and the entire point of the design gone).
 */
describe("SupabaseProfileDirectory reads where the role came from", () => {
  it("carries a grant-sourced role through as a super admin", async () => {
    const { directory } = profiles([
      { id: SUB, email: "owner@example.org", role: "admin", role_source: "grant" },
    ]);
    const actor = await directory.resolve(claims());
    expect(actor).toMatchObject({ role: "admin", roleSource: "grant" });
    expect(isSuperAdmin(actor)).toBe(true);
  });

  it("carries an appointed admin through as NOT a super admin", async () => {
    // The distinction the whole feature rests on: same role, different source,
    // and only one of them may appoint anybody else.
    const { directory } = profiles([
      { id: SUB, email: "deputy@example.org", role: "admin", role_source: "appointed" },
    ]);
    const actor = await directory.resolve(claims());
    expect(actor).toMatchObject({ role: "admin", roleSource: "appointed" });
    expect(isSuperAdmin(actor)).toBe(false);
  });

  /**
   * A column this build cannot read must cost somebody their appointment
   * rights, never grant them. `self` is the source with no authority attached,
   * so an unrecognised value fails in the direction that protects the platform.
   */
  it.each([
    ["an unrecognised value", "root"],
    ["a missing column — a deployment still on 00009", undefined],
    ["null", null],
  ])("falls back to self for %s", async (_label, value) => {
    const row: Record<string, unknown> = { id: SUB, email: "a@b.c", role: "admin" };
    if (value !== undefined) row["role_source"] = value;
    const { directory } = profiles([row as never]);
    const actor = await directory.resolve(claims());
    expect(actor).toMatchObject({ roleSource: "self" });
    expect(isSuperAdmin(actor)).toBe(false);
  });

  it("asks the database for the column at all", async () => {
    // A `select` that omits `role_source` returns undefined for every row, so
    // every administrator silently stops being a super admin — the platform
    // still works, and nobody can appoint anybody ever again.
    const { fake, directory } = profiles([{ id: SUB, email: "a@b.c", role: "admin" }]);
    await directory.resolve(claims());
    expect(fake.queriesTo(USER_PROFILES_TABLE)[0]?.columns).toContain("role_source");
  });
});
