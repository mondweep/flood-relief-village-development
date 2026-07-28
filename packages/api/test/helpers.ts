import type { AddressInfo } from "node:net";
import { API_VERSION, createServer, type ApiConfig } from "../src/server.js";
import { createMemoryRuntime, type PlatformRuntime } from "../src/persistence.js";

export interface TestServer {
  readonly baseUrl: string;
  readonly config: ApiConfig;
  request(path: string, init?: RequestInit & { token?: string }): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    port: 0,
    apiToken: null,
    persistence: "memory",
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
    version: API_VERSION,
    ...overrides,
  };
}

/** Boots the real HTTP server on an ephemeral port, in-memory backed. */
export async function startTestServer(overrides: Partial<ApiConfig> = {}): Promise<TestServer> {
  return startTestServerWith({ config: testConfig(overrides), runtime: createMemoryRuntime() });
}

export interface TestServerDeps {
  readonly config: ApiConfig;
  readonly runtime: PlatformRuntime;
}

/**
 * Same boot, but with the storage tier supplied — the seam the Supabase-mode
 * tests use to drive a real HTTP server over a stubbed client.
 */
export async function startTestServerWith(deps: TestServerDeps): Promise<TestServer> {
  const { config, runtime } = deps;
  const server = createServer({ config, runtime });

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
