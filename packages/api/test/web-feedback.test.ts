import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  MAX_SUMMARY_LENGTH,
  MAX_DETAIL_LENGTH,
  MAX_USER_AGENT_LENGTH,
} from "../src/feedback.js";

/**
 * The report form, checked from the outside (ADR 0016).
 *
 * Same reason `web-permission-keys.test.ts` exists: the page is a self-contained
 * HTML document with no module boundary, so `npm test` never executes a line of
 * it. Every one of the failures below therefore reaches a browser silently —
 * a button that files a `kind` the API refuses, a filter that 400s, a syntax
 * error that blanks the whole dashboard — and none of them is visible to
 * esbuild, which loads this file as an opaque string.
 *
 * These are the checks that a mismatch cannot survive. They are not a substitute
 * for opening the page.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

/** The page's single inline script. */
function pageScript(source: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(source);
  if (match === null) throw new Error("no inline <script> found");
  return match[1] as string;
}

const SCRIPT = pageScript(PAGE);

describe("the page's script is at least syntactically a program", () => {
  /**
   * THE CHEAPEST CHECK IN THE REPOSITORY, AND THE ONE WITH THE WORST FAILURE
   * MODE BEHIND IT.
   *
   * A stray brace anywhere in ~6,700 lines of inline JavaScript means the
   * browser discards the ENTIRE script. Not the broken function — all of it.
   * The dashboard then renders as static markup: no routing, no data, no
   * sign-in, every button dead. Nothing in this repository would notice.
   * `npm test` never runs the page; `npm run build` inlines it as text through
   * esbuild's `.html` loader, which does not parse what it embeds; the deploy
   * succeeds; `/health` answers; the smoke test in CI fetches `/` and gets a
   * 200 back, because the document is served perfectly — it simply does not
   * work.
   *
   * `new Script` compiles without executing, so no browser global is touched.
   * It proves the file parses. It proves nothing about behaviour.
   */
  it("parses", () => {
    expect(SCRIPT.length).toBeGreaterThan(1000);
    expect(() => new Script(SCRIPT, { filename: "packages/web/src/index.html" })).not.toThrow();
  });
});

describe("the kinds the form offers are the kinds the API accepts", () => {
  /**
   * `FEEDBACK_KINDS` is a CLOSED set: `normaliseDraft` rejects anything outside
   * it and the 00009 CHECK constraint rejects it again. A fourth button added
   * to the dialog without adding the value to that list produces a 400 whose
   * message names `kind` — a field the user never filled in, on a form whose
   * whole purpose is that somebody took the trouble to tell us something.
   *
   * The reverse is quieter and therefore worse: a kind the API accepts but the
   * form never offers is simply unreachable, and no failure is reported to
   * anyone. So this is an equality, not a subset.
   */
  const offered = [...SCRIPT.matchAll(/data-kind="([a-z]+)"/g)].map((m) => m[1] as string);
  const inMarkup = [...PAGE.matchAll(/data-kind="([a-z]+)"/g)].map((m) => m[1] as string);

  it("offers a button for every kind and no others", () => {
    expect([...new Set(inMarkup)].sort()).toEqual([...FEEDBACK_KINDS].sort());
  });

  it("names the same set in the script's own copy", () => {
    // The script holds a literal list too, used to reject a bad `data-kind`.
    const literal = /const FEEDBACK_KINDS = \[([^\]]*)\]/.exec(SCRIPT);
    expect(literal, "the page no longer declares FEEDBACK_KINDS").not.toBeNull();
    const names = [...(literal?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1] as string);
    expect(names.sort()).toEqual([...FEEDBACK_KINDS].sort());
    // And that list is what the buttons are checked against, so the two markup
    // and script copies cannot drift apart without one of these three failing.
    expect(offered.length).toBe(0); // data-kind lives in markup, not in the script
  });
});

