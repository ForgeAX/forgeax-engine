import { type ChildProcess, spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const daemonFixture = vi.hoisted(() => ({
  entry: undefined as string | undefined,
  children: [] as ChildProcess[],
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (
      command: string,
      args: string[],
      options: import('node:child_process').SpawnOptions,
    ) => {
      const entry = args[1] === '--__forgeax-live-daemon' ? daemonFixture.entry : undefined;
      const child = original.spawn(
        command,
        entry === undefined ? args : [entry, ...args.slice(1)],
        options,
      );
      if (entry !== undefined) daemonFixture.children.push(child);
      return child;
    },
  };
});

import { currentLiveDevBuild, liveDevControl, startLiveDev } from '../live-dev.js';
import { runUnifiedCli } from '../unified-cli.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const child of daemonFixture.children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  }
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

async function endpoint(root: string, response: unknown, record: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  await mkdir(join(root, '.forgeax'), { recursive: true });
  await writeFile(
    join(root, '.forgeax/dev-session.json'),
    JSON.stringify({
      root,
      endpoint: `http://127.0.0.1:${address.port}`,
      pid: process.pid,
      build: await currentLiveDevBuild(),
      ...record,
    }),
  );
  return requests;
}

/** A detached fixture owner that records this DevKit build, like a real owner. */
async function readyDaemon(root: string, revision: string) {
  const entry = join(root, 'daemon.mjs');
  await writeFile(
    entry,
    `
      import { createServer } from 'node:http';
      import { mkdir, writeFile } from 'node:fs/promises';
      const root = process.argv[3], port = Number(process.argv[4]);
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/stop') { res.end('{"ok":true,"value":{"phase":"stopped"}}'); server.close(() => process.exit(0)); return; }
        res.end(JSON.stringify({ ok: true, value: { phase: 'ready', revision: ${JSON.stringify(revision)}, pid: process.pid } }));
      });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
      await mkdir(root + '/.forgeax', { recursive: true });
      await writeFile(root + '/.forgeax/dev-session.json', JSON.stringify({
        root, endpoint: 'http://127.0.0.1:' + port, pid: process.pid,
        build: ${JSON.stringify(await currentLiveDevBuild())},
      }));
      setTimeout(() => process.exit(1), 20000).unref();
    `,
  );
  daemonFixture.entry = entry;
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

  it('honors the project startup deadline while a real detached owner remains waiting', async () => {
    const root = await project();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'live-test', type: 'module', forgeax: { startupTimeoutMs: 500 } }),
    );
    const entry = join(root, 'daemon.mjs');
    await writeFile(
      entry,
      `
      import { createServer } from 'node:http';
      import { mkdir, writeFile } from 'node:fs/promises';
      const root = process.argv[3], port = Number(process.argv[4]);
      await new Promise(resolve => setTimeout(resolve, 5000));
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/stop') { res.end('{}'); server.close(() => process.exit(0)); return; }
        res.end(JSON.stringify({ ok: true, value: { phase: 'waiting', pid: process.pid } }));
      });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
      await mkdir(root + '/.forgeax', { recursive: true });
      await writeFile(root + '/.forgeax/dev-session.json', JSON.stringify({ root, endpoint: 'http://127.0.0.1:' + port, pid: process.pid }));
    `,
    );
    daemonFixture.entry = entry;
    try {
      expect(await startLiveDev(root)).toMatchObject({
        ok: false,
        error: { code: 'live-start-timeout' },
      });
      const pid = daemonFixture.children.at(-1)?.pid;
      if (pid === undefined) throw new Error('Missing detached fixture owner');
      expect(() => process.kill(pid, 0)).not.toThrow();
      await expect(readFile(join(root, '.forgeax/dev-session.json'), 'utf8')).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      );
    } finally {
      daemonFixture.entry = undefined;
    }
  }, 3_000);

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
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'live-test', type: 'module', forgeax: { startupTimeoutMs: 300 } }),
    );
    await endpoint(root, { ok: true, value: { phase: 'waiting', error: 'App bootstrap failed' } });
    expect(await runUnifiedCli(['dev', 'start', '--root', root])).toMatchObject({
      ok: false,
      error: { code: 'live-not-ready' },
    });
  });

  it('waits for an existing owner to finish replacing its runtime', async () => {
    const root = await project();
    let polls = 0;
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: true,
          value: { phase: ++polls < 4 ? 'reloading' : 'ready', revision: 'after-edit' },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(
      join(root, '.forgeax/dev-session.json'),
      JSON.stringify({
        root,
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        pid: process.pid,
        build: await currentLiveDevBuild(),
      }),
    );
    expect(await runUnifiedCli(['dev', 'start', '--root', root])).toMatchObject({
      ok: true,
      value: { phase: 'ready', revision: 'after-edit' },
    });
    expect(polls).toBe(4);
  });

  it.each([
    ['backend', ['--backend', 'hardware']],
    ['rhiCapture', ['--rhi-capture']],
    ['headless', ['--headless']],
  ] as const)('replaces an owner whose %s differs from the request', async (_name, flags) => {
    const root = await project();
    const requests = await endpoint(
      root,
      { ok: true, value: { phase: 'ready', revision: 'old-owner' } },
      {
        options: {
          headless: false,
          backend: 'software',
          rhiCapture: false,
          workers: {},
          animation: {},
        },
      },
    );
    await readyDaemon(root, 'new-owner');
    try {
      expect(await runUnifiedCli(['dev', 'start', '--root', root, ...flags])).toMatchObject({
        ok: true,
        value: { phase: 'ready', revision: 'new-owner' },
      });
      expect(requests).toContain('/stop');
      expect(daemonFixture.children).toHaveLength(1);
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('reuses a healthy owner of this build with the requested options', async () => {
    const root = await project();
    const requests = await endpoint(
      root,
      { ok: true, value: { phase: 'ready', revision: 'kept' } },
      {
        options: {
          headless: true,
          backend: 'auto',
          rhiCapture: true,
          workers: {},
          animation: {},
        },
      },
    );
    expect(
      await runUnifiedCli(['dev', 'start', '--root', root, '--headless', '--rhi-capture']),
    ).toMatchObject({ ok: true, value: { phase: 'ready', revision: 'kept' } });
    expect(requests).not.toContain('/stop');
    expect(daemonFixture.children).toHaveLength(0);
  });

  it('replaces an owner recorded by another DevKit build', async () => {
    const root = await project();
    const requests = await endpoint(
      root,
      { ok: true, value: { phase: 'ready', revision: 'old-build' } },
      { build: 'another-build' },
    );
    await readyDaemon(root, 'this-build');
    try {
      expect(await startLiveDev(root)).toMatchObject({
        ok: true,
        value: { phase: 'ready', revision: 'this-build' },
      });
      expect(requests).toContain('/stop');
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('replaces a failed owner instead of reporting its old failure', async () => {
    const root = await project();
    await endpoint(root, { ok: true, value: { phase: 'failed', error: 'old failure' } });
    await readyDaemon(root, 'retried');
    try {
      expect(await startLiveDev(root)).toMatchObject({
        ok: true,
        value: { phase: 'ready', revision: 'retried' },
      });
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it.each([
    ['a dead owner', JSON.stringify({ endpoint: 'http://127.0.0.1:1', pid: 2147483647 })],
    ['a truncated record', '{"root":"/x","endpoint":"http://127.0.0.1:'],
    ['an empty record', ''],
  ])('starts over %s left by a crash', async (_name, contents) => {
    const root = await project();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(join(root, '.forgeax/dev-session.json'), contents);
    await readyDaemon(root, 'after-crash');
    try {
      expect(await startLiveDev(root)).toMatchObject({
        ok: true,
        value: { phase: 'ready', revision: 'after-crash' },
      });
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('converges parallel starts on one owner', async () => {
    const root = await project();
    await readyDaemon(root, 'single');
    try {
      const results = await Promise.all([
        startLiveDev(root),
        startLiveDev(root),
        startLiveDev(root),
      ]);
      for (const result of results)
        expect(result).toMatchObject({ ok: true, value: { phase: 'ready', revision: 'single' } });
      expect(daemonFixture.children).toHaveLength(1);
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('removes a stale start lock left by a crashed caller', async () => {
    const root = await project();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(join(root, '.forgeax/dev-start.lock'), JSON.stringify({ pid: 2147483647 }));
    await readyDaemon(root, 'unlocked');
    try {
      expect(await startLiveDev(root)).toMatchObject({ ok: true, value: { phase: 'ready' } });
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('terminates an unresponsive owner of this project on start and on stop', async () => {
    for (const operation of ['start', 'stop'] as const) {
      const root = await project();
      const entry = join(root, 'hung.mjs');
      await writeFile(
        entry,
        `
        import { createServer } from 'node:http';
        // Accepts connections and never answers, like an owner stuck in a long call.
        createServer(() => {}).listen(Number(process.argv[4]), '127.0.0.1');
      `,
      );
      const { createServer: probe } = await import('node:net');
      const port = await new Promise<number>((resolve) => {
        const server = probe().listen(0, '127.0.0.1', () => {
          const { port } = server.address() as { port: number };
          server.close(() => resolve(port));
        });
      });
      const hung = spawnProcess(
        process.execPath,
        [entry, '--__forgeax-live-daemon', root, String(port), 'live'],
        { stdio: 'ignore' },
      );
      daemonFixture.children.push(hung);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await mkdir(join(root, '.forgeax'), { recursive: true });
      await writeFile(
        join(root, '.forgeax/dev-session.json'),
        JSON.stringify({
          root,
          endpoint: `http://127.0.0.1:${port}`,
          pid: hung.pid,
          build: await currentLiveDevBuild(),
        }),
      );
      const exited = once(hung, 'exit');
      if (operation === 'start') {
        await readyDaemon(root, 'recovered');
        try {
          expect(await startLiveDev(root)).toMatchObject({
            ok: true,
            value: { phase: 'ready', revision: 'recovered' },
          });
        } finally {
          daemonFixture.entry = undefined;
        }
      } else {
        expect(await liveDevControl(root, 'stop')).toMatchObject({
          ok: true,
          value: { phase: 'stopped' },
        });
        await expect(readFile(join(root, '.forgeax/dev-session.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      await exited;
    }
  }, 60_000);

  it.each([
    'look',
    'capture',
    'verify',
    'eval',
  ] as const)('starts an owner on demand for %s and sends the request once', async (operation) => {
    const root = await project();
    await readyDaemon(root, 'on-demand');
    try {
      expect(await liveDevControl(root, operation, {})).toMatchObject({
        ok: true,
        value: { phase: 'ready', revision: 'on-demand' },
      });
      expect(daemonFixture.children).toHaveLength(1);
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('starts on demand over a record left by a dead owner', async () => {
    const root = await project();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(
      join(root, '.forgeax/dev-session.json'),
      JSON.stringify({ root, endpoint: 'http://127.0.0.1:1', pid: 2147483647 }),
    );
    await readyDaemon(root, 'replaced');
    try {
      expect(await liveDevControl(root, 'look', {})).toMatchObject({
        ok: true,
        value: { revision: 'replaced' },
      });
    } finally {
      daemonFixture.entry = undefined;
    }
  });

  it('returns the structured start failure when an on-demand start fails', async () => {
    const root = await project();
    await writeFile(join(root, 'package.json'), '[]');
    expect(await liveDevControl(root, 'capture', {})).toMatchObject({
      ok: false,
      error: { code: 'package-manifest-invalid' },
    });
    expect(daemonFixture.children).toHaveLength(0);
  });

  it('does not start an owner for controls that change or query owner state', async () => {
    const root = await project();
    for (const operation of ['find', 'focus', 'camera/set'] as const)
      expect(await liveDevControl(root, operation, {})).toMatchObject({
        ok: false,
        error: { code: 'live-not-running' },
      });
    expect(daemonFixture.children).toHaveLength(0);
  });

  it('never signals a recorded pid that is not this project owner', async () => {
    const root = await project();
    const unrelated = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
    });
    daemonFixture.children.push(unrelated);
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(
      join(root, '.forgeax/dev-session.json'),
      JSON.stringify({ root, endpoint: 'http://127.0.0.1:1', pid: unrelated.pid }),
    );
    expect(await liveDevControl(root, 'stop')).toMatchObject({
      ok: true,
      value: { phase: 'stopped' },
    });
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
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
