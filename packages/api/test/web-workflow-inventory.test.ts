import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATFORM_PERMISSIONS } from "@afrip/platform";
import { USER_ROLES, type UserRole } from "@afrip/shared-kernel";
import { describe, expect, it } from "vitest";

/**
 * What the Operations page offers, and to whom.
 *
 * WHY THIS EXISTS. The maintainer opened the page and asked whether features had
 * been removed — "I believe we had a lot more feature in the Ops page when I
 * checked previously". Nothing had been removed. They were signed in as a
 * `citizen`, which sees 9 of the 32 workflows, and the page gave no way to tell
 * a narrow role from a shrunken product.
 *
 * If the person who built it cannot tell those apart by looking, nobody can. So
 * the inventory is pinned here: a workflow that disappears from the page now
 * fails a test with a name that says what went missing, instead of being noticed
 * months later by somebody who half-remembers it.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

/** Every workflow the page defines, as id -> title. */
function workflows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, id, title] of PAGE.matchAll(/id: "(w-[\w-]+)", title: "([^"]+)"/g)) {
    out[id as string] = title as string;
  }
  return out;
}

/** The gate on each workflow: id -> [permission key, ownable]. */
function policy(): Record<string, { key: string; ownable: boolean }> {
  const block = /const WORKFLOW_POLICY = \{([\s\S]*?)\n\};/.exec(PAGE);
  if (block === null) throw new Error("WORKFLOW_POLICY is gone from the page");
  const out: Record<string, { key: string; ownable: boolean }> = {};
  for (const [, id, key, , ownable] of block[1]!.matchAll(
    /"(w-[\w-]+)":\s*\["([\w.]+)",\s*"([^"]*)"(,\s*true)?\]/g,
  )) {
    out[id as string] = { key: key as string, ownable: Boolean(ownable) };
  }
  return out;
}

const WORKFLOWS = workflows();
const POLICY = policy();

/** Mirrors `permitted()` in the page: role grant, or ownership widening, or admin. */
function visibleTo(role: UserRole): string[] {
  return Object.keys(WORKFLOWS).filter((id) => {
    const gate = POLICY[id];
    if (gate === undefined) return true; // ungated forms are shown; the server still refuses
    if (role === "admin") return true;
    const rule = (PLATFORM_PERMISSIONS as Record<string, { roles: readonly UserRole[] } | undefined>)[gate.key];
    if (rule === undefined) return true;
    return rule.roles.includes(role) || gate.ownable;
  });
}

describe("the Operations page still offers everything it was built with", () => {
  /**
   * A COUNT, not a list of names, so that renaming a form is not a failure but
   * losing one is. 32 is what nine bounded contexts' worth of use cases came to;
   * if this number goes DOWN, something was deleted and the commit that did it
   * should have to say so.
   */
  it("defines 32 workflows", () => {
    expect(Object.keys(WORKFLOWS)).toHaveLength(32);
  });

  it("gates every one of them, so none is shown by accident", () => {
    const ungated = Object.keys(WORKFLOWS).filter((id) => POLICY[id] === undefined);
    expect(ungated, "these workflows have no WORKFLOW_POLICY entry").toEqual([]);
  });

  it("names a real permission key for each, or the form is hidden from everyone forever", () => {
    const unknown = Object.entries(POLICY)
      .filter(([, gate]) => !(gate.key in PLATFORM_PERMISSIONS))
      .map(([id, gate]) => `${id} -> ${gate.key}`);
    expect(unknown, "these keys are in no policy table, so can() answers false for every role").toEqual([]);
  });

  /**
   * The four capabilities a citizen has, named individually because they are the
   * platform's promise to the people it is for: report what is wrong where you
   * live, sign up to help, and send in what you have seen.
   */
  it.each([
    ["w-issue", "Report an issue"],
    ["w-volunteer", "Register a volunteer"],
    ["w-availability", "Set volunteer availability"],
    ["w-signal", "Ingest a field report or post"],
  ])("shows %s (%s) to a plain citizen", (id) => {
    expect(visibleTo("citizen")).toContain(id);
  });

  it("shows a district officer and an admin everything", () => {
    expect(visibleTo("district_officer")).toHaveLength(Object.keys(WORKFLOWS).length);
    expect(visibleTo("admin")).toHaveLength(Object.keys(WORKFLOWS).length);
  });

  it("gives every role something to do", () => {
    for (const role of USER_ROLES) {
      expect(visibleTo(role).length, `${role} sees no workflows at all`).toBeGreaterThan(0);
    }
  });

  /**
   * THE FIX FOR THE CONFUSION ITSELF.
   *
   * A citizen seeing 9 of 32 forms, with nothing on the page saying 32 exist,
   * looks exactly like a product that lost features. Two things now say
   * otherwise: a count at the top, and a per-group line where only SOME of a
   * group's workflows are hidden — which was the silent case, and the one that
   * made "Volunteers" show two forms while two others existed unmentioned.
   */
  it("tells the reader how many workflows exist, not just how many they can use", () => {
    const build = /function buildWorkflows\(\)[\s\S]*?\n\}/.exec(PAGE);
    expect(build, "buildWorkflows is gone").not.toBeNull();
    expect(build?.[0] ?? "").toMatch(/Showing[\s\S]{0,40}shown \+ " of " \+ total/);
  });

  it("says when a group is only partly hidden, which used to be silent", () => {
    const build = /function buildWorkflows\(\)[\s\S]*?\n\}/.exec(PAGE);
    expect(build?.[0] ?? "").toContain("further workflows in this group are");
  });
});
