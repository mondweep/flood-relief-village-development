import {
  err,
  forbiddenMessage,
  type AuthenticatedActor,
  type OwnershipRegistry,
} from "@afrip/shared-kernel";
import type { Platform } from "../composition-root.js";
import { PLATFORM_PERMISSIONS, type PermissionRule } from "./permissions.js";

/**
 * Enforcement for ADR 0009: wraps a composed `Platform` so every use case and
 * read port checks the acting role before it runs.
 *
 * The wrapping happens HERE, in the composition root's package, rather than in
 * each context, because ADR 0009 puts authorization at the use-case boundary and
 * only this package can see all nine contexts at once. No aggregate gains a user
 * concept; no context's application layer imports a role.
 *
 * The wrapper is a gate, not a filter. A denied call never reaches the
 * underlying use case, so it cannot write, cannot publish an event, and cannot
 * leak a value that a response-shaping filter would then have to remove.
 */

// ---------------------------------------------------------------------------
// Read-port refusal
// ---------------------------------------------------------------------------

/**
 * Thrown by a denied READ PORT call.
 *
 * Use cases return `Result<T, string>` and a refusal is an `err` with
 * `FORBIDDEN_PREFIX` — an ordinary failure the existing route plumbing already
 * maps to a status code. Read ports (`projectRepository`, `volunteerRepository`,
 * …) return raw values, not `Result`, so there is nowhere to put an `err`;
 * a rejected promise is the only refusal channel they have. The API's dispatcher
 * maps this to 403.
 */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Structural guard, so the API can recognise a refusal across a package boundary
 * without `instanceof` — which fails the moment two copies of this module exist
 * (bundled vs. source, or a duplicated node_modules entry) and would silently
 * downgrade a 403 to a 500.
 */
export function isForbiddenThrown(value: unknown): value is ForbiddenError {
  return value instanceof Error && value.name === "ForbiddenError";
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface AuthorizePlatformDeps {
  readonly ownership: OwnershipRegistry;
  /** Defaults to `PLATFORM_PERMISSIONS`; injectable so tests can drive one rule. */
  readonly policy?: Record<string, PermissionRule>;
}

/**
 * A request that proved WHO it is but is not a user of this application.
 *
 * It exists because of one route: enrolment. Someone holding a valid token for
 * this Supabase project — which is shared with four unrelated applications — has
 * to be able to reach `POST /me/enrolment` while having no AFRIP profile at all.
 * Every other route refuses them at the gate with `user_unknown`.
 *
 * WHY THIS IS NOT `null`. A null actor means "no identity was presented", and
 * `decide` ALLOWS it, because the legacy shared token and the open dev server
 * both arrive that way and are gated before they ever reach a use case. An
 * unenrolled holder of a real token is the opposite case: nothing else gates
 * them, so passing null would hand a stranger an unrestricted platform. This
 * value denies everything, including for `admin`, because an unenrolled request
 * has no role to be admin with.
 *
 * The enrolment route touches no use case, so today nothing depends on this.
 * That is exactly why it is here: the hazard is the NEXT route added to the
 * identified-only set, which would otherwise inherit unrestricted access in
 * silence.
 */
export const UNENROLLED = "unenrolled";

export type PlatformActor = AuthenticatedActor | null | typeof UNENROLLED;

/** Keys on `Platform` that are infrastructure, not a bounded context. */
const PASSTHROUGH_KEYS = new Set(["bus", "eventPublisher"]);

/**
 * `composition` is NOT passed through, and this is the sharpest edge in the file.
 *
 * It holds the raw repository adapters. `platform.composition.repositories
 * .beneficiary.listAll()` reads the entire beneficiary register — every name, on
 * a platform that was just wrapped to keep citizens out of exactly that. Gating
 * the context members while leaving the adapters they sit on reachable one
 * property away is not defence in depth, it is a gate with a gap beside it.
 *
 * So an AUTHORIZED platform refuses to hand it over. The long-lived platform
 * still exposes it normally, which is what ADR 0010's `composeForActor` uses —
 * that call takes the base platform, never a wrapped one, so per-request
 * composition is unaffected.
 *
 * A plain `Error`, deliberately not a `ForbiddenError`: a route reaching for
 * `ctx.platform.composition` is a bug in our code, not a user who lacks a role.
 * It deserves a 500 and a log line an operator will see, not a 403 that reads as
 * though the caller did something wrong.
 */
function defineRefusedComposition(target: Record<string, unknown>): void {
  Object.defineProperty(target, "composition", {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new Error(
        "Platform.composition is not reachable on an authorized platform: it exposes the raw " +
          "repository adapters, which bypasses every permission check in ADR 0009. Use the " +
          "context members (platform.beneficiaryRegistry.…), or the base platform if you are " +
          "composing (see composeForActor).",
      );
    },
  });
}