describe("the queue's status filters are the API's statuses", () => {
  /**
   * `GET /feedback?status=` REFUSES a value outside the closed set rather than
   * ignoring it — deliberately, so a filter cannot silently match nothing. That
   * choice is what makes a wrong button here a visible 400 instead of an empty
   * queue, and it is also what makes this test necessary: the buttons were first
   * written as `new` and `triaged`, which are not statuses this platform has.
   */
  const filters = [...PAGE.matchAll(/data-fstatus="([a-z]*)"/g)].map((m) => m[1] as string);

  it("offers exactly the real statuses, plus an unfiltered option", () => {
    expect(filters).toContain(""); // "All"
    expect(filters.filter((f) => f !== "").sort()).toEqual([...FEEDBACK_STATUSES].sort());
  });

  it("offers every status as a transition an administrator can apply", () => {
    const actions = /const FEEDBACK_STATUS_ACTIONS = \[([^\]]*)\]/.exec(SCRIPT);
    expect(actions, "the page no longer declares FEEDBACK_STATUS_ACTIONS").not.toBeNull();
    const names = [...(actions?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1] as string);
    expect(names.sort()).toEqual([...FEEDBACK_STATUSES].sort());
  });
});

describe("the form never asserts who is reporting", () => {
  /**
   * THE ONE THAT MATTERS MOST.
   *
   * `routes/feedback.ts` builds the reporter from `ctx.actor` and reads nothing
   * from the body, so a `reporterId` sent from here would be ignored rather than
   * obeyed — the server is not weakened by the page sending one.
   *
   * The damage is to the next reader. A page that posts `reporterEmail`
   * alongside `viewPath` reads as though the server trusts it, and the natural
   * "tidy-up" is to make the server use what the client so obviously supplies.
   * At that point any signed-in user can file a report in a colleague's name,
   * and the administrator working the queue goes back to the wrong person about
   * words they never wrote — a fabricated record, on a platform whose founding
   * complaint is that records cannot be trusted.
   */
  const submitBody = /await api\("\/feedback", \{[\s\S]*?\n  \}\);/.exec(SCRIPT);

  it("was found at all — a regex matching nothing would pass vacuously", () => {
    expect(submitBody, "the POST /feedback call could not be located in the page").not.toBeNull();
  });

  it.each(["reporterId", "reporterEmail", "reporterRole", "reporter"])(
    "does not send %s",
    (field) => {
      expect(submitBody?.[0] ?? "").not.toContain(field);
    },
  );

  it("does send the context the server cannot know", () => {
    const body = submitBody?.[0] ?? "";
    for (const field of ["kind", "summary", "detail", "buildCommit", "buildBranch", "viewPath"]) {
      expect(body, `the report no longer carries ${field}`).toContain(field);
    }
  });
});

describe("the reporter is told not to type names", () => {
  /**
   * The instruction is the only control there is on what goes into a free-text
   * box. It is imperfect by construction — which is exactly why the read side is
   * `admin` alone — but a form that omits it will collect names it did not have
   * to collect, and those names are the registry's: widows and orphaned
   * children.
   *
   * Checked for placement as well as presence. Below the fields it is read after
   * the typing is done, which is the same as not being there.
   */
  it("warns before the fields, not after them", () => {
    const warning = PAGE.indexOf('id="report-pii"');
    const firstField = PAGE.indexOf('id="report-summary"');
    expect(warning, "the PII warning is gone from the report dialog").toBeGreaterThan(-1);
    expect(firstField).toBeGreaterThan(-1);
    expect(warning, "the warning must come before the first field a user types into")
      .toBeLessThan(firstField);
  });

  it("asks for identifiers rather than names, in both the warning and the placeholder", () => {
    const warning = /<div class="callout warn" id="report-pii">([\s\S]*?)<\/div>/.exec(PAGE);
    expect(warning).not.toBeNull();
    expect(warning?.[1] ?? "").toMatch(/identifier/i);
    expect(warning?.[1] ?? "").toMatch(/name/i);
    // Repeated where the free text is actually typed. The warning above is read
    // once; the placeholder is in front of the cursor.
    const detail = /<textarea id="report-detail"[\s\S]*?placeholder="([^"]*)"/.exec(PAGE);
    expect(detail, "the detail box lost its placeholder").not.toBeNull();
    expect(detail?.[1] ?? "").toMatch(/identifier/i);
  });
});

