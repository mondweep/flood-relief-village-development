import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A `vi.fn()`-backed stand-in for SupabaseClient. It records every schema,
 * table, operation, filter, ordering and payload the adapter produces, and
 * answers selects from an in-memory table map — no network, no live database.
 *
 * The schema is recorded because it is silently wrong by default: a real
 * SupabaseClient that is never told `.schema(...)` resolves `.from(t)` against
 * `public`, which in this shared project belongs to other applications. The
 * fake reproduces that exactly — a bare `.from()` is tagged
 * DEFAULT_CLIENT_SCHEMA — so an adapter that drops the schema selection shows
 * up as `public` in the recorded calls instead of passing unnoticed.
 */

export type FakeOperation = "select" | "upsert" | "insert" | "delete";

/** What `.from()` resolves against when no schema was selected, as in supabase-js. */
export const DEFAULT_CLIENT_SCHEMA = "public";

export interface FakeFilter {
  type: "eq" | "in";
  column: string;
  value: unknown;
}

export interface FakeOrder {
  column: string;
  ascending: boolean;
}

export interface FakeCall {
  /** Schema this call resolved against; DEFAULT_CLIENT_SCHEMA if none was selected. */
  schema: string;
  table: string;
  operation: FakeOperation;
  filters: FakeFilter[];
  orders: FakeOrder[];
  payload: unknown;
  single: boolean;
}

export type FakeRow = Record<string, unknown>;

export interface FakeSupabaseOptions {
  /** Seed rows per table name; selects are answered from here. */
  tables?: Record<string, FakeRow[]>;
  /** Make one table/operation pair fail, as Postgres would. */
  failOn?: { table: string; operation: FakeOperation; message?: string };
}

export interface FakeSupabase {
  client: SupabaseClient;
  calls: FakeCall[];
  from: ReturnType<typeof vi.fn>;
  /** Records each `client.schema(name)` selection, in call order. */
  schema: ReturnType<typeof vi.fn>;
  /** Every recorded call to a table, optionally narrowed to one operation. */
  callsTo(table: string, operation?: FakeOperation): FakeCall[];
  /** The single recorded call to a table/operation pair; fails loudly otherwise. */
  callTo(table: string, operation: FakeOperation): FakeCall;
  /** Distinct schemas every recorded query resolved against, in first-use order. */
  schemasUsed(): string[];
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function matches(row: FakeRow, filters: readonly FakeFilter[]): boolean {
  return filters.every((filter) =>
    filter.type === "eq"
      ? row[filter.column] === filter.value
      : Array.isArray(filter.value) && filter.value.includes(row[filter.column]),
  );
}

function respond(
  call: FakeCall,
  options: FakeSupabaseOptions,
): { data: unknown; error: { message: string } | null } {
  const failOn = options.failOn;
  if (failOn && failOn.table === call.table && failOn.operation === call.operation) {
    return { data: null, error: { message: failOn.message ?? "simulated postgres failure" } };
  }
  if (call.operation !== "select") return { data: null, error: null };

  const rows = (options.tables?.[call.table] ?? []).filter((row) => matches(row, call.filters));
  for (const order of [...call.orders].reverse()) {
    rows.sort(
      (a, b) => compare(a[order.column], b[order.column]) * (order.ascending ? 1 : -1),
    );
  }
  if (call.single) return { data: rows[0] ?? null, error: null };
  return { data: rows, error: null };
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const calls: FakeCall[] = [];

  const fromIn = (schema: string) => vi.fn((table: string) => {
    const call: FakeCall = {
      schema,
      table,
      operation: "select",
      filters: [],
      orders: [],
      payload: undefined,
      single: false,
    };
    calls.push(call);

    const builder = {
      select: vi.fn((_columns?: string) => {
        call.operation = "select";
        return builder;
      }),
      upsert: vi.fn((payload: unknown) => {
        call.operation = "upsert";
        call.payload = payload;
        return builder;
      }),
      insert: vi.fn((payload: unknown) => {
        call.operation = "insert";
        call.payload = payload;
        return builder;
      }),
      delete: vi.fn(() => {
        call.operation = "delete";
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        call.filters.push({ type: "eq", column, value });
        return builder;
      }),
      in: vi.fn((column: string, value: unknown) => {
        call.filters.push({ type: "in", column, value });
        return builder;
      }),
      order: vi.fn((column: string, opts?: { ascending?: boolean }) => {
        call.orders.push({ column, ascending: opts?.ascending ?? true });
        return builder;
      }),
      maybeSingle: vi.fn(() => {
        call.single = true;
        return Promise.resolve(respond(call, options));
      }),
      then: (
        onFulfilled: (value: { data: unknown; error: { message: string } | null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(respond(call, options)).then(onFulfilled, onRejected),
    };

    return builder;
  });

  // Bare `.from()` — no schema selected — behaves like supabase-js and lands in
  // `public`, so a regressed adapter is visible rather than silently accepted.
  const from = fromIn(DEFAULT_CLIENT_SCHEMA);
  const schema = vi.fn((name: string) => ({ from: fromIn(name) }));

  const callsTo = (table: string, operation?: FakeOperation): FakeCall[] =>
    calls.filter((c) => c.table === table && (operation === undefined || c.operation === operation));

  const callTo = (table: string, operation: FakeOperation): FakeCall => {
    const found = callsTo(table, operation);
    if (found.length !== 1) {
      throw new Error(
        `expected exactly one ${operation} on ${table}, got ${found.length} ` +
          `(recorded: ${calls.map((c) => `${c.operation} ${c.table}`).join(", ")})`,
      );
    }
    return found[0] as FakeCall;
  };

  return {
    client: { from, schema } as unknown as SupabaseClient,
    calls,
    from,
    schema,
    callsTo,
    callTo,
    schemasUsed: () => [...new Set(calls.map((c) => c.schema))],
  };
}
