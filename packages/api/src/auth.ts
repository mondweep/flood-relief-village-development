import { timingSafeEqual } from "node:crypto";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { DEFAULT_ROLE, type AuthenticatedActor } from "@afrip/shared-kernel";
import type { ApiConfig } from "./config.js";
import { json, type HttpResponse } from "./http-result.js";

/**
 * Identity gate (ADR 0008). This module REPLACES the shared static bearer token
 * that preceded it: the API now verifies per-user JWTs minted by Supabase Auth
 * (GoTrue) and resolves them to an application profile. It never issues a token
 * and never calls Supabase to check one — verification is local, against a key
 * set that is fetched once and cached.
 *
 * The legacy `API_TOKEN` path survives as an explicitly transitional
 * concession, and `GET /health` says so out loud while it is switched on. A
 * transitional weakness that is invisible is a transitional weakness that
 * becomes permanent.
 *
 * Role PERMISSIONS are deliberately not enforced here — that is ADR 0009. This
 * module's whole job is to answer "who is this?" and attach the answer.
 */

// ---------------------------------------------------------------------------
// Public paths
// ---------------------------------------------------------------------------

/**
 * Routes reachable without any credential.
 *
 * `/health` and `/ready` are Cloud Run's probes — they must answer before any
 * credential is configured. `/public/*` is the transparency projection, which is
 * public by product design and carries no beneficiary PII (it also carries
 * `/public/config`, the sign-in bootstrap the page needs *before* it can hold a
 * token). `/` and `/index.html` serve the dashboard shell: it is the surface a
 * human uses to *obtain* access, so gating it behind the very credential it
 * exists to collect would be circular.
 */
const PUBLIC_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/index.html",
  "/health",
  "/ready",
]);
const PUBLIC_PREFIX = "/public/";

export function isPublicPath(path: string): boolean {
  // Normalise the way the router does (`//` and a trailing slash are the same
  // path to it), so the gate cannot disagree with what actually gets routed.
  const normalised = normalise(path);
  return (
    PUBLIC_EXACT_PATHS.has(normalised) || normalised === "/public" || normalised.startsWith(PUBLIC_PREFIX)
  );
}

