import { describe, expect, it } from "vitest";
import { SequentialIdGenerator, type DomainEvent, type EventActor } from "@afrip/shared-kernel";
import { isPublicPath, type ActorContext, type AuthGate } from "../src/auth.js";
import { createMemoryRuntime, type PlatformRuntime } from "../src/persistence.js";
import { jsonBody, record, startTestServerWith, testConfig, VILLAGE_BODY } from "./helpers.js";

/**
 * The guard ADR 0010 asks for.
 *
 * Stamping the actor happens in exactly one place, which is what makes the
 * change cheap — and also makes it a single point of failure. If the decorator
 * is dropped from a composition path, nothing breaks, nothing 500s, and no other
 * test fails: events simply start arriving with no idea who caused them, and the
 * audit trail ADR 0011 builds on quietly stops being an audit trail. This file
 * is the only thing standing between that edit and a green build.
 *
 * It asserts on events reaching the LONG-LIVED bus rather than on a publisher
 * stub, because the bus is where the subscribers actually are: it is the same
 * path the recovery-index integration and the API's read models see, so a
 * composition that stamps a publisher nobody publishes through would not pass.
 *
 * MUTATION-CHECKED. Deleting the `ActorStampingPublisher` from `composeForActor`
 * (i.e. `eventPublisher: () => base.bus`) fails "every event ... carries an
 * actor" and "attributes an event to the signed-in user" — verified, not assumed.
 */

const OFFICER: ActorContext = {
  id: "user-7f3c",
  email: "officer@example.gov.in",
  role: "district_officer",
};

/**
 * A gate that resolves every non-public path to `actor`, or refuses to identify
 * anyone when `actor` is null. Stands in for real JWT verification, which
 * auth-jwt.test.ts already covers — what is under test here is what happens to
 * an identity AFTER the gate has established it.
 */
function gateFor(actor: ActorContext | null, mode: AuthGate["mode"]): AuthGate {
  return {
    jwtEnabled: mode === "supabase-jwt",
    legacyTokenEnabled: mode === "bearer",
    mode,
    authorize: async (path) => ({ authorized: true, actor: isPublicPath(path) ? null : actor }),
  };
}

/**
 * Records everything that reaches the long-lived bus, in order, without changing
 * what the bus does with it.
 */
function watchBus(runtime: PlatformRuntime): DomainEvent[] {
  const seen: DomainEvent[] = [];
  const bus = runtime.platform.bus;
  const publish = bus.publish.bind(bus);
  bus.publish = async (events: DomainEvent[]): Promise<void> => {
    seen.push(...events);
    return publish(events);
  };
  return seen;
}

function memoryRuntime(): PlatformRuntime {
  return createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) });
}

/**
 * A deliberately broad sweep of write routes: nine bounded contexts, several of
 * them raising more than one event, plus a damage assessment whose cross-context
 * reaction publishes an event of its own. A guard against a MISSING composition
 * path has to touch enough paths to notice one going missing.
 */
