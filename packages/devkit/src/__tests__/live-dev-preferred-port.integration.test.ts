import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createTcpServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeViteDevPort } from '../host.js';
import { startOnPreferredPort } from '../live-dev.js';
import { commandError } from '../project.js';
import { type CommandResult, resolveProjectPort } from '../types.js';

const servers: ViteDevServer[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const blocker of blockers.splice(0))
    await new Promise<void>((done) => blocker.close(() => done()));
});

async function listenLoopback(port: number): Promise<Server> {
  const server = createTcpServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => done());
  });
  blockers.push(server);
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

describe('live project preferred port', () => {
  // The same port resolution as the project child: a non-zero port is strict.
  const startVite = (root: string) =>
    vi.fn(async (port: number): Promise<CommandResult<{ readonly port: number }>> => {
      const resolved = resolveProjectPort(port);
      const server = await createViteServer({
        configFile: false,
        root,
        logLevel: 'silent',
        server: {
          host: '127.0.0.1',
          port: await materializeViteDevPort(resolved.port),
          strictPort: resolved.strictPort,
          hmr: false,
          watch: null,
        },
      });
      try {
        await server.listen();
      } catch (cause) {
        await server.close();
        // The same projection as startDevProjectWithHost's listen failure.
        return { ok: false, error: commandError(cause, 'dev-server-failed') };
      }
      servers.push(server);
      const address = server.httpServer?.address();
      return {
        ok: true,
        value: { port: typeof address === 'object' && address ? address.port : 0 },
      };
    });

  it('falls back to an OS-assigned port when another listener took the reused one', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-preferred-port-'));
    try {
      const taken = portOf(await listenLoopback(0));
      const start = startVite(root);
      const result = await startOnPreferredPort(taken, start);
      expect(start).toHaveBeenCalledTimes(2);
      const strict = await start.mock.results[0]?.value;
      expect(strict).toMatchObject({ ok: false });
      expect(strict?.ok === false && strict.error.detail).toEqual({
        reason: `Port ${taken} is already in use`,
      });
      expect(start.mock.calls.map(([port]) => port)).toEqual([taken, 0]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.port).not.toBe(taken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds the reused port when free and keeps unrelated failures', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-preferred-port-'));
    try {
      const reserved = await listenLoopback(0);
      const free = portOf(reserved);
      await new Promise<void>((done) => reserved.close(() => done()));
      blockers.splice(blockers.indexOf(reserved), 1);
      const start = startVite(root);
      const result = await startOnPreferredPort(free, start);
      expect(result).toEqual({ ok: true, value: { port: free } });
      expect(start).toHaveBeenCalledTimes(1);

      const failure = {
        ok: false as const,
        error: { code: 'dev-server-failed', expected: 'build', hint: 'syntax', detail: {} },
      };
      for (const server of servers.splice(0)) await server.close();
      const failing = vi.fn(async () => failure);
      expect(await startOnPreferredPort(free, failing)).toBe(failure);
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not retry a non-port failure while another process holds the port', async () => {
    const taken = portOf(await listenLoopback(0));
    const failure = {
      ok: false as const,
      error: commandError(new Error('plugin forgeax:pack failed to load'), 'dev-server-failed'),
    };
    const failing = vi.fn(async (_port: number) => failure);
    expect(await startOnPreferredPort(taken, failing)).toBe(failure);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
