import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast rules the page must not break, checked statically.
 *
 * This file exists because of a real defect: the footer credits, the "Sign out"
 * text in the header pill and the "Forgotten your password?" link were all
 * coloured `var(--accent-ink)`. In light mode that is `#ffffff` and everything
 * looked fine; in dark mode it is `#10201f`, near-black, so all three vanished
 * against a near-black background. It shipped, and it was found by a person
 * looking at their phone.
 *
 * The trap is that the variable names read as interchangeable. They are not:
 *
 *   --accent         the accent BACKGROUND
 *   --accent-ink     text drawn ON that background — inverts between themes
 *   --accent-strong  accent-coloured text on the PAGE background — the link colour
 *
 * `--accent-ink` is only ever correct where an accent background is also set,
 * and that is exactly what the first test asserts. Nothing here can check actual
 * rendered contrast; it checks the one misuse that produced invisible text.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

/** The page's single <style> block. */
function styleSheet(source: string): string {
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
  if (match === null) throw new Error("no <style> block found");
  return match[1] as string;
}

/** Crude rule splitter: `selector { declarations }`. Good enough for a flat sheet. */
function rules(css: string): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments)) !== null) {
    out.push({ selector: (match[1] as string).trim(), body: (match[2] as string).trim() });
  }
  return out;
}

const SHEET = styleSheet(PAGE);
const RULES = rules(SHEET);

describe("accent variables are used for what they are", () => {
  it("finds the stylesheet at all — a regex matching nothing would pass vacuously", () => {
    expect(RULES.length).toBeGreaterThan(50);
    // And the variables themselves are still called what this test believes.
    expect(SHEET.includes("--accent-ink") || PAGE.includes("--accent-ink")).toBe(true);
  });

  /**
   * THE ONE THAT WOULD HAVE CAUGHT THE BUG.
   *
   * `--accent-ink` inverts between themes because it is meant to sit on an
   * accent-coloured background, which also inverts. Used as a plain text colour
   * it is white-on-white in one theme or black-on-black in the other — always
   * broken in exactly one of them, which is why it survives review.
   */
  it("never sets color: var(--accent-ink) without an accent background", () => {
    const offenders = RULES.filter((rule) => {
      const setsAccentInkColor = /(^|[;\s])color:\s*var\(--accent-ink\)/.test(rule.body);
      if (!setsAccentInkColor) return false;
      const setsAccentBackground = /background(-color)?:\s*var\(--accent[-a-z]*\)/.test(rule.body);
      return !setsAccentBackground;
    });

    expect(
      offenders.map((rule) => rule.selector),
      "these rules colour text with --accent-ink but do not set an accent background, so the " +
        "text is invisible in one of the two themes (near-black on dark, white on light)",
    ).toEqual([]);
  });

  /**
   * NOT TESTED, deliberately: the mirror-image rule, "an accent background must
   * declare its text colour".
   *
   * It was written, and it flagged `.bar > i` — the fill of a progress bar,
   * which is an empty element inside a `role="img"` span and contains no text to
   * colour. That is a false positive on correct code, and a static check cannot
   * tell a filled shape from a label without knowing what the element holds.
   *
   * Removed rather than given an exemption list, because a check with a growing
   * list of "except these" is one somebody eventually deletes or stops reading —
   * and it would take the rule above, which is precise and did catch a real
   * defect, down with it.
   */
});

describe("the page does not reference styles it never defines", () => {
  /**
   * `class="btn"` shipped on the "Register with AFRIP" button. No `.btn` rule
   * exists, so it rendered as a browser-default button among styled ones — a
   * silent miss, because an undefined class is not an error anywhere.
   *
   * Checked for a small set of names rather than every class in the document:
   * the markup is generated in places and a full sweep produces false positives
   * that would get the test deleted.
   */
  it.each(["btn", "linkish", "button-primary", "link-button"])(
    "does not use the undefined class %s",
    (name) => {
      const used = new RegExp(`class="[^"]*\\b${name}\\b[^"]*"`).test(PAGE);
      const defined = new RegExp(`\\.${name}[\\s,{:]`).test(SHEET);
      expect(used && !defined, `class="${name}" is used but never defined in the stylesheet`).toBe(
        false,
      );
    },
  );
});

describe("the credits and provenance the footer promises are present", () => {
  /**
   * These are attribution, not decoration: the people who conceived and built
   * the platform, and the jurisdiction holding beneficiary data. A refactor that
   * drops them is a factual regression, not a cosmetic one.
   */
  it.each([
    ["Dilip Bharatee", "linkedin.com/in/dilip-bharatee-951232"],
    ["Mondweep Chakravorty", "linkedin.com/in/mondweepchakravorty"],
  ])("credits %s with a working link", (name, profile) => {
    expect(PAGE).toContain(name);
    expect(PAGE).toContain(profile);
  });

  it("states where personal data physically rests", () => {
    expect(PAGE).toMatch(/eu-west-1/);
    expect(PAGE).toMatch(/europe-west2/);
  });
});