async function exerciseWrites(server: Awaited<ReturnType<typeof startTestServerWith>>): Promise<void> {
  /**
   * Every write in the sweep is asserted to have SUCCEEDED. Without this, a
   * body that drifts out of step with a route's validation turns into a silent
   * 400 that publishes nothing — and a guard whose coverage quietly shrinks
   * while it keeps passing is the failure mode this file exists to prevent.
   */
  const write = async (path: string, init: Parameters<typeof server.request>[1]) => {
    const response = await server.request(path, init);
    expect([200, 201]).toContain(response.status);
    return record(response.body);
  };

  const village = await write("/villages", jsonBody(VILLAGE_BODY));
  const villageId = String(village["villageId"]);

  await write(
    `/villages/${villageId}/damage-assessments`,
    jsonBody({
      housesDamaged: 45,
      schoolsDamaged: 1,
      healthCentresDamaged: 1,
      waterSourcesDamaged: 3,
      agricultureHectaresLost: 120,
      livestockLost: 60,
    }),
  );
  await write(`/villages/${villageId}/severity`, {
    ...jsonBody({ severity: "moderate" }),
    method: "PATCH",
  });

  const ngo = await write(
    "/ngos",
    jsonBody({ name: "Relief Works", focusAreas: ["water"], capacity: 3 }),
  );
  await write(`/villages/${villageId}/assignment`, jsonBody({ ngoId: String(ngo["ngoId"]) }));

  const beneficiary = await write(
    "/beneficiaries",
    jsonBody({ villageId, name: "Sunita Devi", category: "widow" }),
  );
  await write(
    `/beneficiaries/${String(beneficiary["beneficiaryId"])}/aid`,
    jsonBody({ aidType: "food", providerId: "provider-1", providerType: "ngo" }),
  );

  const issue = await write(
    "/issues",
    jsonBody({
      villageId,
      category: "infrastructure",
      description: "Bridge approach road washed out",
      photoRefs: [],
      gps: { lat: 26.15, lng: 85.9 },
    }),
  );
  await write(`/issues/${String(issue["issueId"])}/route`, { method: "POST" });

  await write(
    "/projects",
    jsonBody({
      villageId,
      name: "Culvert rebuild",
      category: "bridge",
      fundSource: "district",
      sanctionedInr: 5000,
    }),
  );

  await write(
    "/volunteers",
    jsonBody({
      name: "Ravi Kumar",
      skills: ["logistics"],
      languages: ["hindi"],
      location: "Darbhanga",
    }),
  );

  await write(`/villages/${villageId}/plan`, { method: "POST" });

  await write(
    "/signals",
    jsonBody({
      rawText: "Rampur needs drinking water urgently",
      source: "whatsapp_field_report",
    }),
  );
}

