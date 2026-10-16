import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRhiDebugError } from '@forgeax/engine-rhi-debug';
import type { BrowserCaptureError } from '@forgeax/engine-rhi-debug/browser';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { serializeBridgeResult } from '../../../app/src/internal/browser-remote-bridge';
import type { BrowserCarrierAdapter } from '../tools/display-carrier.js';

const snapshotFixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../run-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../run-snapshot.js')>()),
  createRunSnapshot: snapshotFixture.create,
}));

const fixtures = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        const wrapped = (...args: unknown[]) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
          );
          listener(...args);
        };
        return this.on(event, wrapped);
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
        );
        return this;
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
        return true;
      },
      setEncoding() {
        return this;
      },
    };
  };
  const target = {
    leaseId: 'live-lease-1',
    targetId: 'live-target-1',
    kind: 'browser-page',
    surfaceId: 'live-surface-1',
    run: { serviceId: 'live-service-1', runId: 'live-run-1' },
    generation: 2,
    width: 1280,
    height: 720,
    gpu: 'hardware' as const,
  };
  const page = {
    waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async (): Promise<unknown> => undefined),
    bringToFront: vi.fn(async () => undefined),
  };
  const frame = {
    waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => '9'),
    waitForTimeout: vi.fn(async () => undefined),
  };
  const session = {
    page,
    execution: undefined as unknown,
    close: vi.fn(async () => undefined),
    report: vi.fn(() => ({
      backend: 'hardware' as const,
      carrier: 'borrowed' as 'borrowed' | 'private-browser',
      carrierTarget: target as typeof target | undefined,
      carrierFallbackReason: undefined as string | undefined,
      pageErrors: [],
    })),
  };
  const browser = {
    open: vi.fn(async (_options: unknown) => session),
    close: vi.fn(async () => undefined),
  };
  const child = Object.assign(emitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: emitter(),
    stderr: { pipe: vi.fn() },
    kill: vi.fn(),
  });
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = emitter();
  child.stderr = { pipe: vi.fn() };
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    return true;
  });
  const spawn = vi.fn((_command: string, args: readonly string[]) => {
    const generation = Number(args[3]);
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        `${JSON.stringify({ ready: true, generation, url: 'http://127.0.0.1:43124/' })}\n`,
      );
    });
    return child;
  });
  const createBrowserCapture = vi.fn(() => browser);
  const readLiveProjectInputs = vi.fn(async () => 'fixture-inputs');
  return {
    target,
    page,
    frame,
    session,
    browser,
    child,
    spawn,
    createBrowserCapture,
    readLiveProjectInputs,
  };
});

vi.mock('node:child_process', () => ({ spawn: fixtures.spawn }));
vi.mock('../software-capture.js', () => ({ createBrowserCapture: fixtures.createBrowserCapture }));
vi.mock('../live-project-inputs.js', () => ({
  readLiveProjectInputs: fixtures.readLiveProjectInputs,
}));

import { liveDevStatus, runLiveDevDaemon, startLiveDev } from '../live-dev.js';

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function request(port: number, path: string, method: 'GET' | 'POST'): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { connection: 'close' },
  });
  return response.json();
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.browser.open.mockImplementation(async () => fixtures.session);
  fixtures.session.report.mockImplementation(() => ({
    backend: 'hardware' as const,
    carrier: 'borrowed' as const,
    carrierTarget: fixtures.target,
    carrierFallbackReason: undefined,
    pageErrors: [],
  }));
});

