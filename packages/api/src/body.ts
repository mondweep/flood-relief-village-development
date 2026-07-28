import type { IncomingMessage } from "node:http";
import { err, ok, type Result } from "@afrip/shared-kernel";
import { badRequest, payloadTooLarge, type HttpResponse } from "./http-result.js";

/** Hard ceiling on a request body. Damage assessments and issue reports are small JSON documents. */
export const MAX_BODY_BYTES = 1_048_576;

/**
 * Reads the request body and parses it as JSON.
 *
 * Returns `ok(undefined)` for an empty body, an err response for anything the
 * server must refuse: an oversized stream (413), malformed JSON (400) or a
 * transport error (400). It never throws, so a hostile client cannot take the
 * process down with a truncated or gigantic payload.
 */
export async function readJsonBody(req: IncomingMessage): Promise<Result<unknown, HttpResponse>> {
  const raw = await readRaw(req);
  if (!raw.ok) return err(raw.error);
  if (raw.value.length === 0) return ok(undefined);

  try {
    return ok(JSON.parse(raw.value.toString("utf8")) as unknown);
  } catch {
    return err(badRequest("request body must be valid JSON"));
  }
}

function readRaw(req: IncomingMessage): Promise<Result<Buffer, HttpResponse>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (result: Result<Buffer, HttpResponse>): void => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading and answer 413 with `connection: close`, so the rest of
        // the upload is never buffered and Node tears the socket down once the
        // response has flushed. Destroying the request here instead would race
        // the response and hand the client a bare connection reset.
        req.pause();
        settle(
          err({
            ...payloadTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`),
            headers: { connection: "close" },
          }),
        );
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => settle(ok(Buffer.concat(chunks)));
    const onError = (): void => settle(err(badRequest("could not read request body")));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