describe("request-scoped composition attributes every event (ADR 0010)", () => {
  it("stamps every event published through a request-scoped platform with an actor", async () => {
    const runtime = memoryRuntime();
    const seen = watchBus(runtime);
    const server = await startTestServerWith({
      config: testConfig(),
      runtime,
      auth: gateFor(OFFICER, "supabase-jwt"),
    });

    try {
      await exerciseWrites(server);
    } finally {
      await server.close();
    }

    // The sweep has to have actually published something, or "every event
    // carries an actor" would be vacuously true over an empty list. 14 is what
    // the sweep raises today — one or more from each of the nine contexts, plus
    // the cross-context recalculation. A lower bound, so adding events is free
    // and losing coverage is not.
    expect(seen.length).toBeGreaterThanOrEqual(14);

    const unattributed = seen.filter((event) => event.actor === undefined).map((event) => event.name);
    expect(unattributed).toEqual([]);
  });

  it("attributes an event to the signed-in user, with the role they held", async () => {
    const runtime = memoryRuntime();
    const seen = watchBus(runtime);
    const server = await startTestServerWith({
      config: testConfig(),
      runtime,
      auth: gateFor(OFFICER, "supabase-jwt"),
    });

    try {
      await server.request("/villages", jsonBody(VILLAGE_BODY));
    } finally {
      await server.close();
    }

    const registered = seen.find((event) => event.name === "village.registered.v1");
    expect(registered?.actor).toEqual({
      kind: "user",
      id: OFFICER.id,
      email: OFFICER.email,
      role: OFFICER.role,
    } satisfies EventActor);
    expect(typeof registered?.requestId).toBe("string");
  });

  it("correlates the events of one request and separates them from the next", async () => {
    const runtime = memoryRuntime();
    const seen = watchBus(runtime);
    const server = await startTestServerWith({
      config: testConfig(),
      runtime,
      auth: gateFor(OFFICER, "supabase-jwt"),
    });

    try {
      const first = record((await server.request("/villages", jsonBody(VILLAGE_BODY))).body);
      await server.request(
        `/villages/${String(first["villageId"])}/severity`,
        { ...jsonBody({ severity: "moderate" }), method: "PATCH" },
      );
    } finally {
      await server.close();
    }

    const requestIds = seen
      .filter((event) => event.actor?.kind === "user")
      .map((event) => event.requestId);
    expect(requestIds.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(requestIds).size).toBe(2);
  });

  /**
   * The honest half of ADR 0010's "system must be representable": a
   * recovery-index recalculation is the platform reacting to an event on the
   * bus, not the officer recalculating anything. It is recorded as `system`
   * rather than borrowed from whoever happened to trigger it.
   */
  it("records a cross-context reaction as system-originated, not as the user who triggered it", async () => {
    const runtime = memoryRuntime();
    const seen = watchBus(runtime);
    const server = await startTestServerWith({
      config: testConfig(),
      runtime,
      auth: gateFor(OFFICER, "supabase-jwt"),
    });

    try {
      const village = record((await server.request("/villages", jsonBody(VILLAGE_BODY))).body);
      await server.request(
        `/villages/${String(village["villageId"])}/damage-assessments`,
        jsonBody({
          housesDamaged: 45,
          schoolsDamaged: 1,
          healthCentresDamaged: 1,
          waterSourcesDamaged: 3,
          agricultureHectaresLost: 120,
          livestockLost: 60,
        }),
      );
    } finally {
      await server.close();
    }

    // The officer's own action is theirs.
    expect(seen.find((event) => event.name === "village.damage-assessed.v1")?.actor).toMatchObject({
      kind: "user",
      id: OFFICER.id,
    });
    // The recalculation the bus subscriber performed is the platform's.
    const recalculated = seen.find((event) => event.name === "recovery.score-calculated.v1");
    expect(recalculated).toBeDefined();
    expect(recalculated?.actor).toEqual({ kind: "system", name: "platform" } satisfies EventActor);
  });

  /**
   * The case that would be most tempting to paper over. A deployment with no
   * credential configured still writes, and those writes must not be recorded
   * under a person's name — nor under `system`, which would claim no human was
   * involved.
   */
  it("records an unidentified request as anonymous rather than inventing a user", async () => {
    const runtime = memoryRuntime();
    const seen = watchBus(runtime);
    const server = await startTestServerWith({
      config: testConfig(),
      runtime,
      auth: gateFor(null, "disabled"),
    });

    try {
      await server.request("/villages", jsonBody(VILLAGE_BODY));
    } finally {
      await server.close();
    }

    expect(seen.find((event) => event.name === "village.registered.v1")?.actor).toEqual({
      kind: "anonymous",
      via: "unauthenticated",
    } satisfies EventActor);
  });

  it("records a shared-token request as anonymous via the legacy token", async () => {
    const runtime = memoryRuntime();
    const seen = watchBus(runtime);
    const server = await startTestServerWith({
      config: testConfig({ apiToken: "shared-secret" }),
      runtime,
      auth: gateFor(null, "bearer"),
    });

    try {
      await server.request("/villages", { ...jsonBody(VILLAGE_BODY), token: "shared-secret" });
    } finally {
      await server.close();
    }

    expect(seen.find((event) => event.name === "village.registered.v1")?.actor).toEqual({
      kind: "anonymous",
      via: "legacy-token",
    } satisfies EventActor);
  });

  /**
   * The performance-relevant invariant of ADR 0010, asserted rather than
   * commented. Per-request composition is only affordable while it is pure
   * wiring: if a repository (or a client, or a key set) is ever constructed
   * inside `createPlatform` instead of injected in, each request gets its own —
   * and this fails, on the second request, because the first request's data is
   * gone.
   */
  it("re-composes over the SAME repositories, not fresh ones per request", async () => {
    const runtime = memoryRuntime();
    const server = await startTestServerWith({
      config: testConfig(),
      runtime,
      auth: gateFor(OFFICER, "supabase-jwt"),
    });

    try {
      const created = record((await server.request("/villages", jsonBody(VILLAGE_BODY))).body);
      const villageId = String(created["villageId"]);

      const readBack = await server.request(`/villages/${villageId}`);
      expect(readBack.status).toBe(200);

      // Ids keep counting up across requests too: the id generators are shared
      // through `PlatformComposition`, not re-seeded per composition.
      const second = record((await server.request("/villages", jsonBody(VILLAGE_BODY))).body);
      expect(second["villageId"]).not.toBe(villageId);
    } finally {
      await server.close();
    }
  });
});
