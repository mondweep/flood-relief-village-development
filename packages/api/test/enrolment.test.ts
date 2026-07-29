import { AFRIP_SCHEMA } from "@afrip/shared-kernel";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedClaims } from "../src/auth.js";
import { ENROL_USER_FUNCTION, SupabaseEnrolmentService } from "../src/enrolment.js";

const SUB = "11111111-2222-3333-4444-555555555555";

function claims(overrides: Partial<VerifiedClaims> = {}): VerifiedClaims {
  return { sub: SUB, email: "new@example.org", payload: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// A local double, not the shared fake
// ---------------------------------------------------------------------------
// `fake-supabase-client.ts` models `.from(table)` query builders and has no
// `.rpc()` at all. It is shared with every other adapter test and someone else
// is working in that file right now, so this defines its own double rather than
// widening theirs.
//
// It implements the SEMANTICS of `assam_floods.enrol_user` — role from
// `role_grants` else citizen, `on conflict (id) do nothing`, then read the row
// back — because two of the guarantees under test ("idempotent", "a second call
// never resets a role") are properties of that behaviour, and a stub that
// returns a canned row would assert nothing about them.

interface FakeProfile {
  id: string;
  email: string;
  role: string;
}

interface RpcCall {
  schema: string;
  fn: string;
  args: Record<string, unknown>;
}

interface FakeRpcOptions {
  /** `role_grants`, keyed on lowercased email. */
  grants?: Record<string, string>;
  /** Rows already in `user_profiles` before the call. */
  profiles?: FakeProfile[];
  /** Answer with a Postgres-style error payload. */
  failWith?: string;
  /** Reject, the way a DNS/TLS failure does. */
  throwWith?: string;
}

/** What `.rpc()` resolves against when no schema was selected, as in supabase-js. */
const DEFAULT_CLIENT_SCHEMA = "public";

function createFakeRpc(options: FakeRpcOptions = {}) {
  const calls: RpcCall[] = [];
  const profiles = new Map<string, FakeProfile>(
    (options.profiles ?? []).map((p) => [p.id, { ...p }]),
  );
  const grants = options.grants ?? {};

  const rpcIn = (schema: string) =>
    vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ schema, fn, args });

      if (options.throwWith !== undefined) throw new Error(options.throwWith);
      if (options.failWith !== undefined) {
        return { data: null, error: { message: options.failWith } };
      }
      if (fn !== ENROL_USER_FUNCTION) {
        return { data: null, error: { message: `function ${schema}.${fn} does not exist` } };
      }

      const id = String(args.p_user_id);
      const email = String(args.p_email);

      // `insert ... on conflict (id) do nothing`.
      if (!profiles.has(id)) {
        profiles.set(id, { id, email, role: grants[email.toLowerCase()] ?? "citizen" });
      }
      // ...then the read-back, which is what makes a repeat call idempotent.
      return { data: [{ ...profiles.get(id) }], error: null };
    });

  // A bare `.rpc()` — no schema selected — lands in `public` like supabase-js,
  // so an adapter that forgot the schema is visible rather than silently fine.
  const client = {
    rpc: rpcIn(DEFAULT_CLIENT_SCHEMA),
    schema: vi.fn((name: string) => ({ rpc: rpcIn(name) })),
  } as unknown as SupabaseClient;

  return { client, calls, profiles };
}

