import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  endpoint: vi.fn<(endpoint: string) => void>(),
  state: vi.fn<() => unknown>(),
  alive: vi.fn<(pid: number) => boolean>(),
  request: vi.fn(),
}));

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync(
      file: Parameters<typeof fs.readFileSync>[0],
      options?: Parameters<typeof fs.readFileSync>[1],
    ) {
      if (typeof file === 'string' && file.endsWith(join('resident-fixture', 'session.json')))
        return JSON.stringify(fake.state());
      return fs.readFileSync(file, options);
    },
  };
});

vi.mock('../backend-lifetime.js', () => ({
  backendStateDirectory: () => resolve('resident-fixture'),
  processAlive: fake.alive,
}));

vi.mock('ws', () => ({
  WebSocket: class {
    constructor(url: string) {
      fake.endpoint(new URL(url).origin);
    }
    terminate() {}
  },
}));

vi.mock('@forgeax/engine-host/transport', () => ({
  createHostWebSocketClient: async () => ({ request: fake.request, close() {} }),
}));

import { ensureDevKitView, startDevKitBackend, stopDevKitBackend } from '../backend-process.js';

const root = resolve('resident-fixture');

beforeEach(() => {
  vi.resetAllMocks();
  fake.request.mockResolvedValue({ root, phase: 'ready' });
});

it('stops the admitted owner while the state file moves to its successor', async () => {
  const incumbent = {
    root,
    id: 'incumbent',
    pid: 100,
    phase: 'ready',
    endpoint: 'ws://127.0.0.1:18001',
    token: 'incumbent-token',
  };
  fake.state.mockReturnValueOnce(incumbent).mockReturnValue({
    ...incumbent,
    id: 'successor',
    pid: 200,
    endpoint: 'ws://127.0.0.1:18002',
    token: 'successor-token',
  });
  fake.alive.mockReturnValue(true);

  await expect(stopDevKitBackend(root)).resolves.toEqual({ root, phase: 'stopped' });
  expect(fake.endpoint.mock.calls).toEqual([['ws://127.0.0.1:18001']]);
  expect(fake.request).toHaveBeenCalledExactlyOnceWith(
    'engine.backend.stop',
    undefined,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('follows a live claim when the launcher hands its identity to the daemon', async () => {
  const launcher = { root, id: 'shared-claim', pid: 100, phase: 'starting' };
  const daemon = { ...launcher, pid: 200 };
  let launcherAlive = true;
  fake.alive.mockImplementation(
    (pid) => pid === daemon.pid || (pid === launcher.pid && launcherAlive),
  );
  fake.state
    .mockReturnValueOnce(launcher)
    .mockImplementationOnce(() => {
      launcherAlive = false;
      return daemon;
    })
    .mockReturnValueOnce(daemon)
    .mockReturnValueOnce(daemon)
    .mockReturnValue({
      ...daemon,
      phase: 'ready',
      endpoint: 'ws://127.0.0.1:18002',
      token: 'daemon-token',
    });

  await expect(startDevKitBackend(root, { startupTimeoutMs: 1000 })).resolves.toMatchObject({
    phase: 'ready',
    pid: daemon.pid,
  });
});

it('admits the ready backend before dispatching View startup after early shell publication', async () => {
  const hostPack = realpathSync('package.json');
  const viewUrl = 'http://127.0.0.1:18003/';
  const starting = { root, hostPack, viewUrl, id: 'view-claim', pid: 200, phase: 'starting' };
  const ready = {
    ...starting,
    phase: 'ready',
    endpoint: 'ws://127.0.0.1:18002',
    token: 'view-token',
  };
  fake.state.mockReturnValue(starting);
  fake.alive.mockReturnValue(true);
  fake.request.mockResolvedValueOnce({ root, hostPack, phase: 'ready' }).mockResolvedValue({
    outcome: 'succeeded',
    result: { viewUrl },
  });

  vi.useFakeTimers();
  try {
    const pending = ensureDevKitView(root, { hostPack, startupTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.request).not.toHaveBeenCalled();
    fake.state.mockReturnValue(ready);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      value: { backend: { phase: 'ready', viewUrl }, view: { viewUrl } },
    });
  } finally {
    vi.useRealTimers();
  }
  expect(fake.request.mock.calls.map(([service]) => service)).toEqual([
    'engine.backend.status',
    'engine.backend.call',
  ]);
  expect(fake.request).toHaveBeenLastCalledWith(
    'engine.backend.call',
    { operation: 'view.start', args: { root } },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
