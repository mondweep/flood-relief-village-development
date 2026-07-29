import { describe, expect, it, vi, type Mock } from "vitest";
import {
  FORBIDDEN_PREFIX,
  isForbiddenError,
  ok,
  type AuthenticatedActor,
  type OwnershipRegistry,
  type UserRole,
} from "@afrip/shared-kernel";
import {
  authorizePlatform,
  createPlatform,
  ForbiddenError,
  isForbiddenThrown,
  PLATFORM_PERMISSIONS,
  type Platform,
} from "@afrip/platform";

/**
 * London-school tests: the platform under test is a stand-in built from the
 * policy table itself, every collaborator is a `vi.fn()`, and the assertions are
 * about which conversations happened — did the inner use case get called, was
 * the ownership registry consulted, and with exactly what query.
 *
 * No real repository appears anywhere in this file. The thing being tested is a
 * gate, and a gate is tested by watching what gets through it.
 */

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const actor = (role: UserRole, id = `${role}-1`): AuthenticatedActor => ({
  id,
  email: `${id}@example.test`,
  role,
});

/** A registry that owns nothing and records every question asked of it. */
function ownershipDouble(owned: readonly { recordId: string; ownerId: string }[] = []): OwnershipRegistry & {
  isOwner: Mock;
  record: Mock;
} {
  return {
    record: vi.fn(async () => undefined),
    isOwner: vi.fn(async (query: { recordId: string; ownerId: string }) =>
      owned.some((entry) => entry.recordId === query.recordId && entry.ownerId === query.ownerId),
    ),
  } as OwnershipRegistry & { isOwner: Mock; record: Mock };
}

const NEVER_OWNS = () => ownershipDouble();

/**
 * A fake `Platform` generated FROM the policy table, so every rule is exercised
 * by the sweeps below rather than the handful someone remembered to list.
 *
 * Members whose name ends in `Repository` are modelled as read ports (an object
 * of async methods, no `execute`); `signalExtractor` as the introspected object
 * it is; everything else as a use case.
 */
interface FakePlatform {
  platform: Platform;
  /** The inner `execute` / read-port mocks, by `"context.member"`. */
  inner: Map<string, Mock>;
  /** The untouched object identity handed in for `signalExtractor`. */
  extractorSentinel: object;
}

function fakePlatform(): FakePlatform {
  const inner = new Map<string, Mock>();
  const extractorSentinel = { extract: vi.fn() };
  const platform: Record<string, Record<string, unknown>> = {};

  for (const key of Object.keys(PLATFORM_PERMISSIONS)) {
    const dot = key.indexOf(".");
    const contextKey = key.slice(0, dot);
    const memberName = key.slice(dot + 1);
    platform[contextKey] ??= {};

    if (memberName === "signalExtractor") {
      platform[contextKey]![memberName] = extractorSentinel;
      continue;
    }
    const mock = vi.fn(async (..._args: unknown[]) => ok(`${key} ran`));
    inner.set(key, mock);
    platform[contextKey]![memberName] = memberName.endsWith("Repository")
      ? { listAll: mock, findById: mock }
      : { execute: mock };
  }

  return { platform: platform as unknown as Platform, inner, extractorSentinel };
}

const isReadPort = (key: string): boolean => key.endsWith("Repository");

/** Invokes a wrapped member the way a route would. */
async function call(platform: Platform, key: string, input?: unknown): Promise<unknown> {
  const dot = key.indexOf(".");
  const context = (platform as unknown as Record<string, Record<string, unknown>>)[key.slice(0, dot)]!;
  const member = context[key.slice(dot + 1)] as Record<string, (arg?: unknown) => Promise<unknown>>;
  return isReadPort(key) ? member["listAll"]!(input) : member["execute"]!(input);
}

