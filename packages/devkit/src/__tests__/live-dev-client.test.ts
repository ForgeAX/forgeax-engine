import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const daemonFixture = vi.hoisted(() => ({ entry: undefined as string | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) =>
      original.spawn(
        command,
        daemonFixture.entry && args[1] === '--__forgeax-live-daemon'
          ? [daemonFixture.entry, ...args.slice(1)]
          : args,
        options,
      ),
  };
});

import { startLiveDev } from '../live-dev.js';
import { runUnifiedCli } from '../unified-cli.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-live-client-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({ schemaVersion: '3.0.0', id: 'live-test', name: 'Live test', roots: {} }),
  );
  await writeFile(join(root, 'package.json'), '{"name":"live-test","type":"module"}');
  return root;
}

async function endpoint(root: string, response: unknown) {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  await mkdir(join(root, '.forgeax'), { recursive: true });
  await writeFile(
    join(root, '.forgeax/dev-session.json'),
    JSON.stringify({ root, endpoint: `http://127.0.0.1:${address.port}`, pid: process.pid }),
  );
}

describe('live command transport', () => {
  it.each([
    'ready',
    'failed',
    'replaced',
    'disconnected',
  ] as const)('retains startup ownership after a status timeout: %s', async (scenario) => {
    const root = await project();
    const entry = join(root, 'daemon.mjs');
    await writeFile(
      entry,
      `
      import { createServer } from 'node:http';
      import { mkdir, writeFile } from 'node:fs/promises';
      const root = process.argv[3], port = Number(process.argv[4]);
      const scenario = ${JSON.stringify(scenario)};
      let polls = 0;
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/stop') {
          res.end('{}'); server.close(() => process.exit(0)); return;
        }
        if (++polls === 1) {
          if (scenario === 'disconnected') req.socket.destroy();
          return;
        }
        res.end(JSON.stringify({ ok: true, value: {
          phase: scenario === 'failed' ? 'failed' : 'ready',
          error: scenario === 'failed' ? 'fixture-startup-failed' : undefined,
          revision: 'after-status-timeout', polls,
        } }));
      });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
      await mkdir(root + '/.forgeax', { recursive: true });
      await writeFile(root + '/.forgeax/dev-session.json', JSON.stringify({
        root, endpoint: 'http://127.0.0.1:' + port,
        pid: scenario === 'replaced' ? process.pid + 1000000 : process.pid,
      }));
      setTimeout(() => process.exit(1), 12000).unref();
    `,
    );
    cleanup.push(async () => {
      const session = JSON.parse(await readFile(join(root, '.forgeax/dev-session.json'), 'utf8'));
      await fetch(`${session.endpoint}/stop`, { method: 'POST' });
    });
    daemonFixture.entry = entry;
    try {
      const startedAt = Date.now();
      const result = await startLiveDev(root);
      // The endpoint can answer after a timeout without making every failure recoverable.
      expect(await runUnifiedCli(['dev', 'status', '--root', root])).toMatchObject({
        ok: true,
        value: {
          phase: scenario === 'failed' ? 'failed' : 'ready',
          revision: 'after-status-timeout',
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      if (scenario === 'ready')
        expect(result).toMatchObject({
          ok: true,
          value: { phase: 'ready', revision: 'after-status-timeout' },
        });
      else
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: 'live-not-ready',
            ...(scenario === 'failed' ? { hint: 'fixture-startup-failed' } : {}),
          },
        });
    } finally {
      daemonFixture.entry = undefined;
    }
  }, 15_000);

  it('waits for a newly spawned owner to advance from waiting to ready', async () => {
    const root = await project();
    const entry = join(root, 'daemon.mjs');
    await writeFile(
      entry,
      `
      import { createServer } from 'node:http';
      import { mkdir, writeFile } from 'node:fs/promises';
      const root = process.argv[3], port = Number(process.argv[4]);
      let polls = 0;
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/stop') {
          res.end('{}'); server.close(() => process.exit(0)); return;
        }
        res.end(JSON.stringify({ ok: true, value: {
          phase: ++polls < 3 ? 'waiting' : 'ready', revision: 'cold-start',
        } }));
      });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
      await mkdir(root + '/.forgeax', { recursive: true });
      await writeFile(root + '/.forgeax/dev-session.json', JSON.stringify({
        root, endpoint: 'http://127.0.0.1:' + port, pid: process.pid,
      }));
      setTimeout(() => process.exit(1), 10000).unref();
    `,
    );
    cleanup.push(async () => {
      const session = JSON.parse(await readFile(join(root, '.forgeax/dev-session.json'), 'utf8'));
      await fetch(`${session.endpoint}/stop`, { method: 'POST' });
    });
    daemonFixture.entry = entry;
    try {
      expect(await startLiveDev(root)).toMatchObject({
        ok: true,
        value: { phase: 'ready', revision: 'cold-start' },
      });
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('reports stopped with no owner, and makes repeated stop idempotent', async () => {
    const root = await project();
    for (const operation of ['status', 'stop', 'stop']) {
      expect(await runUnifiedCli(['dev', operation, '--root', root])).toMatchObject({
        ok: true,
        value: { phase: 'stopped' },
      });
    }
  });

  it('clears a stopped owner record after the recorded process has exited', async () => {
    const root = await project();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(
      join(root, '.forgeax/dev-session.json'),
      JSON.stringify({
        root,
        endpoint: 'http://127.0.0.1:1',
        pid: 2147483647,
      }),
    );
    expect(await runUnifiedCli(['dev', 'stop', '--root', root])).toMatchObject({
      ok: true,
      value: { phase: 'stopped' },
    });
    await expect(readFile(join(root, '.forgeax/dev-session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not nest a live status envelope', async () => {
    const root = await project();
    await endpoint(root, { ok: true, value: { phase: 'ready', revision: 'r1' } });
    expect(await runUnifiedCli(['dev', 'status', '--root', root])).toMatchObject({
      ok: true,
      value: { phase: 'ready', revision: 'r1' },
    });
  });

  it('does not claim startup succeeded when the owner cannot operate', async () => {
    const root = await project();
    await endpoint(root, { ok: true, value: { phase: 'waiting', error: 'App bootstrap failed' } });
    expect(await runUnifiedCli(['dev', 'start', '--root', root])).toMatchObject({
      ok: false,
      error: { code: 'live-not-ready' },
    });
  });

  it('rejects an explicit backend change on an existing owner', async () => {
    const root = await project();
    await endpoint(root, {
      ok: true,
      value: { phase: 'ready', backendRequested: 'software', backend: 'software' },
    });
    expect(
      await runUnifiedCli(['dev', 'start', '--root', root, '--backend', 'hardware']),
    ).toMatchObject({
      ok: false,
      error: { code: 'live-configuration-conflict' },
    });
  });

  it('propagates a live failure as a failed command', async () => {
    const root = await project();
    await endpoint(root, {
      ok: false,
      error: {
        code: 'live-revision-stale',
        hint: 'Read the current revision.',
        detail: { revision: 'new' },
      },
    });
    expect(
      await runUnifiedCli(['dev', 'camera', 'get', '--root', root, '--revision', 'old']),
    ).toMatchObject({
      ok: false,
      error: { code: 'live-revision-stale', detail: { revision: 'new' } },
    });
  });
});
