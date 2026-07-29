import { describe, expect, it } from "vitest";
import { unwrap } from "@afrip/shared-kernel";
import { NominatimGeocoding, type FetchLike, type FetchResponse } from "../src/index.js";

/**
 * ADR 0012 §3 — the zero-cost adapter.
 *
 * NOTHING HERE TOUCHES THE NETWORK, and that is deliberate rather than tidy: a
 * test that calls the live Nominatim fails on a plane, and burns the one
 * request per second the usage policy allows the whole deployment. Every case
 * below drives a stubbed fetch.
 */

const USER_AGENT = "AFRIP-test/0.1 (ops@example.org)";

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface Stub {
  readonly fetch: FetchLike;
  readonly calls: Call[];
  readonly sleeps: number[];
  readonly geocoder: NominatimGeocoding;
}

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** A clock that only advances when the adapter's own sleep is awaited. */
function stubWith(
  handler: (url: string) => FetchResponse | Promise<FetchResponse>,
  options: { minIntervalMs?: number } = {},
): Stub {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return handler(url);
  };

  const geocoder = new NominatimGeocoding({
    userAgent: USER_AGENT,
    baseUrl: "https://nominatim.example.test",
    fetch: fetchImpl,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });

  return { fetch: fetchImpl, calls, sleeps, geocoder };
}

const place = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  lat: "26.3223",
  lon: "90.9871",
  display_name: "Rampur, Barpeta, Assam, India",
  importance: 0.4,
  addresstype: "village",
  address: { state_district: "Barpeta", state: "Assam" },
  ...over,
});

describe("Nominatim usage policy", () => {
  it("refuses to be constructed without an identifying User-Agent", () => {
    expect(
      () => new NominatimGeocoding({ userAgent: "  ", fetch: async () => response(200, "[]") }),
    ).toThrow(/identifying User-Agent/);
  });

  it("sends the User-Agent on every request", async () => {
    const stub = stubWith(() => response(200, JSON.stringify([place()])));

    await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });
    await stub.geocoder.reverse({ lat: 26.3, lng: 91.0 });

    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) expect(call.headers["User-Agent"]).toBe(USER_AGENT);
  });

  /**
   * One request per second, absolute. Bursting is what gets the deployment's IP
   * banned, and a ban lands on every field worker at once.
   */
  it("waits a second between requests", async () => {
    const stub = stubWith(() => response(200, "[]"));

    await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });
    expect(stub.sleeps).toEqual([]);

    await stub.geocoder.forward({ name: "Kalgachia", district: "Barpeta" });
    await stub.geocoder.reverse({ lat: 26.3, lng: 91.0 });

    expect(stub.sleeps).toEqual([1000, 1000]);
  });

  it("paces concurrent callers too — the limit is global, not per call site", async () => {
    const stub = stubWith(() => response(200, "[]"));

    await Promise.all([
      stub.geocoder.forward({ name: "A", district: "Barpeta" }),
      stub.geocoder.forward({ name: "B", district: "Barpeta" }),
      stub.geocoder.forward({ name: "C", district: "Barpeta" }),
    ]);

    expect(stub.sleeps).toEqual([1000, 1000]);
    expect(stub.calls).toHaveLength(3);
  });
});

