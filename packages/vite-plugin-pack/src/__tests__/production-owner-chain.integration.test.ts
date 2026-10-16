import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

interface MiddlewareServer {
  middlewares: { use(handler: Middleware): void };
  ws: { send(payload: { type: string } & Record<string, unknown>): void };
}

type Middleware = (
  req: { url?: string; method?: string },
  res: RecordedResponse & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

function createServer(): MiddlewareServer & { handler?: Middleware } {
  const server: MiddlewareServer & { handler?: Middleware } = {
    middlewares: {
      use(handler) {
        server.handler = handler;
      },
    },
    ws: { send() {} },
  };
  return server;
}

async function request(server: MiddlewareServer & { handler?: Middleware }, url: string) {
  const response: RecordedResponse = { statusCode: 200, headers: {}, body: undefined };
  const handler = server.handler;
  if (handler === undefined) throw new Error('plugin middleware was not registered');
  await handler(
    { url, method: 'GET' },
    {
      headers: response.headers,
      body: response.body,
      get statusCode() {
        return response.statusCode;
      },
      set statusCode(value: number) {
        response.statusCode = value;
      },
      setHeader(name, value) {
        response.headers[name] = value;
      },
      end(body) {
        response.body = body;
      },
    },
    () => {},
  );
  return response;
}

describe('plugin production owner chain', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('uses the public Vite lifecycle for inventory, publication, routes, and close', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'forgeax-plugin-owner-chain-'));
    const ddcRoot = await mkdtemp(join(tmpdir(), 'forgeax-plugin-owner-ddc-'));
    roots.push(sourceRoot, ddcRoot);
    const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
    await writeFile(
      join(sourceRoot, 'hero.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{ guid, kind: 'texture', sourceKey: 'hero/albedo', payload: {}, refs: [] }],
      }),
    );

    const server = createServer();
    const plugin = createPluginPackInternal({
      roots: [sourceRoot],
      ddc: { projectDdcRoot: ddcRoot },
    });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('owner-chain');
    await plugin.rebind(binding, [sourceRoot]);

    const response = await request(server, binding.catalogUrl);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(String(response.body)) as {
      readonly entries: readonly { readonly guid: string }[];
    };
    expect(body.entries.map((entry) => entry.guid.toLowerCase())).toContain(guid);

    await plugin.closeBundle();
    const closed = await request(server, binding.catalogUrl);
    expect(closed.statusCode).toBe(410);
  });
});
