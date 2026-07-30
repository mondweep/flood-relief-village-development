import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USER_ROLES } from "@afrip/shared-kernel";
import { describe, expect, it } from "vitest";

/**
 * The appointment panel, checked statically (ADR 0018).
 *
 * The page's gate is cosmetic — every `/admin` route calls `isSuperAdmin` — so
 * nothing here is a security control. What it protects against is the two ways
 * a cosmetic gate goes wrong silently: showing a panel whose every button
 * returns 403, or hiding it from the one person who may use it, in both cases
 * with no error anywhere.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

const SCRIPT = (/<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? "");

describe("the appointment panel follows the server's rule", () => {
  it("requires an admin whose role came from the grant list", () => {
    const gate = /function canAppoint\(\)[\s\S]*?\n\}/.exec(SCRIPT);
    expect(gate, "canAppoint is gone from the page").not.toBeNull();
    expect(gate?.[0] ?? "").toContain('user.role === "admin"');
    // The half that is the whole feature. Without it an appointed admin is
    // shown a panel they cannot use, which reads as the platform being broken.
    expect(gate?.[0] ?? "").toContain('user.roleSource === "grant"');
  });

  it("hides the panel from an administrator who was appointed in-app", () => {
    // Asserted through the availability function rather than the gate alone, so
    // that wiring the panel to the wrong gate fails too.
    const availability = /function applyFeedbackAvailability\(\)[\s\S]*?\n\}/.exec(SCRIPT);
    expect(availability?.[0] ?? "").toMatch(/#user-admin"\)[\s\S]{0,120}canAppoint\(\)/);
  });

  it("offers every role the platform has, and no others", () => {
    const list = /const ASSIGNABLE_ROLES = \[([^\]]*)\]/.exec(SCRIPT);
    expect(list, "ASSIGNABLE_ROLES is gone").not.toBeNull();
    const roles = [...(list?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(roles.sort()).toEqual([...USER_ROLES].sort());
  });

  /**
   * The two rows with no buttons are refused for different reasons and must say
   * so differently: your own row protects a super admin from removing the only
   * power that could put it back, and a grant-sourced row would be silently
   * undone by the next deployment. "You cannot do that" for both would send
   * somebody looking in the wrong place.
   */
  it("explains separately why your own row and a grant-sourced row are fixed", () => {
    const row = /function userRow\(user, meId\)[\s\S]*?\n\}/.exec(SCRIPT);
    expect(row, "userRow is gone").not.toBeNull();
    expect(row?.[0] ?? "").toMatch(/This is you/);
    expect(row?.[0] ?? "").toMatch(/next deployment/);
  });

  it("escapes the email it renders", () => {
    // Same reasoning as the suggestion list: this renders one user's data to
    // another user. An email is less freely chosen than a summary, and it is
    // still not this page's to trust.
    const row = /function userRow\(user, meId\)[\s\S]*?\n\}/.exec(SCRIPT);
    expect(row?.[0] ?? "").toContain("esc(user.email)");
    expect(row?.[0] ?? "").not.toMatch(/\+\s*user\.email\s*\+/);
  });

  it("confirms before appointing, and says what an administrator can read", () => {
    const setter = /async function setUserRole\([\s\S]*?\n\}/.exec(SCRIPT);
    expect(setter?.[0] ?? "").toContain("window.confirm");
    expect(setter?.[0] ?? "").toMatch(/beneficiary register/i);
    // And that the appointee cannot appoint further — the property that makes
    // this safe to click, so the person clicking should be told it.
    expect(setter?.[0] ?? "").toMatch(/NOT be able to appoint/);
  });

  it("calls the admin endpoints, not something that would 403 differently", () => {
    expect(SCRIPT).toContain('api("/admin/users")');
    expect(SCRIPT).toContain('api("/admin/users/"');
  });

  /**
   * The panel steers people towards `district_officer`. That is not a style
   * preference: a district officer already holds all 32 workflows, so admin is
   * only needed for the feedback queue, demonstration data, and bypassing every
   * check. Most appointments should not be admin, and the page should say so
   * where the decision is made.
   */
  it("says a district officer is usually the right role, not an administrator", () => {
    const section = /<div class="section hidden" id="user-admin"[\s\S]*?<div class="card">/.exec(PAGE);
    expect(section?.[0] ?? "").toMatch(/district officer/i);
    expect(section?.[0] ?? "").toMatch(/not checked/i);
  });

  it("tells the reader an appointed admin cannot appoint anyone else", () => {
    const section = /<div class="section hidden" id="user-admin"[\s\S]*?<div class="card">/.exec(PAGE);
    expect(section?.[0] ?? "").toMatch(/cannot appoint anyone else/i);
  });

  /**
   * `roleSource` must come from `GET /me` and never from the access token. A
   * role source decoded from a JWT is a claim its holder wrote about themselves,
   * and this particular field decides who may hand out unchecked access.
   */
  it("reads the role source from /me only", () => {
    const identity = /async function loadIdentity\(\)[\s\S]*?\n\}/.exec(SCRIPT);
    expect(identity?.[0] ?? "").toContain("res.data.roleSource");
    expect(identity?.[0] ?? "").not.toMatch(/payload[\s\S]{0,40}roleSource/);
  });
});