function service(options: FakeRpcOptions = {}) {
  const fake = createFakeRpc(options);
  return { fake, enrolment: new SupabaseEnrolmentService(fake.client, AFRIP_SCHEMA) };
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("SupabaseEnrolmentService", () => {
  it("enrols a verified identity and returns the resulting actor", async () => {
    const { enrolment } = service();

    const result = await enrolment.enrol(claims());

    expect(result).toEqual({
      ok: true,
      value: { id: SUB, email: "new@example.org", role: "citizen" },
    });
  });

  it("takes the role from role_grants, never from the caller", async () => {
    const { fake, enrolment } = service({ grants: { "mondweep@dxsure.uk": "admin" } });

    const result = await enrolment.enrol(
      claims({ email: "mondweep@dxsure.uk", payload: { role: "citizen" } }),
    );

    expect(result).toMatchObject({ ok: true, value: { role: "admin" } });
    // Nothing resembling a role crosses the wire — the database decides.
    expect(Object.keys(fake.calls[0]?.args ?? {})).toEqual(["p_user_id", "p_email"]);
  });

  it("calls enrol_user in the AFRIP schema with the verified subject and email", async () => {
    const { fake, enrolment } = service();

    await enrolment.enrol(claims());

    expect(fake.calls).toEqual([
      {
        schema: AFRIP_SCHEMA,
        fn: ENROL_USER_FUNCTION,
        args: { p_user_id: SUB, p_email: "new@example.org" },
      },
    ]);
    expect(fake.calls.map((c) => c.schema)).not.toContain("public");
  });

  /**
   * `user_profiles.email` is `not null unique`. Enrolling with '' would let the
   * first emailless registrant take that row and every later one collide on the
   * unique index — a failure that reports a duplicate email rather than a
   * missing one. Refuse, and refuse before touching the database.
   */
  it("refuses a claims payload with no email, without calling the RPC", async () => {
    const { fake, enrolment } = service();
    const logged = silenceErrors();

    try {
      const result = await enrolment.enrol(claims({ email: null }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/email/i);
      expect(fake.calls).toEqual([]);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("treats a blank email the same way as a missing one", async () => {
    const { fake, enrolment } = service();
    const logged = silenceErrors();

    try {
      expect((await enrolment.enrol(claims({ email: "   " }))).ok).toBe(false);
      expect(fake.calls).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * Unlike the ownership registry, this failure must reach the user: they asked
   * to register, it did not happen, and reporting success would be a lie they
   * discover on their next request.
   */
  it("returns err — and logs — when the RPC fails", async () => {
    const { enrolment } = service({ failWith: "permission denied for function enrol_user" });
    const logged = silenceErrors();

    try {
      const result = await enrolment.enrol(claims());

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("permission denied for function");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("returns err when the call rejects outright", async () => {
    const { enrolment } = service({ throwWith: "fetch failed" });
    const logged = silenceErrors();

    try {
      const result = await enrolment.enrol(claims());

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("fetch failed");
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * A role this build cannot name (a hand-edited row, or one added to the check
   * constraint ahead of the code) resolves to the least privileged role — the
   * same rule the read path applies, so registration and the next request agree
   * about who somebody is.
   */
  it("degrades an unrecognised role to citizen instead of trusting it", async () => {
    const { enrolment } = service({
      profiles: [{ id: SUB, email: "new@example.org", role: "superuser" }],
    });

    expect(await enrolment.enrol(claims())).toMatchObject({
      ok: true,
      value: { role: "citizen" },
    });
  });

  /**
   * The idempotency guarantee, and the one worth breaking a build over: a
   * second registration of an already-enrolled identity returns the profile
   * that exists. `on conflict (id) do nothing` plus a read-back. If that insert
   * ever becomes `do update`, a district officer who clicks register again is
   * silently demoted to citizen.
   */
  it("returns the existing role on a second enrolment rather than resetting it", async () => {
    const { fake, enrolment } = service({
      profiles: [{ id: SUB, email: "officer@darbhanga.gov.in", role: "district_officer" }],
    });

    const first = await enrolment.enrol(claims());
    const second = await enrolment.enrol(claims());

    expect(first).toMatchObject({
      ok: true,
      value: { id: SUB, email: "officer@darbhanga.gov.in", role: "district_officer" },
    });
    expect(second).toEqual(first);
    expect(fake.profiles.get(SUB)).toEqual({
      id: SUB,
      email: "officer@darbhanga.gov.in",
      role: "district_officer",
    });
  });
});
