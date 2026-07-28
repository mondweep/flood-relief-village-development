import { timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "./config.js";
import { unauthorized, type HttpResponse } from "./http-result.js";

/**
 * Routes reachable without a bearer token.
 *
 * `/health` and `/ready` are Cloud Run's probes — they must answer before any
 * credential is configured. `/public/*` is the transparency projection, which is
 * public by product design and carries no beneficiary PII.
 *
 * TODO(auth): this shared static token is a deliberate stopgap for the MVP. The
 * production path per docs/PRD.md is Supabase Auth with RLS-scoped JWTs, so that
 * an NGO field worker, a district officer and a citizen each see only the rows
 * their role permits. Replace this module — not extend it — when that lands.
 */
const PUBLIC_EXACT_PATHS: ReadonlySet<string> = new Set(["/health", "/ready"]);
const PUBLIC_PREFIX = "/public/";

export function isPublicPath(path: string): boolean {
  return PUBLIC_EXACT_PATHS.has(path) || path === "/public" || path.startsWith(PUBLIC_PREFIX);
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch; length is not secret here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type AuthOutcome = { readonly authorized: true } | { readonly authorized: false; readonly response: HttpResponse };

const AUTHORIZED: AuthOutcome = { authorized: true };

/**
 * Bearer-token gate. When `config.apiToken` is null the API is wide open — the
 * server logs a loud warning at startup and `/health` reports `auth: "disabled"`.
 */
export function authorize(config: ApiConfig, path: string, header: string | undefined): AuthOutcome {
  if (config.apiToken === null) return AUTHORIZED;
  if (isPublicPath(path)) return AUTHORIZED;

  const presented = bearerToken(header);
  if (presented === null) {
    return {
      authorized: false,
      response: {
        ...unauthorized("missing bearer token"),
        headers: { "www-authenticate": 'Bearer realm="afrip"' },
      },
    };
  }
  if (!sameToken(presented, config.apiToken)) {
    return {
      authorized: false,
      response: {
        ...unauthorized("invalid bearer token"),
        headers: { "www-authenticate": 'Bearer realm="afrip"' },
      },
    };
  }
  return AUTHORIZED;
}
