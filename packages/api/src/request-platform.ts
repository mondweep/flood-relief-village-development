import { randomUUID } from "node:crypto";
import { authorizePlatform, createPlatform, type Platform, type PlatformOverrides } from "@afrip/platform";
import {
  ActorStampingPublisher,
  NO_OWNERSHIP,
  OwnershipRecordingPublisher,
  anonymousActor,
  systemActor,
  userActor,
  type EventActor,
  type OwnershipRegistry,
} from "@afrip/shared-kernel";
import type { ActorContext, AuthMode } from "./auth.js";

/**
 * Request-scoped composition (ADR 0010).
 *
 * The problem this solves: identity is established at the HTTP edge, but the
 * code that needs it — the `EventPublisher` call inside `execute` — is forty-odd
 * use cases deep. Rather than thread an `actor` parameter through every one of
 * those signatures, the API re-composes the platform per request with an
 * `ActorStampingPublisher` in front of the shared bus. The use cases are
 * identical objects doing the identical thing; only what they publish *through*
 * changes.
 *
 * PERFORMANCE-RELEVANT INVARIANT — read before editing `createPlatform`.
 *
 * This is affordable only because per-request composition is pure wiring: ~45
 * `new UseCase({...})` calls over ports that already exist. Everything genuinely
 * expensive is built ONCE at startup and injected in:
 *
 *   - the Supabase client and its connection state  (persistence.ts, once)
 *   - every repository adapter                      (base platform, once)
 *   - the JWKS key set                              (auth gate, once — createHandler)
 *   - the clock and the id generators               (base platform, once)
 *
 * They arrive here as `base.composition` and are handed straight back to
 * `createPlatform`, so the same instances serve every request. If an expensive
 * resource is ever constructed *inside* `createPlatform` — a database
 * connection, a key set, a file read, an HTTP client — this stops being cheap
 * wiring and silently becomes a per-request cost paid on every single call, with
 * no test failing to tell you. Add it to `PlatformComposition` instead, so it is
 * built once and injected like the rest.
 *
 * Deliberately NOT cached per actor. A cache keyed on the actor would have to
 * hold `requestId` mutable across concurrent requests from the same user, and
 * two overlapping requests would then attribute each other's events. Correct
 * attribution is the entire point; a few dozen short-lived objects is the
 * cheaper thing to spend.
 */

/** The actor for events the platform raises on nobody's behalf. */
export const PLATFORM_SYSTEM_ACTOR: EventActor = systemActor("platform");

/**
 * Builds the long-lived platform: the one that owns the event bus, the
 * cross-context subscriptions and the repository adapters.
 *
 * Its own publisher stamps `system`, which covers the events no request can be
 * blamed for. Two kinds arrive here:
 *   - cross-context reactions. A user's damage assessment is published by their
 *     request-scoped platform and attributed to them; the recovery-index
 *     recalculation that the bus subscriber then performs is the platform
 *     reacting, not the officer recalculating, and is recorded as such.
 *   - anything run outside a request at all — ADR 0010's scheduled anomaly
 *     sweep is the example.
 *
 * `system` here is a positive claim, not a default: it says "no human did this".
 * The absence of an actor means something else entirely — that an event escaped
 * every stamping path — and the guard test in request-platform.test.ts exists to
 * keep those two apart.
 */
export function createBasePlatform(
  overrides: PlatformOverrides = {},
  /**
   * Where ownership is recorded (ADR 0009). Defaults to `NO_OWNERSHIP` so a
   * caller that has no store — the tests that build a bare platform — gets a
   * registry that records nothing and grants nothing, rather than a crash or a
   * silent `true`.
   */
  ownership: OwnershipRegistry = NO_OWNERSHIP,
): Platform {
  return createPlatform({
    ...overrides,
    eventPublisher: (bus) =>
      new ActorStampingPublisher(new OwnershipRecordingPublisher(bus, ownership), PLATFORM_SYSTEM_ACTOR),
  });
}

/**
 * How the request's identity (ADR 0008) is expressed as an event actor.
 *
 * A null actor is NOT a user, and must not be recorded as one. Two ways it
 * happens, and they are different facts:
 *   - the transitional shared `API_TOKEN` was presented — a real person acted,
 *     but the credential identifies nobody and cannot be revoked per user;
 *   - no credential is configured at all (the open dev server).
 *
 * The gate's own mode distinguishes them. A public path also yields a null
 * actor, and in `bearer` mode would be labelled `legacy-token` — imprecise, but
 * public paths are reads and raise no events, so nothing is ever recorded under
 * it.
 */
export function eventActorOf(actor: ActorContext | null | undefined, mode: AuthMode): EventActor {
  if (actor === null || actor === undefined) {
    return anonymousActor(mode === "bearer" ? "legacy-token" : "unauthenticated");
  }
  return userActor(actor);
}

/** A correlation id for every event raised while serving one request. */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * Re-wires `base`'s use cases so everything they publish is stamped with
 * `actor` and `requestId`.
 *
 * The stamping publisher wraps `base.bus` — the long-lived bus — NOT the
 * composed platform's own bus. That is what keeps the subscribers wired at
 * startup (the damage-assessed to recovery-index integration, and the API's own
 * read models in projections.ts) receiving events exactly once, now attributed.
 * The composed platform's own bus is inert by construction; see the note on
 * `PlatformOverrides.eventPublisher`.
 */
export function composeForActor(
  base: Platform,
  actor: EventActor,
  requestId?: string,
  ownership: OwnershipRegistry = NO_OWNERSHIP,
): Platform {
  return createPlatform({
    ...base.composition,
    // The bus this factory is handed belongs to the platform being composed and
    // is deliberately ignored: we wrap `base.bus`, the long-lived one.
    //
    // ORDER MATTERS. Recording goes INSIDE the stamp, because it reads
    // `event.actor` and the stamp is what puts it there. Swapped, it sees
    // unstamped events, records nothing, and every ownership-based edit is
    // refused forever — with no error anywhere. Pinned by two tests in
    // shared-kernel/test/ownership-recording-publisher.test.ts.
    eventPublisher: () =>
      new ActorStampingPublisher(
        new OwnershipRecordingPublisher(base.bus, ownership),
        actor,
        requestId,
      ),
  });
}

/**
 * The whole request-scoped chain: compose for the actor (ADR 0010), then gate
 * every use case on what that actor may do (ADR 0009).
 *
 * Authorization wraps the COMPOSED platform, not the base one, and in that order
 * for two reasons. A denied call must never publish, so the gate has to sit
 * outside the publisher — it does, since the gate intercepts `execute` and the
 * publisher is only reached from inside it. And the authorized platform refuses
 * to expose `composition`, which `composeForActor` needs; wrapping first would
 * break the next request's composition.
 *
 * `actor` here is the APPLICATION actor (`ActorContext | null`), not the event
 * actor. Null means the request carried no identity and every check passes —
 * see the note in `authorize-platform.ts`, which spells out that this layer
 * therefore adds nothing on a deployment still running on the shared
 * `API_TOKEN`.
 */
export function platformForRequest(
  base: Platform,
  actor: ActorContext | null,
  mode: AuthMode,
  requestId: string,
  ownership: OwnershipRegistry = NO_OWNERSHIP,
): Platform {
  const composed = composeForActor(base, eventActorOf(actor, mode), requestId, ownership);
  return authorizePlatform(composed, actor, { ownership });
}
