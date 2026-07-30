import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The page and the API must agree about coordinate provenance (ADR 0012 §1).
 *
 * This exists because of a real, live break. `POST /villages` gained a required
 * `geo.source`, and the page went on sending `geo: { lat, lng }` — so village
 * registration, the platform's primary write, was refused with a 400 that no
 * test covered. The type system could not see it: the page is a string to the
 * bundler, and the two sides only meet over HTTP.
 *
 * So the checks here are deliberately about ABSENCE — that the old shape is gone
 * — which is the kind of assertion no amount of adding features produces on its
 * own.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

describe("the village form captures provenance", () => {
  it("no longer offers bare latitude and longitude on either VILLAGE form", () => {
    // The regression itself. `n("lat", "Latitude")` and its Longitude twin were
    // the two fields that produced an unlabelled coordinate, on both the
    // registration form and the correction form.
    expect(PAGE).not.toMatch(/n\("lat",\s*"Latitude"/);
    expect(PAGE).not.toMatch(/n\("lng",\s*"Longitude"/);
  });

  /**
   * THE ISSUE FORM NOW USES THE CAPTURE CONTROL TOO — half of what ADR 0012
   * deferred, and the half that was hurting somebody.
   *
   * The previous version of this test asserted the opposite and said "when Issue
   * does adopt provenance, this test is the one that should fail and be
   * deleted". It failed, as designed. It is replaced rather than deleted,
   * because the deferral did not go away — it moved.
   *
   * What changed: the INPUT. Two decimal fields typed by hand became "use my
   * location", a map pin and a place-name search. That gap fell on the person
   * least able to absorb it — a village is registered once at a desk by somebody
   * holding the coordinates, an issue is reported in the field on a phone by
   * whoever is standing next to the contaminated handpump.
   *
   * What did NOT change: the STORAGE. `POST /issues` still takes a bare pair,
   * there are no `geo_source` / `geo_accuracy_metres` / `geo_captured_at`
   * columns on `issue_tracking_issues`, and the form therefore captures the
   * provenance and discards it. Carrying it through needs a migration and a
   * change to the Issue aggregate.
   *
   * So this is now the pin on the SMALLER remaining deferral. When Issue does
   * adopt provenance, this is again the test that should fail.
   */
  it("uses the capture control on the issue form, not hand-typed coordinates", () => {
    expect(PAGE).not.toMatch(/n\("lat",\s*"GPS latitude"/);
    expect(PAGE).not.toMatch(/n\("lng",\s*"GPS longitude"/);
    expect(PAGE).toContain('geo("geo", "Where is it?")');
  });

  it("still narrows to a bare pair for the API, which has nowhere to put provenance", () => {
    // Read out of the issue workflow specifically, so a match inside the village
    // form cannot make this pass.
    const issueForm = /id: "w-issue",[\s\S]*?\n      \},/.exec(PAGE);
    expect(issueForm, "the issue workflow is gone from the page").not.toBeNull();
    expect(issueForm?.[0] ?? "").toContain('geoValueOf(formId + "-geo")');
    expect(issueForm?.[0] ?? "").toMatch(/gps:\s*\{\s*lat:\s*captured\.lat,\s*lng:\s*captured\.lng\s*\}/);
    // The discard is explicit. A spread would send `source` to an endpoint that
    // rejects unknown fields, which is a 400 on the report of a broken bridge.
    expect(issueForm?.[0] ?? "").not.toContain("...captured");
  });

  it("builds a location on BOTH village forms from the capture control", () => {
    // Registration and correction. The correction form is the one that was easy
    // to miss: it also sends `geo`, and it also became a 400 when source arrived.
    expect(PAGE).toContain('geoValueOf(formId + "-geo")');
    expect(PAGE).toContain('geoValueOf("amend-profile-geo")');
  });

  /**
   * The correction form must NOT prefill the current coordinate. Re-submitting an
   * unchanged number through a control whose only no-network option is "type it"
   * would relabel a surveyed GPS position as `manual_entry` — silently
   * downgrading its trust while the user believed they were leaving it alone.
   */
  it("does not prefill a location into the correction form", () => {
    expect(PAGE).not.toContain('set("amend-profile-lat"');
    expect(PAGE).not.toContain('set("amend-profile-lng"');
  });

  it("never builds a geo object from raw form values", () => {
    // The exact expression that broke: `geo: { lat: Number(v.lat), … }`. A future
    // edit that reintroduces it fails here rather than in production.
    expect(PAGE).not.toMatch(/geo:\s*\{\s*lat:\s*Number\(v\.lat\)/);
  });

  it("uses the capture control, and refuses to submit without a position", () => {
    expect(PAGE).toMatch(/geo\("geo",\s*"Location"\)/);
    expect(PAGE).toMatch(/geoValueOf\(/);
    // The submit path must stop rather than send something the API will refuse.
    expect(PAGE).toMatch(/Set the village location first/);
  });

  it("offers all four capture methods ADR 0012 names", () => {
    for (const action of ["gps", "map", "search", "manual"]) {
      expect(PAGE, `missing capture method: ${action}`).toContain(`data-geo-act="${action}"`);
    }
  });

  it("records the four coordinate sources with the names the domain expects", () => {
    // Must match COORDINATE_SOURCES_BY_TRUST in the village domain, or the API
    // rejects the value with a message about an unknown source.
    for (const source of ["device_gps", "map_pin", "geocoded", "manual_entry"]) {
      expect(PAGE, `page never records source: ${source}`).toContain(source);
    }
  });

  /**
   * The confirmation rule, which is the load-bearing half of ADR 0012 §3: a
   * geocoder for rural Assam is frequently and confidently wrong, so a looked-up
   * position is recorded as `geocoded` — unverified — and only a deliberate human
   * placement promotes it.
   */
  it("records a geocoder result as geocoded, not as surveyed", () => {
    expect(PAGE).toMatch(/source:\s*"geocoded"/);
    // And the map click/drag handler is what produces the surveyed level.
    expect(PAGE).toMatch(/source:\s*"map_pin"/);
  });

  it("loads the map from our own origin and never a CDN", () => {
    expect(PAGE).toContain('"/map/leaflet.js"');
    expect(PAGE).toContain('"/map/leaflet.css"');
    expect(PAGE).toContain("/map/tiles/{z}/{x}/{y}.png");
    // The whole reason the library is vendored and the tiles proxied.
    expect(PAGE).not.toMatch(/unpkg\.com|cdn\.jsdelivr|tile\.openstreetmap\.org/);
  });

  it("credits OpenStreetMap where the map is shown, as the licence requires", () => {
    expect(PAGE).toMatch(/OpenStreetMap contributors/);
  });

  it("warns on an imprecise GPS fix rather than accepting it silently", () => {
    expect(PAGE).toMatch(/GPS_ACCURACY_WARN_METRES/);
    // Recorded either way — the accuracy is evidence a later reader can judge.
    expect(PAGE).toMatch(/accuracyMetres/);
  });

  it("treats a declined location permission as a normal path, not an error", () => {
    expect(PAGE).toMatch(/permission was declined/i);
  });
});
