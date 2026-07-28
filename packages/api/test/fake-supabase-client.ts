import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A `vi.fn()`-backed stand-in for SupabaseClient, recording which tables the
 * wired adapters touch. Everything resolves from memory: these tests must never
 * open a socket or reach a live project.
 *
 * Deliberately a separate, smaller fake from the per-context adapter fakes: the
 * API only needs to know WHICH table each context talked to (proving the
 * Supabase adapters are the ones in the platform) plus how `/ready`'s probe
 * behaves, not how any single row round-trips.
 */

export interface FakeQuery {
  table: string;
  operation: "select" | "upsert" | "insert" | "delete";
  columns: string | null;
  limit: number | null;
}

export interface FakeSupabaseOptions {
  /** Rows returned by every select, per table. Defaults to empty. */
  tables?: Record<string, Record<string, unknown>[]>;
  /** Make one table's queries answer with a Postgres-style error. */
  failOn?: { table: string; message?: string };
  /** Make one table's queries reject, the way a DNS/TLS failure does. */
  throwOn?: { table: string; message?: string };
}

export interface FakeSupabase {
  client: SupabaseClient;
  queries: FakeQuery[];
  /** Every table the adapters have talked to, in first-touch order. */
  tablesTouched(): string[];
  queriesTo(table: string): FakeQuery[];
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const queries: FakeQuery[] = [];

  const from = vi.fn((table: string) => {
    const query: FakeQuery = { table, operation: "select", columns: null, limit: null };
    queries.push(query);

    const settle = (): Promise<{ data: unknown; error: { message: string } | null }> => {
      if (options.throwOn?.table === table) {
        return Promise.reject(new Error(options.throwOn.message ?? "fetch failed"));
      }
      if (options.failOn?.table === table) {
        return Promise.resolve({
          data: null,
          error: { message: options.failOn.message ?? "simulated postgres failure" },
        });
      }
      const rows = options.tables?.[table] ?? [];
      return Promise.resolve({ data: rows, error: null });
    };

    const builder = {
      select: vi.fn((columns?: string) => {
        query.operation = "select";
        query.columns = columns ?? null;
        return builder;
      }),
      upsert: vi.fn(() => {
        query.operation = "upsert";
        return builder;
      }),
      insert: vi.fn(() => {
        query.operation = "insert";
        return builder;
      }),
      delete: vi.fn(() => {
        query.operation = "delete";
        return builder;
      }),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn((count: number) => {
        query.limit = count;
        return builder;
      }),
      maybeSingle: vi.fn(() => settle().then((r) => ({ data: null, error: r.error }))),
      then: (
        onFulfilled: (value: { data: unknown; error: { message: string } | null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => settle().then(onFulfilled, onRejected),
    };

    return builder;
  });

  return {
    client: { from } as unknown as SupabaseClient,
    queries,
    tablesTouched: () => [...new Set(queries.map((q) => q.table))],
    queriesTo: (table: string) => queries.filter((q) => q.table === table),
  };
}