function normalise(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The role model. It lives in the shared kernel (`authorization.ts`) rather than
 * here, because the same five names appear in a Postgres check constraint, in
 * this gate, in an event's `actor` and in the frontend — and a second copy would
 * drift by gaining a role in one place that the other silently treats as
 * unknown. Re-exported so this module stays the one place the API asks "who is
 * this?", which is all it does: what each role may DO is ADR 0009, enforced in
 * `authorizePlatform`.
 */
export {
  DEFAULT_ROLE,
  USER_ROLES,
  isUserRole,
  type UserRole,
} from "@afrip/shared-kernel";

/**
 * Who the current request is acting as. Null when the request carries no
 * identity. An alias for the shared kernel's `AuthenticatedActor` — the name
 * `ActorContext` is what the router and every route module already say, and
 * renaming ~40 call sites to gain nothing would be churn.
 */
export type ActorContext = AuthenticatedActor;

/** The claims we take off a verified token. Everything else is ignored. */
export interface VerifiedClaims {
  readonly sub: string;
  readonly email: string | null;
  readonly payload: JWTPayload;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Why a token was refused. The distinction is load-bearing, not cosmetic: an
 * *expired* token means the browser should spend its refresh token and retry,
 * while an *invalid* one means it should throw the session away and send the
 * user back to the sign-in form. Collapsing the two produces either a spurious
 * sign-out or a refresh loop.
 */
export type TokenFailure = "expired" | "invalid";

export type VerifyResult =
  | { readonly ok: true; readonly claims: VerifiedClaims }
  | { readonly ok: false; readonly failure: TokenFailure; readonly detail: string };

export interface TokenVerifier {
  verify(token: string): Promise<VerifyResult>;
}

/**
 * Internal failure vocabulary: `unavailable` ("the key set could not be
 * consulted") is what triggers the HS256 fallback and never leaves this module.
 */
type InternalFailure = TokenFailure | "unavailable";

type InternalResult =
  | { readonly ok: true; readonly claims: VerifiedClaims }
  | { readonly ok: false; readonly failure: InternalFailure; readonly detail: string };

/** Collapses the internal `unavailable` verdict onto the public `invalid` one. */
function settle(result: InternalResult, unavailableDetail?: string): VerifyResult {
  if (result.ok) return result;
  if (result.failure === "unavailable") {
    return { ok: false, failure: "invalid", detail: unavailableDetail ?? result.detail };
  }
  return { ok: false, failure: result.failure, detail: result.detail };
}

export interface JwtVerifierOptions {
  /** Project base URL, e.g. https://xyz.supabase.co. Issuer and JWKS derive from it. */
  readonly supabaseUrl: string;
  /** HS256 fallback for projects still on a shared secret. */
  readonly jwtSecret?: string | null;
  /**
   * Test seam: an already-resolved key set (`createLocalJWKSet`) used instead of
   * the remote one. Present so the suite can verify locally-signed tokens with
   * no network at all — a test that reaches the internet is a test that fails on
   * a plane.
   */
  readonly keySet?: JWTVerifyGetKey;
  /** Overridable so a non-standard GoTrue mount can still be verified. */
  readonly audience?: string;
}

/** GoTrue stamps every user token with this audience. */
export const SUPABASE_AUDIENCE = "authenticated";

export function supabaseIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

export function supabaseJwksUrl(supabaseUrl: string): URL {
  return new URL(`${supabaseIssuer(supabaseUrl)}/.well-known/jwks.json`);
}

function isExpiry(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTExpired ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_JWT_EXPIRED")
  );
}

/**
 * True for failures that mean "the key set could not be consulted" rather than
 * "this signature is wrong" — a DNS failure, a 5xx from the project, a JWKS
 * document we cannot parse, or no matching `kid`. Only these justify falling
 * back to the shared secret; a genuinely bad signature must never be retried
 * against a second key, or a token rejected by one path could be accepted by
 * the other.
 */
function isKeySetUnavailable(error: unknown): boolean {
  if (
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys ||
    error instanceof joseErrors.JWKSInvalid ||
    error instanceof joseErrors.JWKSTimeout
  ) {
    return true;
  }
  // A fetch failure surfaces as a plain TypeError/Error from undici, not a jose
  // error class, so it is identified by not being one of jose's claim/signature
  // verdicts.
  return !(error instanceof joseErrors.JOSEError);
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claimsFrom(payload: JWTPayload): VerifiedClaims | null {
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  const email = typeof payload["email"] === "string" ? payload["email"] : null;
  return { sub, email, payload };
}

/**
 * Verifies Supabase-issued JWTs locally.
 *
 * Asymmetric keys first (the modern Supabase default): `createRemoteJWKSet`
 * fetches the project's JWKS once and caches it, re-fetching only when it sees
 * an unknown `kid` and never more often than its own cooldown. No request to
 * Supabase happens per API call — that would put a network round trip and a
 * third-party outage in the path of every single authenticated request.
 *
 * HS256 is used when the token itself says so (older projects sign with the
 * shared secret) and as the fallback when the JWKS endpoint cannot be reached.
 */
export function createJwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  const issuer = supabaseIssuer(options.supabaseUrl);
  const audience = options.audience ?? SUPABASE_AUDIENCE;
  const secret =
    options.jwtSecret === undefined || options.jwtSecret === null || options.jwtSecret.length === 0
      ? null
      : new TextEncoder().encode(options.jwtSecret);

  // Built once, lazily: constructing it is cheap and opens no socket, but
  // deferring keeps a server that never sees a token from ever touching DNS.
  let keySet: JWTVerifyGetKey | null = options.keySet ?? null;
  const resolveKeySet = (): JWTVerifyGetKey => {
    keySet ??= createRemoteJWKSet(supabaseJwksUrl(options.supabaseUrl));
    return keySet;
  };

  async function attempt(token: string, key: JWTVerifyGetKey | Uint8Array): Promise<InternalResult> {
    try {
      // `clockTolerance` is deliberately left at jose's default of 0.
      //
      // The case for widening it would be clock skew between this host and the
      // project that minted the token: we would call a token expired slightly
      // before its holder expects, and refuse a request that ought to have
      // succeeded. That does not compound. The browser refreshes, receives a
      // token with a full fresh lifetime, and proceeds — one extra round trip,
      // no cycle, even when the skew approaches the whole token lifetime. (The
      // client half of that was measured, not assumed: its retry re-issues the
      // raw request rather than re-entering the wrapper, so a second retry is
      // structurally impossible.) Tolerance would therefore buy nothing against
      // the failure it looks like it prevents, while widening the window in
      // which an expired token is still honoured — and ADR 0008 spent that
      // budget the other way on purpose, choosing sessions that end at tab
      // close for a system holding records about widows and orphaned children.
      const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, { issuer, audience });
      const claims = claimsFrom(payload);
      if (claims === null) {
        return { ok: false, failure: "invalid", detail: "token carries no subject (sub) claim" };
      }
      return { ok: true, claims };
    } catch (error) {
      if (isExpiry(error)) return { ok: false, failure: "expired", detail: detailOf(error) };
      const failure: InternalFailure = isKeySetUnavailable(error) ? "unavailable" : "invalid";
      return { ok: false, failure, detail: detailOf(error) };
    }
  }

  return {
    async verify(token: string): Promise<VerifyResult> {
      let alg: string;
      try {
        alg = decodeProtectedHeader(token).alg ?? "";
      } catch (error) {
        // Not even shaped like a JWT — this is the case the legacy static token
        // lands in, so the caller gets a plain "invalid" and can try that path.
        return { ok: false, failure: "invalid", detail: detailOf(error) };
      }

      if (alg.startsWith("HS")) {
        if (secret === null) {
          return {
            ok: false,
            failure: "invalid",
            detail: `token is signed with ${alg} but SUPABASE_JWT_SECRET is not configured`,
          };
        }
        return settle(await attempt(token, secret));
      }

      const viaJwks = await attempt(token, resolveKeySet());
      if (viaJwks.ok || viaJwks.failure !== "unavailable") return settle(viaJwks);

      // JWKS could not be consulted. An asymmetric token cannot be checked
      // against the shared secret, so this only rescues a project whose tokens
      // are HS-signed behind a header we could not read as such; either way the
      // operator gets the JWKS failure in the detail rather than a bare "invalid".
      const unavailable = `JWKS unavailable: ${viaJwks.detail}`;
      if (secret === null) return { ok: false, failure: "invalid", detail: unavailable };
      return settle(await attempt(token, secret), unavailable);
    },
  };
}