describe('live DevKit borrowed carrier boundary', () => {
  it.each([
    false,
    true,
  ])('preserves recorder failures across the capture bridge (Worker clone: %s)', async (workerClone) => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-capture-error-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    let bridge: WebSocket | undefined;
    let failure = createRhiDebugError('capture-unavailable', {
      stage: 'capture',
      cause: 'Render Worker frame timed out',
    });
    let failCapture = true;
    const artifact = {
      kind: 'rhi-tape',
      digest: 'sha256:fixture',
      bytes: new Uint8Array([1, 2, 3]),
    };
    const uploadFailure: BrowserCaptureError = {
      code: 'browser-capture-upload-failed',
      expected: 'verified chunks committed',
      hint: 'inspect the transport response',
      detail: {
        endpoint: '/__forgeax-debug/tape',
        status: 409,
        stage: 'chunk',
        offset: 3,
        serverCode: 'chunk-rejected',
      },
    };
    let failUpload = true;
    const upload = vi.fn(async (_artifact: unknown, _options: unknown) =>
      failUpload ? err(uploadFailure) : ok({ kind: 'rhi-tape', digest: artifact.digest }),
    );
    const captureFrame = vi.fn(async () => (failCapture ? err(failure) : ok(artifact)));
    fixtures.page.evaluate.mockResolvedValue('2');
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      bridge = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      bridge.on('message', async (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== 'status' && message.type !== 'eval') return;
        const AsyncFunction = Object.getPrototypeOf(async () => {})
          .constructor as FunctionConstructor;
        const result: { ok: true; value: unknown } =
          message.type === 'status'
            ? { ok: true, value: { worldIdentity: 'capture-world' } }
            : {
                ok: true,
                value: await new AsyncFunction('rhiCapture', message.code)({
                  captureFrame,
                  upload,
                }),
              };
        const payload = serializeBridgeResult(workerClone ? structuredClone(result) : result);
        bridge?.send(JSON.stringify({ type: 'result', id: message.id, payload }));
      });
      await new Promise<void>((resolve, reject) => {
        bridge?.once('open', resolve);
        bridge?.once('error', reject);
      });
      await vi.waitFor(async () => {
        expect(await request(port, '/status', 'GET')).toMatchObject({
          ok: true,
          value: { phase: 'ready', bridgeConnected: true },
        });
      });
      expect(await request(port, '/rhi/capture', 'POST')).toEqual({ ok: false, error: failure });
      expect(captureFrame).toHaveBeenCalledExactlyOnceWith({ snapshotTimeoutMs: 120_000 });
      // A second failed request must be admitted after the first, with the
      // original producer detail and unchanged diagnostic budget.
      failure = createRhiDebugError('capture-unavailable', {
        stage: 'capture',
        cause: 'replacement worker unavailable',
      });
      expect(await request(port, '/rhi/capture', 'POST')).toEqual({ ok: false, error: failure });
      expect(captureFrame).toHaveBeenCalledTimes(2);
      expect(upload).not.toHaveBeenCalled();
      failCapture = false;
      expect(await request(port, '/rhi/capture', 'POST')).toEqual({
        ok: false,
        error: uploadFailure,
      });
      expect(upload.mock.calls[0]?.[0]).toBe(artifact);
      expect(upload.mock.calls[0]?.[1]).toMatchObject({
        runId: expect.stringMatching(/^live-rhi-/),
      });
      failUpload = false;
      expect(await request(port, '/rhi/capture', 'POST')).toMatchObject({
        ok: true,
        value: {
          kind: 'rhi-tape',
          digest: artifact.digest,
          source: 'live',
          runId: expect.stringMatching(/^live-rhi-/),
        },
      });
      expect(captureFrame).toHaveBeenCalledTimes(4);
      expect(upload).toHaveBeenCalledTimes(2);
    } finally {
      fixtures.page.evaluate.mockResolvedValue(undefined);
      bridge?.close();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forwards fresh Host execution reports through the public status route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-execution-status-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    let bridge: WebSocket | undefined;
    let execution = {
      frame: { submitted: 4, completed: 2, inFlight: 2 },
      render: { state: 'alive', completedFrame: 2 },
    };
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      bridge = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
      bridge.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'status')
          bridge?.send(
            JSON.stringify({
              type: 'result',
              id: message.id,
              payload: { ok: true, value: { worldIdentity: 'test-world', execution } },
            }),
          );
      });
      await new Promise<void>((resolve, reject) => {
        bridge?.once('open', resolve);
        bridge?.once('error', reject);
      });
      await vi.waitFor(async () => {
        expect(await request(port, '/status', 'GET')).toMatchObject({
          ok: true,
          value: { execution },
        });
      });
      execution = { ...execution, render: { state: 'failed', completedFrame: 2 } };
      await vi.waitFor(async () => {
        expect(await request(port, '/status', 'GET')).toMatchObject({
          ok: true,
          value: { execution },
        });
      });
    } finally {
      bridge?.close();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('composes the existing live owner in process and waits for host cancellation cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-in-process-'));
    const lifetime = new AbortController();
    let closed: Promise<void> | undefined;
    const carrier = {} as BrowserCarrierAdapter;
    try {
      const started = await startLiveDev(root, {
        headless: false,
        inProcess: {
          carrier,
          signal: lifetime.signal,
          onStart: (value) => {
            closed = value;
          },
        },
      });
      expect(started).toMatchObject({
        ok: false,
        error: {
          code: 'live-not-ready',
          detail: { status: { phase: 'waiting', pid: process.pid } },
        },
      });
      expect(fixtures.browser.open.mock.calls[0]?.[0]).toMatchObject({ carrier, headless: false });
      const ownerStarted = vi.fn();
      await startLiveDev(root, {
        headless: false,
        inProcess: { signal: lifetime.signal, onStart: ownerStarted },
      });
      expect(ownerStarted).not.toHaveBeenCalled();
      expect(fixtures.browser.open).toHaveBeenCalledOnce();
      lifetime.abort();
      await closed;
      expect(fixtures.session.close).toHaveBeenCalledOnce();
      expect(fixtures.browser.close).toHaveBeenCalledOnce();
      expect(await liveDevStatus(root)).toMatchObject({ ok: true, value: { phase: 'stopped' } });
    } finally {
      lifetime.abort();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns when stopped while the borrowed browser is still opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-stop-opening-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let finishOpen = () => {};
    const opening = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    fixtures.browser.open.mockImplementation(async () => {
      await opening;
      return fixtures.session;
    });
    let finished = false;
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    }).then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      await request(port, '/stop', 'POST');
      finishOpen();
      await vi.waitFor(() => expect(finished).toBe(true));
      await daemon;
      expect(fixtures.session.close).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      finishOpen();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the control owner stable while assigning the project child an ephemeral port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-carrier-'));
    const carrier = {} as BrowserCarrierAdapter;
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier,
      carrierRun: fixtures.target.run,
    });
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      const openOptions = fixtures.browser.open.mock.calls[0]?.[0];
      expect(openOptions).toMatchObject({
        carrier,
        carrierRun: fixtures.target.run,
        carrierGeneration: fixtures.target.generation,
        headless: false,
      });
      const projectArgs = fixtures.spawn.mock.calls[0]?.[1];
      expect(projectArgs).toEqual([
        expect.any(String),
        '--__forgeax-live-project',
        root,
        expect.any(String),
        '0',
      ]);
      const status = await request(port, '/status', 'GET');
      expect(status).toMatchObject({
        ok: true,
        value: {
          endpoint: `http://127.0.0.1:${port}`,
          pid: process.pid,
          carrier: 'borrowed',
          carrierTarget: fixtures.target,
          backend: 'hardware',
        },
      });
      expect(fixtures.page.bringToFront).not.toHaveBeenCalled();
      await request(port, '/stop', 'POST');
      await daemon;
      expect(fixtures.session.close).toHaveBeenCalled();
      expect(fixtures.browser.close).toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains foregrounding for the private-browser fallback', async () => {
    fixtures.session.report.mockReturnValueOnce({
      backend: 'hardware' as const,
      carrier: 'private-browser' as const,
      carrierTarget: undefined,
      carrierFallbackReason: 'display host did not admit the run',
      pageErrors: [],
    });
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-private-browser-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'));
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await vi.waitFor(() => expect(fixtures.page.bringToFront).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await request(port, '/stop', 'POST');
      await daemon;
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes the execution frame while keeping the owner page untouched', async () => {
    fixtures.session.execution = {
      kind: 'frame',
      ownerPage: fixtures.page,
      realm: fixtures.frame,
      surfaceSelector: '#display-frame',
    } as never;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-frame-'));
    const carrier = {} as BrowserCarrierAdapter;
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier,
      carrierRun: fixtures.target.run,
    });
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await vi.waitFor(() => expect(fixtures.frame.waitForFunction).toHaveBeenCalled(), {
        timeout: 5_000,
      });
      expect(fixtures.page.waitForFunction).not.toHaveBeenCalled();
      expect(fixtures.frame.evaluate).toHaveBeenCalled();
      expect(fixtures.page.evaluate).not.toHaveBeenCalled();
      await request(port, '/stop', 'POST');
      await daemon;
      expect(exit).not.toHaveBeenCalled();
    } finally {
      fixtures.session.execution = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('rejects a second snapshot owner and cleans a snapshot completed after startup cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-snapshot-cancel-'));
  const previous = process.env.FORGEAX_RUNS_DIR;
  process.env.FORGEAX_RUNS_DIR = join(directory, 'runs');
  const { runStateDirectory } = await import('../run-snapshot.js');
  const lifetime = new AbortController();
  let complete: (value: unknown) => void = () => {};
  snapshotFixture.create.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const dispose = vi.fn(async () => {});
  const daemon = runLiveDevDaemon(directory, await freePort(), undefined, {
    snapshot: true,
    signal: lifetime.signal,
  });
  try {
    await vi.waitFor(() => expect(snapshotFixture.create).toHaveBeenCalledOnce());
    await expect(
      runLiveDevDaemon(directory, await freePort(), undefined, { snapshot: true }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    lifetime.abort();
    complete({ root: join(directory, 'snapshot'), version: 'sha256:fixture', dispose });
    await daemon;
    expect(dispose).toHaveBeenCalled();
    expect(fixtures.browser.open).not.toHaveBeenCalled();
    await expect(access(join(runStateDirectory(directory), 'owner.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    lifetime.abort();
    complete({ root: join(directory, 'snapshot'), version: 'sha256:fixture', dispose });
    await daemon;
    if (previous === undefined) delete process.env.FORGEAX_RUNS_DIR;
    else process.env.FORGEAX_RUNS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it('recovers cached run observation after its existing App bridge reconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-snapshot-observation-reconnect-'));
  const previous = process.env.FORGEAX_RUNS_DIR;
  process.env.FORGEAX_RUNS_DIR = join(directory, 'runs');
  const lifetime = new AbortController();
  const port = await freePort();
  snapshotFixture.create.mockResolvedValue({
    root: directory,
    version: 'sha256:fixture',
    dispose: vi.fn(async () => {}),
  });
  fixtures.session.execution = { realm: fixtures.frame };
  Object.assign(fixtures.page, { on: () => fixtures.page });
  let allowFirstFrame: () => void = () => {};
  fixtures.frame.waitForFunction.mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        allowFirstFrame = () => resolve(undefined);
      }),
  );
  const sessionFile = join(directory, 'session.json');
  const daemon = runLiveDevDaemon(directory, port, sessionFile, {
    snapshot: true,
    signal: lifetime.signal,
  });
  const status = async () => {
    const { controlToken } = JSON.parse(await readFile(sessionFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { connection: 'close', authorization: `Bearer ${controlToken}` },
    });
    return (await response.json()) as { value: { phase: string; runId: string } };
  };
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    sockets.push(socket);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'status')
        socket.send(
          JSON.stringify({
            type: 'result',
            id: message.id,
            payload: {
              ok: true,
              value: {
                worldIdentity: 'snapshot-world',
                execution: { frame: { submitted: 9, completed: 9 } },
              },
            },
          }),
        );
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    allowFirstFrame();
    return socket;
  };
  try {
    await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
    const first = await connect();
    let identity: unknown;
    await vi.waitFor(async () => {
      const observed = await status();
      expect(observed.value.phase).toBe('ready');
      expect(observed.value).toMatchObject({
        execution: { frame: { submitted: 9, completed: 9 } },
      });
      identity = observed.value.runId;
    });
    first.close();
    await vi.waitFor(async () =>
      expect(await status()).toMatchObject({
        value: { phase: 'waiting', bridgeConnected: false },
      }),
    );
    await connect();
    await vi.waitFor(
      async () =>
        expect(await status()).toMatchObject({
          value: {
            phase: 'ready',
            bridgeConnected: true,
            runId: identity,
            execution: { frame: { submitted: 9, completed: 9 } },
          },
        }),
      { timeout: 8000 },
    );
    expect(fixtures.browser.open).toHaveBeenCalledOnce();
    expect(snapshotFixture.create).toHaveBeenCalledOnce();
  } finally {
    for (const socket of sockets) socket.terminate();
    lifetime.abort();
    await daemon;
    fixtures.session.execution = undefined;
    fixtures.frame.waitForFunction.mockImplementation(async () => undefined);
    delete (fixtures.page as typeof fixtures.page & { on?: unknown }).on;
    if (previous === undefined) delete process.env.FORGEAX_RUNS_DIR;
    else process.env.FORGEAX_RUNS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
