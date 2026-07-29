import { randomUUID } from "node:crypto";
import type { IdGenerator } from "./ports.js";

/**
 * The production `IdGenerator`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The composition root previously defaulted to `SequentialIdGenerator` — which
 * lives in `fakes.ts`, because it is a test fake. It counts from zero in process
 * memory, so on Cloud Run with `min-instances=0` the counter reset on every
 * scale-to-zero while the database kept the rows. The next village registered
 * after a restart was handed `village-1` again, and the Supabase adapter's
 * upsert-by-primary-key silently overwrote the existing one.
 *
 * That destroyed a real village record in production: a platform whose founding
 * complaint is that records vanish was quietly making them vanish.
 *
 * Ids must therefore be collision-resistant WITHOUT coordination — no shared
 * counter, no round trip, correct across restarts and across concurrent
 * instances. A random UUID satisfies that; `randomUUID()` is CSPRNG-backed and
 * needs no dependency.
 *
 * The prefix is retained because it makes ids self-describing in logs, URLs and
 * audit payloads: `village-3f2a…` says what it identifies, `3f2a…` does not.
 */
export class RandomIdGenerator implements IdGenerator {
  constructor(private readonly prefix: string) {}

  next(): string {
    return `${this.prefix}-${randomUUID()}`;
  }
}
