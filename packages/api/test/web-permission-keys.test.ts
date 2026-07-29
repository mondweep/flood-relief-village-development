import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATFORM_PERMISSIONS } from "@afrip/platform";
import { describe, expect, it } from "vitest";

/**
 * The frontend's permission keys must be the server's permission keys.
 *
 * `GET /me` returns a list of `"<context>.<useCase>"` keys derived from
 * `PLATFORM_PERMISSIONS`, so the page holds no copy of the *matrix*. It does,
 * unavoidably, hold a copy of the KEY NAMES — `WORKFLOW_POLICY` maps each form
 * on the Operations view to the key that governs it, and the amendment panels
 * name keys inline. Those strings are hand-written, and both ways of getting one
 * wrong fail silently:
 *
 *   - a typo'd key is in no `permissions` array, so `can()` answers false and
 *     the control is hidden from EVERY role, forever, with no error;
 *   - a key that was renamed server-side does the same, on the day of the rename.
 *
 * Neither shows up in a browser as anything but a missing button, which is why
 * this is a test and not a comment. It reads the page as text rather than
 * importing it — the file is a self-contained HTML document with no module
 * boundary, and `packages/api` already consumes it exactly this way through
 * esbuild's text loader.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

/**
 * The bounded-context names, taken from the policy table rather than listed
 * here. A key is only a permission key if its first segment is one of these.
 *
 * That anchoring is what stops the scan misreading the page's other dotted
 * strings — `"afrip.token"` is a sessionStorage key and `"details.work"` is a
 * CSS selector, and a shape-based pattern flags both. Deriving the prefixes from
 * the server also means a tenth context is scanned for the day it is wired,
 * rather than the day someone remembers to extend a list here.
 */
const CONTEXT_PREFIXES = new Set(Object.keys(PLATFORM_PERMISSIONS).map((key) => key.split(".")[0]));

/** Every `"<context>.<member>"` string in the page, for a context that exists. */
function permissionKeysIn(source: string): string[] {
  const matches = source.matchAll(/"([a-zA-Z]+\.[a-zA-Z]+)"/g);
  const keys = [...matches]
    .map((match) => match[1] as string)
    .filter((key) => CONTEXT_PREFIXES.has(key.split(".")[0] as string));
  return [...new Set(keys)];
}

describe("the page's permission keys match the server's policy table", () => {
  const keysInPage = permissionKeysIn(PAGE);

  it("finds the keys at all — a regex that matches nothing would pass vacuously", () => {
    // Guards the test itself: if the page is restructured so the keys no longer
    // look like this, the assertions below would silently stop checking anything.
    expect(keysInPage.length).toBeGreaterThan(20);
  });

  it("names only keys the platform actually gates", () => {
    const unknown = keysInPage.filter((key) => PLATFORM_PERMISSIONS[key] === undefined);
    expect(
      unknown,
      `the page gates controls on keys that do not exist in PLATFORM_PERMISSIONS, so those ` +
        `controls are hidden from every role including admin: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("covers every write use case, so no form is left ungated by omission", () => {
    // Reads are excluded: a read the page performs without a gate simply gets a
    // 403 and renders the refusal, which is handled. A WRITE with no gate is a
    // button offered to someone who cannot use it.
    const readOnly = /^(get|list|read|leaderboard|recommend)|Repository$|signalExtractor$/;
    const writeKeys = Object.keys(PLATFORM_PERMISSIONS).filter(
      (key) => !readOnly.test(key.split(".")[1] as string),
    );

    const missing = writeKeys.filter((key) => !keysInPage.includes(key));
    expect(
      missing,
      `these write use cases have no permission key anywhere in the page, so their controls ` +
        `are shown to roles the API will refuse: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
