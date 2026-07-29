import type { AddressInfo } from "node:net";
import { SequentialIdGenerator } from "@afrip/shared-kernel";
import { API_VERSION, createServer, type ApiConfig } from "../src/server.js";
import type { AuthGate } from "../src/auth.js";
import { DEFAULT_AUTH_PROVIDERS, DEFAULT_SUPABASE_SCHEMA } from "../src/config.js";
import { createMemoryRuntime, type PlatformRuntime } from "../src/persistence.js";

export interface TestServer {
  readonly baseUrl: string;
  readonly config: ApiConfig;
  request(path: string, init?: RequestInit & { token?: string }): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/**
 * `authJwt` defaults OFF rather than following `supabaseUrl` the way `loadConfig`
 * does. A test that wires the Supabase storage tier is testing storage, and
 * making it also demand a signed JWT on every request would couple two
 * unrelated concerns. Tests that mean to exercise the identity gate turn it on
 * explicitly — see auth-jwt.test.ts.
 */
export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    port: 0,
    apiToken: null,
    persistence: "memory",
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
    supabasePublishableKey: null,
    supabaseJwtSecret: null,
    authJwt: false,
    authProviders: DEFAULT_AUTH_PROVIDERS,
    supabaseSchema: DEFAULT_SUPABASE_SCHEMA,
    version: API_VERSION,
    ...overrides,
  };
}

/**
 * Boots the real HTTP server on an ephemeral port, in-memory backed.
 *
 * Ids are seeded with `SequentialIdGenerator` — a test-only fake — so routes
 * keep returning deterministic ids like `village-1` for tests to assert
 * against. Production's default (`createPlatform`'s own default, wired
 * through `createMemoryRuntime`/`createPersistence`) is `RandomIdGenerator`;
 * this override exists only here; see the incident note on
 * `createPlatform` in packages/platform/src/composition-root.ts.
 */
export async function startTestServer(
  overrides: Partial<ApiConfig> = {},
  auth?: AuthGate,
): Promise<TestServer> {
  return startTestServerWith({
    config: testConfig(overrides),
    runtime: createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
    auth,
  });
}

export interface TestServerDeps {
  readonly config: ApiConfig;
  readonly runtime: PlatformRuntime;
  /** Identity gate seam — supplied by tests that drive JWT verification. */
  readonly auth?: AuthGate;
}

/**
 * Same boot, but with the storage tier supplied — the seam the Supabase-mode
 * tests use to drive a real HTTP server over a stubbed client.
 */
export async function startTestServerWith(deps: TestServerDeps): Promise<TestServer> {
  const { config, runtime, auth } = deps;
  const server = createServer({ config, runtime, auth });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    config,
    async request(path, init = {}) {
      const { token, headers, ...rest } = init;
      const response = await fetch(`${baseUrl}${path}`, {
        ...rest,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(rest.body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
      };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

export const VILLAGE_BODY = {
  name: "Rampur",
  district: "Darbhanga",
  state: "Bihar",
  geo: { lat: 26.15, lng: 85.9 },
  population: 1200,
  households: 260,
  affectedFamilies: 190,
  severity: "severe",
};

export function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

/** Narrows an unknown response body to an object so tests can read fields. */
export function record(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) throw new Error(`expected object body, got ${String(body)}`);
  return body as Record<string, unknown>;
}
