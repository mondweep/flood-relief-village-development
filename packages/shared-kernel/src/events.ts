/**
 * Who — or what — caused an event (ADR 0010).
 *
 * A closed union rather than a bag of optional strings, because the three cases
 * are genuinely different and collapsing them loses the distinction that audit
 * exists to preserve:
 *
 *  - `user`    — a signed-in person. The only case that names an individual.
 *  - `system`  — a process acting on nobody's behalf: a scheduled anomaly sweep,
 *                a cross-context reaction the platform performs automatically.
 *                It must be representable HONESTLY, rather than left blank (which
 *                reads as "we forgot") or attributed to whoever last signed in.
 *  - `anonymous` — a request we could not attribute to a person: the transitional
 *                shared `API_TOKEN` (which proves possession of a secret and
 *                nothing about a human, ADR 0008), or a deployment running with
 *                no credential configured at all. Deliberately NOT folded into
 *                `system`: "a person we cannot name did this" and "no person did
 *                this" are different facts, and only one of them is a gap in the
 *                audit trail.
 */
export type EventActor =
  | {
      readonly kind: "user";
      /** The authenticated subject id (Supabase `sub`). */
      readonly id: string;
      readonly email: string;
      /**
       * The application role at the time of the action. Typed as `string`, not
       * the API's `UserRole`: the shared kernel is the package everything else
       * depends on, so it cannot depend back on the API to learn the role list.
       * The authoritative union lives in `packages/api/src/auth.ts`.
       */
      readonly role: string;
    }
  | {
      readonly kind: "system";
      /** Which process, e.g. "anomaly-sweep". Never a person's name. */
      readonly name: string;
    }
  | {
      readonly kind: "anonymous";
      /** How the request got in without identifying anyone. */
      readonly via: "legacy-token" | "unauthenticated";
    };

export interface DomainEvent<TPayload = Record<string, unknown>> {
  /** Versioned event name, e.g. "village.registered.v1" */
  readonly name: string;
  /** ISO-8601 instant the event occurred */
  readonly occurredAt: string;
  /** Published-language payload: primitives and identifiers only */
  readonly payload: TPayload;
  /**
   * Who caused this (ADR 0010), stamped by `ActorStampingPublisher` at the
   * composition seam — never by the use case that raised the event.
   *
   * OPTIONAL on purpose. A use case constructs its events without an actor and
   * knows nothing about one (that is the whole point of ADR 0010: forty-odd
   * signatures stay unchanged), so the field is absent until a stamping
   * publisher fills it in. An unstamped event is therefore possible and means
   * exactly one thing: it was published through a composition path with no
   * stamping decorator.
   */
  readonly actor?: EventActor;
  /**
   * Correlates every event raised while serving one HTTP request. Optional for
   * the same reason as `actor`, and additionally absent for work that belongs
   * to no request at all.
   */
  readonly requestId?: string;
}

/** The actor for work performed by the platform itself, on nobody's behalf. */
export function systemActor(name: string): EventActor {
  return { kind: "system", name };
}

/** The actor for a request that got in without identifying a person. */
export function anonymousActor(via: "legacy-token" | "unauthenticated"): EventActor {
  return { kind: "anonymous", via };
}

/** The actor for a signed-in person. */
export function userActor(user: { id: string; email: string; role: string }): EventActor {
  return { kind: "user", id: user.id, email: user.email, role: user.role };
}
