import type { HttpResponse } from "./http-result.js";

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  /** Path parameters; missing keys read as undefined so handlers can validate them. */
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: URLSearchParams;
  /** Parsed JSON body, or undefined when the request carried none. */
  readonly body: unknown;
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