describe("the client's limits do not exceed the server's", () => {
  /**
   * `maxlength` is a courtesy — it stops the typing rather than refusing it
   * afterwards. It is not a control: the server re-applies every cap in
   * `normaliseDraft`, twice (route and adapter).
   *
   * What it must not be is LOOSER than the server's, because then someone
   * types 300 characters into a field that says nothing is wrong and is told
   * "summary must be at most 200 characters" only once they press send.
   */
  it.each([
    ["report-summary", MAX_SUMMARY_LENGTH],
    ["report-detail", MAX_DETAIL_LENGTH],
  ])("caps %s at or below the server's limit", (id, serverMax) => {
    const found = new RegExp(`id="${id}"[\\s\\S]*?maxlength="(\\d+)"`).exec(PAGE);
    expect(found, `#${id} has no maxlength`).not.toBeNull();
    expect(Number(found?.[1] ?? "0")).toBeLessThanOrEqual(serverMax);
  });

  it("truncates the user agent rather than having it silently rejected", () => {
    // Sent from the body (RequestContext carries no headers) and capped there,
    // so an unusually long agent string would otherwise 400 the whole report.
    const slice = /navigator\.userAgent \|\| ""\)\.slice\(0, (\d+)\)/.exec(SCRIPT);
    expect(slice, "the user agent is no longer truncated client-side").not.toBeNull();
    expect(Number(slice?.[1] ?? "0")).toBeLessThanOrEqual(MAX_USER_AGENT_LENGTH);
  });
});

describe("the controls follow the session", () => {
  /**
   * Cosmetic, like `can()` — `POST /feedback` refuses an unidentified caller and
   * `GET /feedback` refuses every non-admin role, whatever this page shows.
   *
   * Worth pinning anyway. Offering "Report a problem" to a signed-out reader is
   * an invitation to a 403 on the one control whose whole purpose is to be easy
   * to reach, and showing a district officer a queue they cannot open is a
   * promise the API will break.
   */
  it("hides the report button until there is a session", () => {
    expect(PAGE).toMatch(/id="report-open"/);
    expect(SCRIPT).toMatch(/\$\("#report-open"\)[\s\S]{0,120}classList\.toggle\("hidden", !canReport\(\)\)/);
  });

  it("gates the queue on the admin role alone, not on admin plus district officer", () => {
    const guard = /function canReadFeedback\(\) \{([\s\S]*?)\n\}/.exec(SCRIPT);
    expect(guard).not.toBeNull();
    expect(guard?.[1] ?? "").toContain('"admin"');
    expect(guard?.[1] ?? "").not.toContain("district_officer");
  });
});

describe("the page and the API agree about the route names", () => {
  /**
   * The page hand-writes three paths. A rename on either side is invisible until
   * somebody presses the button, and `POST /feedback` is pressed by users rather
   * than by developers — so the first person to find a renamed route would be
   * somebody trying to report a different fault entirely.
   */
  const require = createRequire(import.meta.url);
  const routeSource = readFileSync(
    require.resolve("../src/routes/feedback.ts"),
    "utf8",
  );

  it.each([
    ["post", "/feedback"],
    ["get", "/feedback"],
    ["patch", "/feedback/:id"],
  ])("registers %s %s server-side", (method, path) => {
    expect(routeSource).toContain(`router.${method}("${path}"`);
  });

  it("calls those paths from the page", () => {
    expect(SCRIPT).toContain('api("/feedback"');
    expect(SCRIPT).toContain('api("/feedback/"');
  });
});
