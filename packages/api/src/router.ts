import type { Platform } from "@afrip/platform";
import type { ActorContext, VerifiedClaims } from "./auth.js";
import type { HttpResponse } from "./http-result.js";

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  /** Path parameters; missing keys read as undefined so handlers can validate them. */
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: URLSearchParams;
  /** Parsed JSON body, or undefined when the request carried none. */
  readonly body: unknown;
  /**
   * Who is acting (ADR 0008), or null when the request carries no identity — a
   * public path, an open dev server, or the transitional shared token, which
   * proves possession of a secret and nothing about a person.
   *
   * Attached, not enforced: what each role may DO is ADR 0009.
   */
  readonly actor?: ActorContext | null;
  /**
   * The verified token's claims, when one was presented. Only the enrolment
   * route reads them, and only because it must act for an identity the profile
   * store does not know yet. Every other handler wants `actor`: the claims are
   * what the token said, `actor` is what AFRIP decided, and a role read from the
   * former would be a role the user chose for themselves.
   */
  readonly claims?: VerifiedClaims;
  /** True when the caller holds a valid token but is not an AFRIP user yet. */
  readonly unenrolled?: boolean;
  /**
   * The platform composed for THIS request (ADR 0010) — the same use cases over
   * the same repositories as ever, but publishing through a decorator that
   * stamps `actor` onto every event they raise.
   *
   * Route handlers must reach for this and never for `deps.runtime.platform`.
   * The long-lived platform is not wrong so much as differently attributed: it
   * stamps `system`, which is the honest label for a scheduled sweep and a lie
   * about an officer's POST.
   */
  readonly platform: Platform;
  /** Correlates every event this request raises. Stamped alongside the actor. */
  readonly requestId: string;
}

export type RouteHandler = (ctx: RequestContext) => Promise<HttpResponse>;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

export interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Record<string, string | undefined>;
}

function split(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string | undefined> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string | undefined> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i] as string;
    const got = actual[i] as string;
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(got);
      } catch {
        return null; // malformed percent-encoding — treat as a non-match
      }
      continue;
    }
    if (expected !== got) return null;
  }
  return params;
}

/**
 * Minimal path/method router. Patterns are literal segments plus `:name`
 * parameters, e.g. `/villages/:id/damage-assessments`. Routes are matched in
 * registration order; there is no wildcard or regex support by design.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add("PATCH", pattern, handler);
  }

  match(method: string, path: string): RouteMatch | null {
    const actual = split(path);
    const wanted = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== wanted) continue;
      const params = matchSegments(route.segments, actual);
      if (params !== null) return { handler: route.handler, params };
    }
    return null;
  }

  /** True when some route shares the path but not the method — lets us answer 405 instead of 404. */
  hasPath(path: string): boolean {
    const actual = split(path);
    return this.routes.some((route) => matchSegments(route.segments, actual) !== null);
  }
}