/** Every gated key — i.e. everything except the introspection-only extractor. */
const GATED_KEYS = Object.keys(PLATFORM_PERMISSIONS).filter(
  (key) => PLATFORM_PERMISSIONS[key]!.introspectionOnly !== true,
);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("authorizePlatform shape", () => {
  it("returns a platform with the same contexts and members as the one it wrapped", () => {
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(platform).sort());
    for (const [contextKey, contextValue] of Object.entries(platform)) {
      if (["bus", "eventPublisher", "composition"].includes(contextKey)) continue;
      const wrappedContext = (wrapped as unknown as Record<string, object>)[contextKey]!;
      expect(Object.keys(wrappedContext).sort(), contextKey).toEqual(
        Object.keys(contextValue as object).sort(),
      );
    }
  });

  it("passes bus and eventPublisher through by identity", () => {
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    expect(wrapped.bus).toBe(platform.bus);
    expect(wrapped.eventPublisher).toBe(platform.eventPublisher);
  });

  /**
   * The gap beside the gate. `composition.repositories.beneficiary` is the raw
   * adapter — reachable one property away from a platform wrapped specifically to
   * keep this actor out of the beneficiary register, and answering with every
   * name in it. An authorized platform therefore refuses to hand `composition`
   * over at all.
   *
   * A plain Error, not a refusal: a route reaching for it is our bug, not a user
   * without a role, and it should surface as a 500 an operator investigates
   * rather than a 403 that blames the caller.
   */
  it("refuses to expose composition, which would reach the repositories ungated", () => {
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    expect(() => wrapped.composition).toThrow(/not reachable on an authorized platform/);
    // Still enumerable, so the shape check above and any structural clone see it.
    expect(Object.keys(wrapped)).toContain("composition");
    // And the unwrapped platform is untouched — composeForActor depends on it.
    expect(platform.composition.repositories.beneficiary).toBeDefined();
  });

  it("passes the introspection-only signalExtractor through by identity", () => {
    // `GET /health` reads it for its identity; no route invokes it through the
    // platform, so there is no call to gate.
    const { platform, extractorSentinel } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });
    expect(wrapped.socialMediaIntelligence.signalExtractor).toBe(extractorSentinel);
  });
});

// ---------------------------------------------------------------------------
// The null actor
// ---------------------------------------------------------------------------