/** So an unknown member warns once per process, not once per request. */
const warnedUnknownKeys = new Set<string>();

/**
 * Answers "may this actor invoke `key`?" in the order ADR 0009 states.
 *
 * Returns null to allow, or the refusal message to deny.
 */
async function decide(
  key: string,
  rule: PermissionRule | undefined,
  actor: PlatformActor,
  ownership: OwnershipRegistry,
  input: unknown,
): Promise<string | null> {
  // 0. Identified, but not a user of this application -> deny everything.
  //    Checked FIRST, ahead of both the null allowance and the admin grant: this
  //    request has no AFRIP role at all, so there is no role for either rule to
  //    reason about. See the note on UNENROLLED.
  if (actor === UNENROLLED) return forbiddenMessage(`invoke ${key}`, "an unenrolled account");

  // 1. No actor -> allow.
  //
  // This is load-bearing and it is a deliberate hole, so it is stated plainly.
  // A null actor means the request carried no identity: a public path, the
  // transitional shared `API_TOKEN`, or a dev server with no credential
  // configured. All three are already gated by ADR 0008's `AuthGate` BEFORE a
  // request reaches a use case, so failing closed here would add nothing except
  // breaking every deployment still on the legacy token — and all ~1000 existing
  // tests, which construct platforms with no actor at all.
  //
  // The honest consequence: on a deployment running with `API_TOKEN` this whole
  // layer adds NOTHING. Every caller arrives as null and every check passes.
  // It bites only on the JWT path, where a real `AuthenticatedActor` with a real
  // role is available. Anyone reading this and expecting the beneficiary
  // registry to be protected today should first check which credential the
  // deployment is using.
  if (actor === null) return null;

  // 2. admin -> allow, everywhere, without consulting the table. Listing
  //    "admin" in all 48 rules would be 48 chances to forget it.
  if (actor.role === "admin") return null;

  // 6. No rule -> deny (deny by default). A member added to `Platform` without a
  //    policy entry is ungated by omission, which is precisely the failure this
  //    layer exists to prevent; `permissions.test.ts` catches it at build time,
  //    and this catches it at runtime if that test was skipped.
  if (rule === undefined) {
    if (!warnedUnknownKeys.has(key)) {
      warnedUnknownKeys.add(key);
      console.warn(`[authorization] no permission rule for "${key}"; denying non-admin callers`);
    }
    return forbiddenMessage(`invoke ${key}`, actor.role);
  }

  // 3. Role grant.
  if (rule.roles.includes(actor.role)) return null;

  // 4. Ownership WIDENS the role grant, never narrows it — so this runs only
  //    after the role check has already failed. A district officer editing a
  //    village they did not create never touches the ownership registry, which
  //    keeps a DB round trip off every privileged edit.
  if (rule.ownable !== undefined) {
    const recordId = rule.ownable.recordIdFrom(input);
    if (recordId !== null) {
      const owns = await ownership.isOwner({
        recordType: rule.ownable.recordType,
        recordId,
        ownerId: actor.id,
      });
      if (owns) return null;
    }
  }

  // 5. Deny.
  return forbiddenMessage(rule.operation, actor.role);
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

type Guard = (input: unknown) => Promise<string | null>;

interface UseCaseLike {
  execute(...args: unknown[]): unknown;
}

function hasExecute(value: unknown): value is UseCaseLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

/**
 * Wraps a use case so a denied `execute` resolves `err(<refusal>)`.
 *
 * A `Proxy` rather than a hand-built `{ execute }` object: it forwards every
 * other property untouched and keeps `instanceof` working, so the wrapped
 * platform is structurally the platform it wrapped. `this` inside the real
 * `execute` stays bound to the real use case, so private fields still resolve.
 *
 * The refusal is a `Result` failure, not a throw, because every route in the API
 * already maps `Result` onto HTTP. A throw would need new plumbing in nine
 * route files to avoid becoming a 500.
 */
function wrapUseCase<T extends UseCaseLike>(useCase: T, guard: Guard): T {
  return new Proxy(useCase, {
    get(target, property, receiver) {
      if (property === "execute") {
        return async (...args: unknown[]): Promise<unknown> => {
          const refusal = await guard(args[0]);
          if (refusal !== null) return err(refusal);
          return (target as UseCaseLike).execute(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wraps a read port so every function-valued method rejects when denied.
 *
 * A `Proxy` is not a convenience here, it is the only correct option: these
 * ports are class instances whose methods live on the prototype, so
 * `Object.entries(port)` finds none of them and an enumerate-and-rewrite
 * approach would silently wrap nothing.
 *
 * Read ports get the record id from the same place a use case would — the first
 * argument — but no read-port rule is `ownable` today, so in practice the guard
 * never looks at it.
 */
function wrapReadPort<T extends object>(port: T, guard: Guard): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        const refusal = await guard(args[0]);
        if (refusal !== null) throw new ForbiddenError(refusal);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Wraps a composed platform for one actor.
 *
 * Contexts and their members are discovered by enumeration rather than named
 * one by one, so a tenth context is gated the day it is wired — with no rules it
 * denies every non-admin, which is loud and safe rather than quiet and open.
 */
export function authorizePlatform(
  platform: Platform,
  actor: PlatformActor,
  deps: AuthorizePlatformDeps,
): Platform {
  const policy = deps.policy ?? PLATFORM_PERMISSIONS;
  const wrapped: Record<string, unknown> = {};
  defineRefusedComposition(wrapped);

  for (const [contextKey, contextValue] of Object.entries(platform)) {
    if (contextKey === "composition") continue; // replaced by the throwing accessor above
    if (PASSTHROUGH_KEYS.has(contextKey) || typeof contextValue !== "object" || contextValue === null) {
      wrapped[contextKey] = contextValue;
      continue;
    }

    const wrappedContext: Record<string, unknown> = {};
    for (const [memberName, member] of Object.entries(contextValue as Record<string, unknown>)) {
      const key = `${contextKey}.${memberName}`;
      const rule = policy[key];
      const guard: Guard = (input) => decide(key, rule, actor, deps.ownership, input);

      if (rule?.introspectionOnly === true) {
        // Passed through unchanged whether or not the role is listed. This member
        // is read for its identity (`GET /health` names the live ACL), never
        // invoked through the platform, so there is no call to gate — wrapping it
        // would only make `constructor.name` reporting stranger than it already is.
        wrappedContext[memberName] = member;
      } else if (hasExecute(member)) {
        wrappedContext[memberName] = wrapUseCase(member, guard);
      } else if (typeof member === "object" && member !== null) {
        wrappedContext[memberName] = wrapReadPort(member, guard);
      } else {
        // Not an object and not a use case — nothing to gate. No such member
        // exists on `Platform` today; this is here so a future primitive member
        // does not crash the wrapper.
        wrappedContext[memberName] = member;
      }
    }
    wrapped[contextKey] = wrappedContext;
  }

  // The loop above reproduces `Platform`'s shape key for key, but TypeScript
  // cannot see that through `Object.entries`. The completeness test in
  // `permissions.test.ts` is what actually holds the shape honest.
  return wrapped as unknown as Platform;
}