/** Convenience for tests and for callers holding a JWKS document in hand. */
export function localKeySet(jwks: { keys: unknown[] }): JWTVerifyGetKey {
  return createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * Turns a verified token into an application actor. The role is read from
 * `assam_floods.user_profiles`, never from the token: a claim the user's own
 * signup could influence must not decide what they may see.
 */
export interface ProfileDirectory {
  resolve(claims: VerifiedClaims): Promise<ActorContext | null>;
}

/**
 * Fallback for runtimes with no `user_profiles` table to read — i.e. the
 * in-memory development mode. It trusts the token for identity (that part IS
 * signed) but refuses to infer a role from it, pinning everyone to `citizen`.
 * The result is a dev server where sign-in works and privilege does not.
 *
 * DO NOT read the role from the token here. `role` being hard-coded is
 * load-bearing, not an unfinished edge case, and the edit that breaks it looks
 * like a fix: reaching into `claims.payload` for a `role`, `user_role` or
 * `user_metadata.role` to make dev behave "properly" like production. Those
 * fields originate in the user's own signup payload — GoTrue will carry
 * whatever they put there — so honouring one turns self-registration into
 * self-promotion, in every deployment that lacks a profile store. If a runtime
 * needs real roles, the answer is to give it a real `ProfileDirectory`
 * (SupabaseProfileDirectory), not to teach this one to trust the token.
 */
export function claimsOnlyProfiles(): ProfileDirectory {
  return {
    resolve: async (claims) => ({
      id: claims.sub,
      email: claims.email ?? "",
      role: DEFAULT_ROLE,
    }),
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type AuthOutcome =
  | { readonly authorized: true; readonly actor: ActorContext | null }
  | { readonly authorized: false; readonly response: HttpResponse };

/** Machine-readable 401 discriminants. The frontend branches on these, not on prose. */
export const AUTH_ERROR_CODES = {
  missing: "token_missing",
  expired: "token_expired",
  invalid: "token_invalid",
  unknownUser: "user_unknown",
} as const;

const CHALLENGE = { "www-authenticate": 'Bearer realm="afrip"' } as const;

function refuse(status: number, error: string, code: string): HttpResponse {
  return { ...json(status, { error, code }), headers: CHALLENGE };
}

export const MISSING_TOKEN_RESPONSE = refuse(401, "missing bearer token", AUTH_ERROR_CODES.missing);
export const EXPIRED_TOKEN_RESPONSE = refuse(401, "token expired", AUTH_ERROR_CODES.expired);
export const INVALID_TOKEN_RESPONSE = refuse(401, "invalid token", AUTH_ERROR_CODES.invalid);
export const UNKNOWN_USER_RESPONSE = refuse(
  401,
  "no user profile for this identity",
  AUTH_ERROR_CODES.unknownUser,
);

export interface AuthGate {
  authorize(path: string, header: string | undefined): Promise<AuthOutcome>;
  /** True while the shared static token is still accepted. Disclosed on /health. */
  readonly legacyTokenEnabled: boolean;
  /** True when Supabase JWTs are verified. */
  readonly jwtEnabled: boolean;
  /**
   * What this gate actually does, reported verbatim by `GET /health`.
   *
   * Derived from the gate's own state rather than re-derived from config, and
   * that distinction is load-bearing. `"disabled"` is exactly the condition
   * under which `authorize` waves every request through, so a client may read it
   * as "an uncredentialed request will be accepted" — and the dashboard does
   * precisely that, to decide whether to unlock its interface on a deployment
   * that asks for no credential. Computing it from config instead would let the
   * two disagree wherever a verifier is supplied directly (the test seam), and
   * `/health` would then be describing a gate that is not the one running.
   */
  readonly mode: AuthMode;
}

/**
 * Whether this configuration verifies Supabase JWTs. Derived rather than stored
 * so `/health`, `/public/config` and the startup banner cannot disagree with the
 * gate about which doors are open.
 */
export function jwtAuthEnabled(config: ApiConfig): boolean {
  return config.authJwt && config.supabaseUrl !== null;
}

/** Whether the transitional shared token is still accepted. */
export function legacyTokenEnabled(config: ApiConfig): boolean {
  return config.apiToken !== null;
}

export type AuthMode = "supabase-jwt" | "bearer" | "disabled";

/**
 * What `GET /health` would report for a configuration, used where no gate has
 * been built yet (the startup banner's fallback). Prefer `AuthGate.mode`:
 * `/health` must describe the gate that is actually running, not the one this
 * configuration implies. See the note on `AuthGate.mode`.
 */
export function authModeOf(config: ApiConfig): AuthMode {
  if (jwtAuthEnabled(config)) return "supabase-jwt";
  return legacyTokenEnabled(config) ? "bearer" : "disabled";
}

/**
 * The warning `/health` carries while the legacy path is live. ADR 0008 is
 * explicit that this must be visible: both paths are accepted during migration,
 * and an undisclosed transitional weakness is one nobody ever gets round to
 * removing.
 */
export const LEGACY_TOKEN_WARNING =
  "API_TOKEN is still accepted: a shared static credential that identifies no one and " +
  "cannot be revoked per user. Transitional only (ADR 0008) — unset it once every client " +
  "has moved to Supabase sign-in.";

export interface AuthGateDeps {
  readonly config: ApiConfig;
  /** Supplied by tests; built from config when omitted. */
  readonly verifier?: TokenVerifier | null;
  /** Where a verified `sub` is resolved to a profile. Claims-only when omitted. */
  readonly profiles?: ProfileDirectory | null;
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

const OPEN: AuthOutcome = { authorized: true, actor: null };

/**
 * Builds the request gate.
 *
 * Order of business, and why:
 *  1. public paths short-circuit — they must answer with no credential at all;
 *  2. with neither JWT verification nor a legacy token configured the API is
 *     wide open (a dev convenience the server warns loudly about at startup);
 *  3. a presented credential is tried as a JWT first, because that is the path
 *     we are migrating *to*; only a token that is not even shaped like a JWT
 *     falls through to the static comparison. An expired JWT never reaches the
 *     legacy branch — it is a JWT, and the answer the browser needs is "refresh".
 */
export function createAuthGate(deps: AuthGateDeps): AuthGate {
  const { config } = deps;
  const jwtEnabled = config.authJwt && config.supabaseUrl !== null;

  const verifier =
    deps.verifier !== undefined && deps.verifier !== null
      ? deps.verifier
      : jwtEnabled
        ? createJwtVerifier({
            // Guarded by jwtEnabled above; loadConfig also refuses this combination.
            supabaseUrl: config.supabaseUrl as string,
            jwtSecret: config.supabaseJwtSecret,
          })
        : null;

  const profiles = deps.profiles ?? claimsOnlyProfiles();
  const legacyToken = config.apiToken;
  const active = verifier !== null || legacyToken !== null;

  async function fromJwt(presented: string): Promise<AuthOutcome | null> {
    if (verifier === null) return null;
    const result = await verifier.verify(presented);
    if (!result.ok) {
      if (result.failure === "expired") {
        return { authorized: false, response: EXPIRED_TOKEN_RESPONSE };
      }
      // Not a valid JWT. Return null so the legacy branch gets its turn.
      return null;
    }
    const actor = await profiles.resolve(result.claims);
    if (actor === null) {
      // NOT an edge case — this branch is INTENDED as an authorization
      // boundary, the one separating "holds a valid token for this Supabase
      // project" from "is a user of AFRIP". Read the caveat below before
      // relying on it: as things stand it does not carry that weight.
      //
      // The project is SHARED with unrelated applications (see the header of
      // 00001_initial_schema.sql). GoTrue's user pool is per-project, and every
      // token it mints carries the same `iss` and the same `aud: authenticated`
      // signed by the same key — so a token belonging to a neighbouring
      // application on this project verifies here perfectly. The only thing
      // between such a holder and the beneficiary register is this line — IF
      // they arrive here without a profile row.
      //
      // CAVEAT, and it currently defeats the above: the signup trigger in
      // 00004 fires on ANY insert into `auth.users`, which on a shared project
      // means every neighbouring application's signup is auto-enrolled here as
      // `citizen`. Measured, not theorised. Since no route consults `role` yet
      // (ADR 0009), `citizen` means full API access — so this branch protects
      // far less than its shape suggests until that trigger is scoped or roles
      // are enforced. See the header of 00004_user_profiles.sql.
      //
      // Which makes the tempting fix dangerous, and it will be tempting: the
      // symptom is a real person reporting "I signed up and it says I'm not a
      // user", and falling back to the claims-only actor makes that complaint
      // go away in one line. It would also admit every user of every
      // application sharing this project. The genuine causes are that the
      // signup trigger in 00004 is not installed, or the account predates it —
      // both fixed by applying the migration, which backfills existing users.
      // Diagnose with the profile lookup log; do not widen this branch.
      return { authorized: false, response: UNKNOWN_USER_RESPONSE };
    }
    return { authorized: true, actor };
  }

  return {
    jwtEnabled: verifier !== null,
    legacyTokenEnabled: legacyToken !== null,
    // `active` is the single fact behind both this and the short-circuit in
    // `authorize` below, so "disabled" cannot drift from "lets everything past".
    mode: verifier !== null ? "supabase-jwt" : legacyToken !== null ? "bearer" : "disabled",

    async authorize(path: string, header: string | undefined): Promise<AuthOutcome> {
      if (isPublicPath(path)) return OPEN;
      if (!active) return OPEN;

      const presented = bearerToken(header);
      if (presented === null) {
        return { authorized: false, response: MISSING_TOKEN_RESPONSE };
      }

      const viaJwt = await fromJwt(presented);
      if (viaJwt !== null) return viaJwt;

      if (legacyToken !== null && sameToken(presented, legacyToken)) {
        // Transitional: a shared token proves possession of a secret, not
        // identity, so the request proceeds with no actor attached. Routes that
        // need to know *who* is acting (GET /me) refuse it on that basis.
        return OPEN;
      }

      return { authorized: false, response: INVALID_TOKEN_RESPONSE };
    },
  };
}