describe("a null actor", () => {
  it("is allowed everything", async () => {
    // ADR 0008's AuthGate has already run. Failing closed here would break every
    // deployment on the transitional shared API_TOKEN and every existing test.
    const { platform, inner } = fakePlatform();
    const ownership = NEVER_OWNS();
    const wrapped = authorizePlatform(platform, null, { ownership });

    for (const key of GATED_KEYS) {
      await expect(call(wrapped, key, { villageId: "v", issueId: "i", volunteerId: "vo", planId: "p" })).resolves
        .toEqual(ok(`${key} ran`));
      expect(inner.get(key), key).toHaveBeenCalledTimes(1);
    }
    expect(ownership.isOwner).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

describe("an admin", () => {
  it("passes every gated member without the table being consulted for them", async () => {
    const { platform, inner } = fakePlatform();
    const ownership = NEVER_OWNS();
    const wrapped = authorizePlatform(platform, actor("admin"), { ownership });

    for (const key of GATED_KEYS) {
      await expect(call(wrapped, key, {}), key).resolves.toEqual(ok(`${key} ran`));
      expect(inner.get(key), key).toHaveBeenCalledTimes(1);
    }
    expect(ownership.isOwner).not.toHaveBeenCalled();
  });

  it("passes even a member with no rule at all", async () => {
    const inner = vi.fn(async () => ok("ran"));
    const platform = { villageRegistry: { brandNewUseCase: { execute: inner } } } as unknown as Platform;
    const wrapped = authorizePlatform(platform, actor("admin"), { ownership: NEVER_OWNS(), policy: {} });

    await expect(call(wrapped, "villageRegistry.brandNewUseCase")).resolves.toEqual(ok("ran"));
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Deny by default
// ---------------------------------------------------------------------------

describe("a member with no rule", () => {
  it("is denied to a non-admin", async () => {
    const inner = vi.fn(async () => ok("ran"));
    const platform = { villageRegistry: { ungatedUseCase: { execute: inner } } } as unknown as Platform;
    const wrapped = authorizePlatform(platform, actor("district_officer"), {
      ownership: NEVER_OWNS(),
      policy: {},
    });

    const result = (await call(wrapped, "villageRegistry.ungatedUseCase")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(isForbiddenError(result.error)).toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it("warns once, not once per call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const unique = `villageRegistry.unknownMember${Date.now()}`;
      const platform = {
        villageRegistry: { [unique.slice(unique.indexOf(".") + 1)]: { execute: vi.fn(async () => ok("x")) } },
      } as unknown as Platform;
      const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS(), policy: {} });

      await call(wrapped, unique);
      await call(wrapped, unique);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes(unique))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The beneficiary registry — the hole ADR 0009 closes
// ---------------------------------------------------------------------------

describe("the beneficiary registry", () => {
  const beneficiaryKeys = Object.keys(PLATFORM_PERMISSIONS).filter((key) => key.startsWith("beneficiaryRegistry."));

  for (const role of ["citizen", "village_committee"] as const) {
    it(`refuses all five members to a ${role}`, async () => {
      const { platform, inner } = fakePlatform();
      const ownership = NEVER_OWNS();
      const wrapped = authorizePlatform(platform, actor(role), { ownership });

      expect(beneficiaryKeys).toHaveLength(5);
      for (const key of beneficiaryKeys) {
        const result = (await call(wrapped, key, { beneficiaryId: "b-1" })) as { ok: boolean; error: string };
        expect(result.ok, key).toBe(false);
        expect(result.error, key).toContain(FORBIDDEN_PREFIX);
        expect(isForbiddenError(result.error), key).toBe(true);
        expect(result.error, key).toContain(role);
        // The gate, not a filter: the use case never ran, so nothing was read,
        // written, or published.
        expect(inner.get(key), key).not.toHaveBeenCalled();
      }
      // No ownership widening on this context, so no round trip either.
      expect(ownership.isOwner).not.toHaveBeenCalled();
    });
  }

  it("admits a district_officer and an ngo_coordinator", async () => {
    for (const role of ["district_officer", "ngo_coordinator"] as const) {
      const { platform, inner } = fakePlatform();
      const wrapped = authorizePlatform(platform, actor(role), { ownership: NEVER_OWNS() });
      for (const key of beneficiaryKeys) {
        await expect(call(wrapped, key, {}), `${role} ${key}`).resolves.toEqual(ok(`${key} ran`));
        expect(inner.get(key), key).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("stays shut even for a citizen who owns a record of every ownable type", async () => {
    // The registry has no `ownable` rule, so a citizen holding ownership of some
    // other record cannot lever it into beneficiary access.
    const { platform } = fakePlatform();
    const ownership = ownershipDouble([{ recordId: "b-1", ownerId: "citizen-1" }]);
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership });

    for (const key of beneficiaryKeys) {
      const result = (await call(wrapped, key, { beneficiaryId: "b-1" })) as { ok: boolean };
      expect(result.ok, key).toBe(false);
    }
    expect(ownership.isOwner).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe("ownership widens rights", () => {
  it("lets a citizen start progress on an issue they own", async () => {
    const { platform, inner } = fakePlatform();
    const ownership = ownershipDouble([{ recordId: "i-1", ownerId: "citizen-7" }]);
    const wrapped = authorizePlatform(platform, actor("citizen", "citizen-7"), { ownership });

    await expect(call(wrapped, "issueTracking.startProgress", { issueId: "i-1" })).resolves.toEqual(
      ok("issueTracking.startProgress ran"),
    );
    expect(inner.get("issueTracking.startProgress")).toHaveBeenCalledTimes(1);
    expect(ownership.isOwner).toHaveBeenCalledTimes(1);
    expect(ownership.isOwner).toHaveBeenCalledWith({
      recordType: "issue",
      recordId: "i-1",
      ownerId: "citizen-7",
    });
  });

  it("refuses the same citizen on an issue they do not own", async () => {
    const { platform, inner } = fakePlatform();
    const ownership = ownershipDouble([{ recordId: "i-1", ownerId: "citizen-7" }]);
    const wrapped = authorizePlatform(platform, actor("citizen", "citizen-7"), { ownership });

    const result = (await call(wrapped, "issueTracking.startProgress", { issueId: "i-2" })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(isForbiddenError(result.error)).toBe(true);
    expect(result.error).toContain("start work on issues");
    expect(inner.get("issueTracking.startProgress")).not.toHaveBeenCalled();
    expect(ownership.isOwner).toHaveBeenCalledWith({
      recordType: "issue",
      recordId: "i-2",
      ownerId: "citizen-7",
    });
  });

  it("refuses when the input carries no id to check ownership against", async () => {
    const { platform, inner } = fakePlatform();
    const ownership = ownershipDouble([{ recordId: "i-1", ownerId: "citizen-7" }]);
    const wrapped = authorizePlatform(platform, actor("citizen", "citizen-7"), { ownership });

    const result = (await call(wrapped, "issueTracking.startProgress", {})) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(ownership.isOwner).not.toHaveBeenCalled();
    expect(inner.get("issueTracking.startProgress")).not.toHaveBeenCalled();
  });

  it("does not widen verifyResolution — the reporter must not verify their own fix", async () => {
    const { platform, inner } = fakePlatform();
    const ownership = ownershipDouble([{ recordId: "i-1", ownerId: "citizen-7" }]);
    const wrapped = authorizePlatform(platform, actor("citizen", "citizen-7"), { ownership });

    const result = (await call(wrapped, "issueTracking.verifyResolution", { issueId: "i-1" })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(inner.get("issueTracking.verifyResolution")).not.toHaveBeenCalled();
    expect(ownership.isOwner).not.toHaveBeenCalled();
  });
});

describe("ownership never narrows rights", () => {
  it("lets a district_officer correct a village profile they did not create", async () => {
    const { platform, inner } = fakePlatform();
    const ownership = NEVER_OWNS();
    const wrapped = authorizePlatform(platform, actor("district_officer"), { ownership });

    await expect(
      call(wrapped, "villageRegistry.correctVillageProfile", { villageId: "v-9", reason: "census update" }),
    ).resolves.toEqual(ok("villageRegistry.correctVillageProfile ran"));
    expect(inner.get("villageRegistry.correctVillageProfile")).toHaveBeenCalledTimes(1);
    // Short-circuit: the role grant already answered the question, so no DB
    // round trip is spent re-answering it on every privileged edit.
    expect(ownership.isOwner).not.toHaveBeenCalled();
  });

  it("never consults the registry for any ownable member a role already holds", async () => {
    const ownableKeys = Object.entries(PLATFORM_PERMISSIONS)
      .filter(([, rule]) => rule.ownable !== undefined)
      .map(([key]) => key);
    const { platform } = fakePlatform();
    const ownership = NEVER_OWNS();
    const wrapped = authorizePlatform(platform, actor("district_officer"), { ownership });

    for (const key of ownableKeys) {
      await call(wrapped, key, { villageId: "v", issueId: "i", volunteerId: "vo", planId: "p" });
    }
    expect(ownership.isOwner).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Read ports
// ---------------------------------------------------------------------------

describe("read ports", () => {
  it("reject with ForbiddenError when denied", async () => {
    // They return raw values, not `Result`, so there is nowhere to put an `err`.
    const { platform, inner } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    await expect(call(wrapped, "volunteerManagement.volunteerRepository")).rejects.toThrow(ForbiddenError);
    expect(inner.get("volunteerManagement.volunteerRepository")).not.toHaveBeenCalled();

    await expect(call(wrapped, "socialMediaIntelligence.signalRepository")).rejects.toThrow(ForbiddenError);
    await expect(call(wrapped, "socialMediaIntelligence.alertRepository")).rejects.toThrow(ForbiddenError);
  });

  it("throw an error the API can recognise structurally and by prefix", async () => {
    const { platform } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    const thrown = await call(wrapped, "volunteerManagement.volunteerRepository").catch((e: unknown) => e);
    expect(isForbiddenThrown(thrown)).toBe(true);
    expect((thrown as Error).message).toContain(FORBIDDEN_PREFIX);
    expect(isForbiddenError((thrown as Error).message)).toBe(true);
  });

  it("pass the return value and every argument through when allowed", async () => {
    const { platform, inner } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    // Public-money transparency: the project register is readable by everyone.
    const repo = wrapped.fundMonitoring.projectRepository as unknown as {
      listByVillage: (id: string, extra?: string) => Promise<unknown>;
      listAll: () => Promise<unknown>;
    };
    await expect(repo.listAll()).resolves.toEqual(ok("fundMonitoring.projectRepository ran"));
    expect(inner.get("fundMonitoring.projectRepository")).toHaveBeenCalledWith();
  });

  it("forward multiple arguments to the underlying port", async () => {
    const listAll = vi.fn(async (a: unknown, b: unknown) => [a, b]);
    const platform = {
      fundMonitoring: { projectRepository: { listAll } },
    } as unknown as Platform;
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    const repo = wrapped.fundMonitoring.projectRepository as unknown as {
      listAll: (a: unknown, b: unknown) => Promise<unknown>;
    };
    await expect(repo.listAll("one", 2)).resolves.toEqual(["one", 2]);
    expect(listAll).toHaveBeenCalledWith("one", 2);
  });

  it("preserve `this` so a real class-based adapter still works", async () => {
    // The in-memory adapters keep state in private fields; a wrapper that lost
    // `this` would throw on the first read rather than deny it.
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });
    await expect(wrapped.fundMonitoring.projectRepository.listAll()).resolves.toEqual([]);
  });

  it("let citizens read the project register but not the volunteer roster", async () => {
    const { platform } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    await expect(call(wrapped, "fundMonitoring.projectRepository")).resolves.toEqual(
      ok("fundMonitoring.projectRepository ran"),
    );
    await expect(call(wrapped, "volunteerManagement.volunteerRepository")).rejects.toThrow(ForbiddenError);
  });

  it("gate every method on a port, not just the one a route happens to call", async () => {
    const { platform } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });
    const repo = wrapped.volunteerManagement.volunteerRepository as unknown as {
      findById: (id: string) => Promise<unknown>;
    };
    await expect(repo.findById("vol-1")).rejects.toThrow(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Use-case wrapping
// ---------------------------------------------------------------------------

describe("use cases", () => {
  it("refuse as a Result failure rather than a throw", async () => {
    // Every route already maps `Result` onto HTTP; a throw would need new
    // plumbing in nine route files to avoid becoming a 500.
    const { platform } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    const result = (await call(wrapped, "fundMonitoring.sanctionProject", {})) as {
      ok: boolean;
      error: string;
    };
    expect(result).toEqual({ ok: false, error: `${FORBIDDEN_PREFIX} citizen may not sanction projects` });
  });

  it("forward every argument and the exact return value when allowed", async () => {
    const { platform, inner } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    const input = { villageId: "v-1", category: "water", description: "pump down" };
    await expect(call(wrapped, "issueTracking.reportIssue", input)).resolves.toEqual(
      ok("issueTracking.reportIssue ran"),
    );
    expect(inner.get("issueTracking.reportIssue")).toHaveBeenCalledWith(input);
  });

  it("keep non-execute properties of the wrapped use case reachable", async () => {
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("admin"), { ownership: NEVER_OWNS() });
    expect(wrapped.villageRegistry.registerVillage).toBeInstanceOf(
      platform.villageRegistry.registerVillage.constructor as new () => unknown,
    );
  });

  it("never reach the underlying use case on a denial", async () => {
    const { platform, inner } = fakePlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    const denied = GATED_KEYS.filter(
      (key) => !PLATFORM_PERMISSIONS[key]!.roles.includes("citizen") && !isReadPort(key),
    );
    expect(denied.length).toBeGreaterThan(0);
    for (const key of denied) {
      await call(wrapped, key, {});
      expect(inner.get(key), key).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Against the real composition root
// ---------------------------------------------------------------------------

describe("wrapping a real platform", () => {
  // Everything above uses doubles, which cannot catch a Proxy that breaks on a
  // class instance with private fields. These two do.
  const village = {
    name: "Majuli",
    district: "Majuli",
    state: "Assam",
    geo: { lat: 26.95, lng: 94.17 },
    population: 900,
    households: 200,
    affectedFamilies: 120,
    severity: "severe",
  } as const;

  it("runs a real use case through the wrapper when allowed", async () => {
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("district_officer"), { ownership: NEVER_OWNS() });

    const result = await wrapped.villageRegistry.registerVillage.execute(village);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    // Written through to the SAME repository the unwrapped platform holds.
    await expect(platform.composition.repositories.village.listAll()).resolves.toHaveLength(1);
  });

  it("leaves the real repository untouched when denied", async () => {
    const platform = createPlatform();
    const wrapped = authorizePlatform(platform, actor("citizen"), { ownership: NEVER_OWNS() });

    const result = await wrapped.villageRegistry.registerVillage.execute(village);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isForbiddenError(result.error)).toBe(true);
    await expect(platform.composition.repositories.village.listAll()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The whole matrix, role by role
// ---------------------------------------------------------------------------

describe("every role against every rule", () => {
  for (const role of ["district_officer", "ngo_coordinator", "village_committee", "citizen"] as const) {
    it(`lets a ${role} through exactly the members the table grants them`, async () => {
      const { platform, inner } = fakePlatform();
      const wrapped = authorizePlatform(platform, actor(role), { ownership: NEVER_OWNS() });

      for (const key of GATED_KEYS) {
        const granted = PLATFORM_PERMISSIONS[key]!.roles.includes(role);
        // No id in the input, so no ownership widening can rescue a denial.
        const outcome = await call(wrapped, key, {}).then(
          () => "allowed",
          () => "threw",
        );
        if (isReadPort(key)) {
          expect(outcome === "allowed", `${role} -> ${key}`).toBe(granted);
        } else {
          expect((inner.get(key)!.mock.calls.length > 0), `${role} -> ${key}`).toBe(granted);
        }
      }
    });
  }
});