describe("NominatimGeocoding.forward — the query", () => {
  it("biases to Assam and India and carries the district from the form", async () => {
    const stub = stubWith(() => response(200, "[]"));

    await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    const url = new URL(stub.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("Rampur, Barpeta, Assam, India");
    expect(url.searchParams.get("countrycodes")).toBe("in");
    expect(url.searchParams.get("viewbox")).toBe("89.6,28.3,96.1,24.1");
    expect(url.searchParams.get("addressdetails")).toBe("1");
  });

  it("uses a neighbouring state when one is given", async () => {
    const stub = stubWith(() => response(200, "[]"));

    await stub.geocoder.forward({ name: "Rampur", district: "Cooch Behar", state: "West Bengal" });

    const url = new URL(stub.calls[0]?.url ?? "");
    expect(url.searchParams.get("q")).toBe("Rampur, Cooch Behar, West Bengal, India");
  });

  it("rejects an empty name or district before spending a request", async () => {
    const stub = stubWith(() => response(200, "[]"));

    expect((await stub.geocoder.forward({ name: " ", district: "Barpeta" })).ok).toBe(false);
    expect((await stub.geocoder.forward({ name: "Rampur", district: " " })).ok).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("NominatimGeocoding.forward — the results", () => {
  it("returns candidates, ranked, with enough description to choose between them", async () => {
    const stub = stubWith(() =>
      response(
        200,
        JSON.stringify([
          place({ display_name: "Rampur Pt II, Barpeta, Assam, India", importance: 0.1 }),
          place(),
        ]),
      ),
    );

    const candidates = unwrap(await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" }));

    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.confidence).toBeGreaterThan(candidates[1]?.confidence ?? 1);
    expect(candidates[0]).toMatchObject({
      lat: 26.3223,
      lng: 90.9871,
      district: "Barpeta",
      state: "Assam",
      kind: "village",
      provider: "nominatim",
    });
    expect(candidates[0]?.displayName).toContain("Barpeta");
  });

  it("never claims certainty, whatever the upstream importance says", async () => {
    const stub = stubWith(() => response(200, JSON.stringify([place({ importance: 1 })])));

    const candidates = unwrap(await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" }));
    expect(candidates[0]?.confidence).toBeLessThanOrEqual(0.9);
  });

  it("drops a result from a different district — the form already said which one", async () => {
    const stub = stubWith(() =>
      response(
        200,
        JSON.stringify([
          place({
            display_name: "Rampur, Sivasagar, Assam, India",
            address: { state_district: "Sivasagar", state: "Assam" },
          }),
          place(),
        ]),
      ),
    );

    const candidates = unwrap(await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" }));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.district).toBe("Barpeta");
  });

  /**
   * Constraint 1 again: many chapori settlements come back with a sparse
   * address. Filtering those out would discard exactly the results this
   * geography most needs.
   */
  it("keeps a result whose address names no district at all", async () => {
    const stub = stubWith(() =>
      response(200, JSON.stringify([place({ address: {}, display_name: "Jaha Chapori" })])),
    );

    const candidates = unwrap(await stub.geocoder.forward({ name: "Jaha", district: "Dhemaji" }));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.district).toBeUndefined();
  });

  it("reports a genuine no-match as an empty ok", async () => {
    const stub = stubWith(() => response(200, "[]"));

    const result = await stub.geocoder.forward({ name: "Nowhere", district: "Barpeta" });

    expect(result).toEqual({ ok: true, value: [] });
  });
});

/**
 * The load-bearing distinction: "no such village" and "the geocoder is down"
 * must not look alike. Every case here would be indistinguishable from the
 * empty-ok above if the adapter swallowed failures.
 */
describe("NominatimGeocoding — failure is never an empty list", () => {
  it("errs on a 500", async () => {
    const stub = stubWith(() => response(500, "upstream exploded"));

    const result = await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("nominatim responded 500");
  });

  it("errs on a 429, which is what a policy violation looks like", async () => {
    const stub = stubWith(() => response(429, ""));

    const result = await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("nominatim responded 429");
  });

  it("errs on a body that is not JSON", async () => {
    const stub = stubWith(() => response(200, "<html>service unavailable</html>"));

    const result = await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/malformed body/);
  });

  it("errs on JSON of the wrong shape", async () => {
    const stub = stubWith(() => response(200, JSON.stringify({ results: [] })));

    const result = await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expected an array of places/);
  });

  it("errs on a place with no usable coordinates", async () => {
    const stub = stubWith(() => response(200, JSON.stringify([place({ lat: "north-ish" })])));

    const result = await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no usable lat\/lon/);
  });

  it("errs rather than throwing when the request itself fails", async () => {
    const stub = stubWith(() => {
      throw new Error("ECONNREFUSED");
    });

    const result = await stub.geocoder.forward({ name: "Rampur", district: "Barpeta" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("nominatim request failed: ECONNREFUSED");
  });
});

describe("NominatimGeocoding.reverse", () => {
  it("describes the point", async () => {
    const stub = stubWith(() =>
      response(
        200,
        JSON.stringify({
          display_name: "Rampur, Barpeta, Assam, India",
          address: { state_district: "Barpeta", state: "Assam" },
        }),
      ),
    );

    const described = unwrap(await stub.geocoder.reverse({ lat: 26.3223, lng: 90.9871 }));

    expect(described).toEqual({
      displayName: "Rampur, Barpeta, Assam, India",
      district: "Barpeta",
      state: "Assam",
      provider: "nominatim",
    });
    const url = new URL(stub.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("lat")).toBe("26.3223");
    expect(url.searchParams.get("lon")).toBe("90.9871");
  });

  it("distinguishes 'nothing here' from an outage", async () => {
    const stub = stubWith(() => response(200, JSON.stringify({ error: "Unable to geocode" })));

    const result = await stub.geocoder.reverse({ lat: 0, lng: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("nominatim found no place at that point");
  });

  it("rejects an out-of-range point before spending a request", async () => {
    const stub = stubWith(() => response(200, "{}"));

    expect((await stub.geocoder.reverse({ lat: 91, lng: 0 })).ok).toBe(false);
    expect((await stub.geocoder.reverse({ lat: 0, lng: 181 })).ok).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});
