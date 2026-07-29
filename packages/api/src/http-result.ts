import type { ServerResponse } from "node:http";
import { isForbiddenError, type Result } from "@afrip/shared-kernel";

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * When true, `body` is already a serialised payload and is written verbatim
   * instead of being JSON-encoded. Only the dashboard route sets this — every
   * API route stays JSON, including 404s for unknown paths.
   */
  readonly raw?: boolean;
}

export const json = (status: number, body: unknown): HttpResponse => ({ status, body });

/**
 * Serves a pre-rendered HTML document. `cache-control` is short and revalidating:
 * the markup is baked into the bundle, so a new revision must be picked up
 * promptly, but a reload inside a session should not refetch it.
 */
export const html = (markup: string, status = 200): HttpResponse => ({
  status,
  body: markup,
  raw: true,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate",
  },
});

export const badRequest = (message: string): HttpResponse => json(400, { error: message });
export const unauthorized = (message: string): HttpResponse => json(401, { error: message });
export const forbidden = (message: string): HttpResponse =>
  json(403, { error: message, code: FORBIDDEN_CODE });
export const notFound = (message: string): HttpResponse => json(404, { error: message });
export const methodNotAllowed = (message: string): HttpResponse => json(405, { error: message });
export const payloadTooLarge = (message: string): HttpResponse => json(413, { error: message });
export const serviceUnavailable = (body: unknown): HttpResponse => json(503, body);

/**
 * Generic 500 body. Deliberately says nothing about the failure: stack traces and
 * internal messages go to the server log, never to the client.
 */
export const internalError = (): HttpResponse => json(500, { error: "internal server error" });

/**
 * Machine-readable discriminant on a 403 body, so the frontend can tell "you may
 * not do this" from a validation failure without parsing prose. Mirrors the
 * `code` field the 401s already carry (see AUTH_ERROR_CODES).
 */
export const FORBIDDEN_CODE = "not_permitted";

/**
 * Use cases signal failure with a plain string. We have no error taxonomy in the
 * domain yet, so the phrasing the contexts already share for a failed lookup is
 * the one distinction worth mapping onto a status code:
 *   "Village not found: v-1"                      -> 404
 *   "No recovery index found for village: v-1"    -> 404
 * everything else is a rejected command -> 400.
 *
 * An authorization refusal (ADR 0009) is the exception to the guesswork: it
 * carries the shared `FORBIDDEN_PREFIX` constant and is matched by equality, not
 * by a pattern. That is deliberate — a regex for /not permitted/i would turn a
 * domain validation message that happened to use those words into a 403, and a
 * 403 tells the browser something quite specific (do not retry, do not refresh
 * the token, this account cannot do this).
 *
 * Checked FIRST, because a refusal to read a record the actor may not see must
 * not be reported as 404: "no such village" and "not your village" are different
 * answers, and only one of them is true.
 */
const NOT_FOUND_PATTERNS: readonly RegExp[] = [/not found/i, /^no .+ found\b/i];

export function statusForError(message: string): number {
  if (isForbiddenError(message)) return 403;
  return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message)) ? 404 : 400;
}

/**
 * The error body for a failed use case.
 *
 * A 403 carries `code` and the others do not, so the frontend can branch on a
 * discriminant rather than on prose — and so it cannot mistake a refusal for the
 * 401 that means "refresh your token". Built here rather than at each call site
 * because both `fromResult` and `fromResultWith` return refusals, and a `code`
 * present on one path and absent on the other is exactly the inconsistency a
 * client discovers in production.
 */
function errorBody(message: string, status: number): unknown {
  return status === 403 ? { error: message, code: FORBIDDEN_CODE } : { error: message };
}

/** Maps a use-case Result onto an HTTP response: ok -> successStatus, err -> 400/403/404. */
export function fromResult<T>(result: Result<T>, successStatus = 200): HttpResponse {
  if (result.ok) return json(successStatus, result.value);
  const status = statusForError(result.error);
  return json(status, errorBody(result.error, status));
}

/** Maps a use-case Result, reshaping the ok value (e.g. wrapping a list). */
export function fromResultWith<T>(
  result: Result<T>,
  project: (value: T) => unknown,
  successStatus = 200,
): HttpResponse {
  if (result.ok) return json(successStatus, project(result.value));
  const status = statusForError(result.error);
  return json(status, errorBody(result.error, status));
}

export function writeResponse(res: ServerResponse, response: HttpResponse): void {
  const payload = response.raw === true ? String(response.body ?? "") : JSON.stringify(response.body ?? {});
  res.writeHead(response.status, {
    "content-type": "application/json; charset=utf-8",
    ...response.headers,
    // Always last: content-length is derived from the payload we are about to
    // write, so a route's own headers must never be able to contradict it.
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}
