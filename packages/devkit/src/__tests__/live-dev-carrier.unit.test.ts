import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExecutionReport,
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  selectExecutionWorkers,
} from '@forgeax/engine-app';
import { createRhiDebugError } from '@forgeax/engine-rhi-debug';
import type { BrowserCaptureError } from '@forgeax/engine-rhi-debug/browser';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { serializeBridgeResult } from '../../../app/src/internal/browser-remote-bridge';
import { publicPageUrl } from '../live-bridge-url.js';
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
    waitForFunction: vi.fn(async () => ({ jsonValue: async () => true, dispose: async () => {} })),
    evaluate: vi.fn(async (): Promise<unknown> => undefined),
    bringToFront: vi.fn(async () => undefined),
  };
  const frame = {
    waitForFunction: vi.fn(async () => ({ jsonValue: async () => true, dispose: async () => {} })),
    evaluate: vi.fn(async () => '9'),
    waitForTimeout: vi.fn(async () => undefined),
  };
  const session = {
    page,
    capture: vi.fn(),
    execution: undefined as unknown,
    close: vi.fn(async () => undefined),
    report: vi.fn(() => ({
      backend: 'hardware' as const,
      carrier: 'borrowed' as 'borrowed' | 'private-browser',
      carrierTarget: target as typeof target | undefined,
      carrierFallbackReason: undefined as string | undefined,
      pageErrors: [],
      consoleErrors: [] as string[],
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
  const project = { url: 'http://127.0.0.1:43124/' };
  const spawn = vi.fn((_command: string, args: readonly string[]) => {
    const generation = Number(args[3]);
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        `${JSON.stringify({ ready: true, generation, url: project.url })}\n`,
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
    project,
    spawn,
    createBrowserCapture,
    readLiveProjectInputs,
  };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: fixtures.spawn,
}));
vi.mock('../browser-capture.js', () => ({ createBrowserCapture: fixtures.createBrowserCapture }));
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

async function request(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  value?: unknown,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { connection: 'close' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return response.json();
}

/** The owner page URL is the only place the daemon hands out its bridge token. */
function ownerBridgeUrl(port: number): string {
  const options = fixtures.browser.open.mock.lastCall?.[0] as { serverUrl?: string } | undefined;
  const token =
    options?.serverUrl === undefined
      ? null
      : new URL(options.serverUrl).searchParams.get('forgeaxBridge');
  return `ws://127.0.0.1:${port}/bridge${token === null ? '' : `?forgeaxBridge=${token}`}`;
}

/** A fake page bridge that answers status and records evals for the test to settle. */
function bridgePage(url: string, sockets: WebSocket[]) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const evals: number[] = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'status')
      socket.send(
        JSON.stringify({
          type: 'result',
          id: message.id,
          payload: { ok: true, value: { worldIdentity: 'owner-world' } },
        }),
      );
    if (message.type === 'eval') evals.push(message.id);
  });
  const closeEvent = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })),
  );
  const opened = new Promise<void>((resolve) => socket.once('open', () => resolve()));
  /** The close the page observes, or 'open' when it stays connected for 2 s. */
  const closed = () =>
    Promise.race([
      closeEvent,
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 2_000)),
    ]);
  const answer = (id: number | undefined, value: unknown) =>
    socket.send(JSON.stringify({ type: 'result', id, payload: { ok: true, value } }));
  return { socket, evals, opened, closed, answer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.project.url = 'http://127.0.0.1:43124/';
  fixtures.browser.open.mockImplementation(async () => fixtures.session);
  fixtures.session.report.mockImplementation(() => ({
    backend: 'hardware' as const,
    carrier: 'borrowed' as const,
    carrierTarget: fixtures.target,
    carrierFallbackReason: undefined,
    pageErrors: [],
    consoleErrors: [],
  }));
});

describe('live DevKit borrowed carrier boundary', () => {
  it('fails runtime verification for faults, blocked observation and replaced executions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-verify-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'));
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax/session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    let worldIdentity = 'verified-world';
    const capabilities = Object.fromEntries(
      EXECUTION_CAPABILITY_NAMES.map((name) => [name, { available: true, reason: 'observed' }]),
    ) as unknown as ExecutionCapabilities;
    const initial = createExecutionReport(
      capabilities,
      selectExecutionWorkers({ capabilities }).unwrap(),
    );
    const healthyExecution = {
      ...initial,
      engine: { ...initial.engine, health: 'running' },
      world: { ...initial.world, identity: worldIdentity },
      frame: { ...initial.frame, submitted: 2, completed: 2 },
    };
    const fault = {
      source: 'runtime',
      code: 'plugin-startup-failed',
      expected: 'healthy execution',
      hint: 'repair startup',
      detail: {},
      partialWrite: false,
      retryable: true,
    };
    let execution: unknown = healthyExecution;
    await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
    const bridge = new WebSocket(ownerBridgeUrl(port));
    bridge.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      bridge.send(
        JSON.stringify({
          type: 'result',
          id: message.id,
          payload: {
            ok: true,
            value: message.type === 'status' ? { worldIdentity, execution } : {},
          },
        }),
      );
    });
    const record = {
      ok: true,
      output: join(root, 'gate.png'),
      digest: 'sha256:fixture',
      runtime: { engineFrameId: 3 },
      pixels: { width: 2, height: 2, rendered: true },
    };
    fixtures.page.evaluate.mockResolvedValue(2);
    fixtures.session.capture.mockResolvedValue(record);
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.once('open', resolve);
        bridge.once('error', reject);
      });
      let revision = '';
      await vi.waitFor(async () => {
        const status = (await request(port, '/status', 'GET')) as {
          value: { revision: string; phase: string };
        };
        expect(status.value.phase).toBe('ready');
        revision = status.value.revision;
      });
      const verify = (args: object = { revision }) => request(port, '/verify', 'POST', args);
      expect(await verify({})).toMatchObject({
        ok: true,
        value: { revision, verified: 'runtime' },
      });
      expect(await verify({ revision, timeoutMs: -1 })).toMatchObject({
        ok: false,
        error: { code: 'live-invalid-timeout' },
      });
      expect(await verify()).toMatchObject({ ok: true, value: { revision, verified: 'runtime' } });
      expect(fixtures.session.capture).toHaveBeenLastCalledWith(undefined, {
        purpose: 'validate',
        afterFrameId: 2,
      });
      for (const failure of [
        { fault },
        { engine: { ...initial.engine, health: 'starting' } },
        { world: { ...healthyExecution.world, partialWrite: true } },
        { render: { epoch: 1, state: 'rebuilding', submittedFrame: 0, completedFrame: 0 } },
      ]) {
        execution = { ...healthyExecution, ...failure };
        expect(await verify()).toMatchObject({ ok: false, error: { code: 'live-runtime-failed' } });
      }
      execution = { ...healthyExecution, frame: initial.frame };
      expect(await verify()).toMatchObject({
        ok: false,
        error: { code: 'live-verification-unavailable' },
      });
      execution = undefined;
      expect(await verify()).toMatchObject({
        ok: false,
        error: { code: 'live-verification-unavailable' },
      });
      execution = healthyExecution;
      fixtures.session.capture.mockRejectedValueOnce(
        Object.assign(new Error('observer unavailable'), {
          code: 'browser-capture-timeout',
        }),
      );
      expect(await verify()).toMatchObject({
        ok: false,
        error: { code: 'browser-capture-timeout' },
      });
      fixtures.session.capture.mockResolvedValueOnce({ ...record, ok: false });
      expect(await verify()).toMatchObject({ ok: false, error: { code: 'live-runtime-failed' } });
      fixtures.session.capture.mockImplementationOnce(async () => {
        execution = { ...healthyExecution, fault: { ...fault, code: 'late-fault' } };
        return record;
      });
      expect(await verify()).toMatchObject({ ok: false, error: { code: 'live-runtime-failed' } });
      execution = healthyExecution;
      fixtures.session.report.mockReturnValueOnce({
        ...fixtures.session.report(),
        consoleErrors: ['late error'],
      });
      expect(await verify()).toMatchObject({ ok: false, error: { code: 'live-runtime-failed' } });
      fixtures.session.capture.mockImplementationOnce(async () => {
        worldIdentity = 'replacement-world';
        return record;
      });
      expect(await verify()).toMatchObject({ ok: false, error: { code: 'live-instance-changed' } });
      expect(await verify()).toMatchObject({ ok: false, error: { code: 'live-revision-stale' } });
    } finally {
      bridge.close();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  });

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
    fixtures.page.evaluate.mockResolvedValue(2);
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      bridge = new WebSocket(ownerBridgeUrl(port));
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
      bridge = new WebSocket(ownerBridgeUrl(port));
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

  it('keeps the bridge with the owner page when another page of the same server connects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-bridge-owner-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    fixtures.browser.open.mockImplementation(async (options: unknown) => ({
      ...fixtures.session,
      // Browser capture publishes the page URL without the owner token.
      url: publicPageUrl((options as { serverUrl: string }).serverUrl),
    }));
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    const sockets: WebSocket[] = [];
    const page = (url: string) => bridgePage(url, sockets);
    fixtures.page.evaluate.mockResolvedValue('2');
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      const owner = page(ownerBridgeUrl(port));
      await owner.opened;
      let revision = '';
      await vi.waitFor(async () => {
        const status = (await request(port, '/status', 'GET')) as {
          value: { phase: string; revision: string; url: string };
        };
        expect(status.value.phase).toBe('ready');
        revision = status.value.revision;
        // The public URL is what other pages open; it never carries the owner token.
        expect(new URL(status.value.url).searchParams.has('forgeaxBridge')).toBe(false);
      });
      const evaluation = request(port, '/eval', 'POST', { code: 'return 7;', revision });
      await vi.waitFor(() => expect(owner.evals).toHaveLength(1));

      // A human tab or an agent's own Playwright page served by the same Vite.
      const observer = page(`ws://127.0.0.1:${port}/bridge`);
      expect(await observer.closed()).toEqual({ code: 4403, reason: 'live-bridge-not-owner' });
      expect(owner.socket.readyState).toBe(WebSocket.OPEN);
      const stale = page(`ws://127.0.0.1:${port}/bridge?forgeaxBridge=not-the-owner`);
      expect(await stale.closed()).toMatchObject({ code: 4403 });

      owner.socket.send(
        JSON.stringify({
          type: 'result',
          id: owner.evals[0],
          payload: { ok: true, value: 7 },
        }),
      );
      expect(await evaluation).toMatchObject({
        ok: true,
        value: { revision, result: 7 },
      });
      expect(await request(port, '/status', 'GET')).toMatchObject({
        value: { phase: 'ready', bridgeConnected: true, revision },
      });
    } finally {
      fixtures.page.evaluate.mockResolvedValue(undefined);
      for (const socket of sockets) socket.terminate();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets only the newest holder of the current owner token keep the bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-bridge-takeover-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    const sockets: WebSocket[] = [];
    fixtures.page.evaluate.mockResolvedValue('2');
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      const first = bridgePage(ownerBridgeUrl(port), sockets);
      await first.opened;
      let revision = '';
      await vi.waitFor(async () => {
        const status = (await request(port, '/status', 'GET')) as {
          value: { phase: string; revision: string };
        };
        expect(status.value.phase).toBe('ready');
        revision = status.value.revision;
      });
      const stranded = request(port, '/eval', 'POST', { code: 'return 1;', revision });
      await vi.waitFor(() => expect(first.evals).toHaveLength(1));

      // The owner page reloaded itself: the same token takes over, finally.
      const second = bridgePage(ownerBridgeUrl(port), sockets);
      expect(await first.closed()).toEqual({ code: 4409, reason: 'live-bridge-displaced' });
      expect(await stranded).toMatchObject({
        ok: false,
        error: { code: 'live-app-bridge-disconnected' },
      });
      const next = request(port, '/eval', 'POST', { code: 'return 8;', revision });
      await vi.waitFor(() => expect(second.evals).toHaveLength(1));
      second.answer(second.evals[0], 8);
      expect(await next).toMatchObject({ ok: true, value: { revision, result: 8 } });

      // Reload opens a new owner page with a new token; the old one is refused.
      const previous = ownerBridgeUrl(port);
      await request(port, '/reload', 'POST');
      expect(fixtures.browser.open).toHaveBeenCalledTimes(2);
      expect(ownerBridgeUrl(port)).not.toBe(previous);
      const stale = bridgePage(previous, sockets);
      expect(await stale.closed()).toEqual({ code: 4403, reason: 'live-bridge-not-owner' });
      const current = bridgePage(ownerBridgeUrl(port), sockets);
      expect(await current.closed()).toBe('open');
    } finally {
      fixtures.page.evaluate.mockResolvedValue(undefined);
      for (const socket of sockets) socket.terminate();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('composes the existing live owner in process and waits for host cancellation cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-in-process-'));
    // A second start waits for an existing `waiting` owner within this budget.
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'in-process', type: 'module', forgeax: { startupTimeoutMs: 300 } }),
    );
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
      expect(
        await startLiveDev(root, {
          headless: false,
          inProcess: { signal: lifetime.signal, onStart: ownerStarted },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'live-not-ready', detail: { status: { phase: 'waiting' } } },
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

  it('keeps the project URL port across source replacement while it is free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-port-'));
    const port = await freePort();
    const projectPort = await freePort();
    fixtures.project.url = `http://127.0.0.1:${projectPort}/`;
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    const blocker = createTcpServer();
    const lastProjectPort = () => fixtures.spawn.mock.calls.at(-1)?.[1].at(-1);
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      expect(lastProjectPort()).toBe('0');
      // A replacement generation binds the URL that tabs and scripts already hold.
      await request(port, '/reload', 'POST');
      expect(fixtures.spawn.mock.calls.length).toBeGreaterThan(1);
      expect(lastProjectPort()).toBe(String(projectPort));
      // An unrelated listener on that port must not fail the generation.
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(projectPort, '127.0.0.1', () => resolve());
      });
      await request(port, '/reload', 'POST');
      expect(lastProjectPort()).toBe('0');
      await request(port, '/stop', 'POST');
      await daemon;
      expect(exit).not.toHaveBeenCalled();
    } finally {
      if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
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
      consoleErrors: [],
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

/** An App bridge that reconnects like a reloaded page does. */
function reconnectingBridge(
  port: number,
  answer: (message: { type: string; code?: string }) => unknown,
): { close(): void } {
  const sockets: WebSocket[] = [];
  let closed = false;
  const connect = () => {
    if (closed) return;
    const socket = new WebSocket(ownerBridgeUrl(port));
    sockets.push(socket);
    socket.on('message', async (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'status' && message.type !== 'eval') return;
      const value = await answer(message);
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ type: 'result', id: message.id, payload: { ok: true, value } }),
        );
    });
    socket.on('error', () => {});
    socket.on('close', () => setTimeout(connect, 20));
  };
  connect();
  return {
    close() {
      closed = true;
      for (const socket of sockets) socket.terminate();
    },
  };
}

describe('live observation diagnostics', () => {
  it('retains structured Worker failures through camera checks and live operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-observation-error-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    fixtures.page.evaluate.mockResolvedValue(2);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
    const failure = {
      code: 'app-not-started',
      expected: 'a running App in the selected execution realm',
      hint: 'Inspect the owning execution before retrying observation.',
      detail: { realm: 'worker', state: 'stopped', worldIdentity: 'observation-world' },
    };
    const bridge = new WebSocket(ownerBridgeUrl(port));
    bridge.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const result =
        message.type === 'status'
          ? { ok: true as const, value: { worldIdentity: 'observation-world' } }
          : { ok: false as const, error: failure };
      bridge.send(
        JSON.stringify({
          type: 'result',
          id: message.id,
          payload: serializeBridgeResult(structuredClone(result)),
        }),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.once('open', resolve);
        bridge.once('error', reject);
      });
      await vi.waitFor(async () => {
        expect(await request(port, '/status', 'GET')).toMatchObject({
          ok: true,
          value: { phase: 'ready' },
        });
      });
      for (const path of ['/capture', '/camera/get']) {
        expect(await request(port, path, 'POST')).toEqual({ ok: false, error: failure });
      }
      expect(fixtures.session.capture).not.toHaveBeenCalled();
    } finally {
      bridge.close();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('live readiness waiting', () => {
  it('runs commands against the rebuilt runtime instead of rejecting transient states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-ready-wait-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const evaluated: string[] = [];
    let releaseHeld: (() => void) | undefined;
    fixtures.page.evaluate.mockResolvedValue('2');
    fixtures.session.capture.mockResolvedValue({
      ok: true,
      output: join(root, 'wait.png'),
      digest: 'sha256:fixture',
      runtime: { engineFrameId: 3 },
      pixels: { width: 2, height: 2, rendered: true },
    });
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    const bridge = reconnectingBridge(port, (message) => {
      if (message.type === 'status') return { worldIdentity: 'wait-world' };
      evaluated.push(message.code ?? '');
      if (message.code === 'hold')
        return new Promise((resolve) => {
          releaseHeld = () => resolve('held');
        });
      return {};
    });
    const ready = async () => {
      let revision = '';
      await vi.waitFor(async () => {
        const status = (await request(port, '/status', 'GET')) as {
          value: { phase: string; revision: string };
        };
        expect(status.value.phase).toBe('ready');
        revision = status.value.revision;
      });
      return revision;
    };
    try {
      const first = await ready();
      // An edit makes the current runtime stale; an unpinned observation runs on its replacement.
      fixtures.readLiveProjectInputs.mockResolvedValue('edited-inputs-1');
      const captured = (await request(port, '/capture', 'POST', {})) as {
        ok: boolean;
        value: { revision: string; waitedMs: number };
      };
      expect(captured).toMatchObject({ ok: true, value: { waitedMs: expect.any(Number) } });
      expect(captured.value.revision).not.toBe(first);
      expect(fixtures.spawn).toHaveBeenCalledTimes(2);
      const second = await ready();
      expect(second).toBe(captured.value.revision);

      // Another eval in flight: a read waits for it on the same runtime.
      const held = request(port, '/eval', 'POST', { revision: second, code: 'hold' });
      await vi.waitFor(() => expect(releaseHeld).toBeDefined());
      expect(
        await request(port, '/find', 'POST', { name: 'Player', readyTimeoutMs: 0 }),
      ).toMatchObject({ ok: false, error: { code: 'live-eval-running' } });
      const found = request(port, '/find', 'POST', { name: 'Player' });
      setTimeout(() => releaseHeld?.(), 200);
      expect(await found).toMatchObject({
        ok: true,
        value: { revision: second, waitedMs: expect.any(Number) },
      });
      expect(await held).toMatchObject({ ok: true, value: { revision: second, result: 'held' } });

      // A pinned eval is never re-targeted: the replaced revision ends the wait as stale.
      fixtures.readLiveProjectInputs.mockResolvedValue('edited-inputs-2');
      const pinned = (await request(port, '/eval', 'POST', {
        revision: second,
        code: 'pinned',
      })) as { error: { detail: { revision: string } } };
      expect(pinned).toMatchObject({
        ok: false,
        error: { code: 'live-revision-stale', detail: { waitedMs: expect.any(Number) } },
      });
      expect(pinned.error.detail.revision).not.toBe(second);
      expect(evaluated).not.toContain('pinned');
      await ready();

      // A replacement that fails with unchanged inputs is terminal: no wait to the deadline.
      fixtures.browser.open.mockRejectedValueOnce(new Error('fixture startup failed'));
      fixtures.readLiveProjectInputs.mockResolvedValue('edited-inputs-3');
      const startedAt = Date.now();
      expect(await request(port, '/capture', 'POST', { readyTimeoutMs: 60_000 })).toMatchObject({
        ok: false,
        error: { code: 'live-not-ready', hint: 'fixture startup failed' },
      });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      fixtures.readLiveProjectInputs.mockResolvedValue('fixture-inputs');
      fixtures.page.evaluate.mockResolvedValue(undefined);
      releaseHeld?.();
      bridge.close();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('replaces a startup generation superseded by an edit instead of publishing failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-superseded-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    fixtures.page.evaluate.mockResolvedValue('2');
    let edited = false;
    fixtures.readLiveProjectInputs.mockImplementation(async () => {
      if (!edited) return 'fixture-inputs';
      // Keep the post-failure input scan observable to status polling.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return 'saved-during-compile';
    });
    fixtures.spawn.mockImplementationOnce((_command: string, args: readonly string[]) => {
      const generation = Number(args[3]);
      queueMicrotask(() => {
        edited = true;
        fixtures.child.stdout.emit(
          'data',
          `${JSON.stringify({
            error:
              'plugin-bootstrap-failed: source changed during plugin compilation; inspect .forgeax/dev.log',
            generation,
          })}\n`,
        );
      });
      return fixtures.child;
    });
    const phases = new Set<string>();
    const errors = new Set<string>();
    let polling = true;
    let readyStatus: { phase: string } | undefined;
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
      onReady: (status) => {
        readyStatus = status;
      },
    });
    const bridge = reconnectingBridge(port, (message) =>
      message.type === 'status' ? { worldIdentity: 'superseded-world' } : {},
    );
    const poll = (async () => {
      while (polling) {
        try {
          const status = (await request(port, '/status', 'GET')) as {
            value: { phase: string; error?: string };
          };
          phases.add(status.value.phase);
          if (status.value.error !== undefined) errors.add(status.value.error);
        } catch {
          // The control server may not be listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    try {
      await vi.waitFor(() => expect(readyStatus).toBeDefined(), { timeout: 10_000 });
      // The owner page dials its token-bearing bridge after the session opens,
      // so the first published phase may still be `waiting`; never `failed`.
      expect(['ready', 'waiting']).toContain(readyStatus?.phase);
      await vi.waitFor(() => expect(phases.has('ready')).toBe(true), { timeout: 10_000 });
      expect(fixtures.spawn).toHaveBeenCalledTimes(2);
      expect(phases.has('failed')).toBe(false);
      // The superseded cause stays observable while its replacement starts.
      expect([...errors]).toContainEqual(
        expect.stringMatching(/^live-startup-superseded: plugin-bootstrap-failed/),
      );
    } finally {
      polling = false;
      await poll;
      fixtures.readLiveProjectInputs.mockImplementation(async () => 'fixture-inputs');
      fixtures.page.evaluate.mockResolvedValue(undefined);
      bridge.close();
      await request(port, '/stop', 'POST');
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('live readiness waiting guards', () => {
  interface Fixture {
    readonly root: string;
    readonly port: number;
    readonly evaluated: string[];
    world: string;
    statusDelayMs: number;
    answer: ((code: string) => unknown) | undefined;
    hold(): Promise<void>;
    release(): void;
    ready(): Promise<string>;
  }

  async function withLiveOwner(body: (fixture: Fixture) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-guard-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    fixtures.page.evaluate.mockResolvedValue('2');
    let releaseHeld: (() => void) | undefined;
    const fixture: Fixture = {
      root,
      port,
      evaluated: [],
      world: 'guard-world',
      statusDelayMs: 0,
      answer: undefined,
      async hold() {
        void request(port, '/eval', 'POST', { revision: await fixture.ready(), code: 'hold' });
        await vi.waitFor(() => expect(releaseHeld).toBeDefined());
      },
      release() {
        releaseHeld?.();
        releaseHeld = undefined;
      },
      async ready() {
        let revision = '';
        await vi.waitFor(async () => {
          const status = (await request(port, '/status', 'GET')) as {
            value: { phase: string; revision: string };
          };
          expect(status.value.phase).toBe('ready');
          revision = status.value.revision;
        });
        return revision;
      },
    };
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    const bridge = reconnectingBridge(port, async (message) => {
      if (message.type === 'status') {
        if (fixture.statusDelayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, fixture.statusDelayMs));
        return { worldIdentity: fixture.world };
      }
      const code = message.code ?? '';
      fixture.evaluated.push(code);
      if (code === 'hold')
        return new Promise((resolve) => {
          releaseHeld = () => resolve('held');
        });
      return fixture.answer?.(code) ?? {};
    });
    try {
      await fixture.ready();
      await body(fixture);
    } finally {
      fixture.release();
      fixtures.readLiveProjectInputs.mockImplementation(async () => 'fixture-inputs');
      fixtures.page.evaluate.mockResolvedValue(undefined);
      bridge.close();
      await request(port, '/stop', 'POST').catch(() => undefined);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }

  it('reopens a page whose bridge stays lost instead of waiting out the budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-bridge-lost-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    fixtures.page.evaluate.mockResolvedValue('2');
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    });
    // Each opened page connects once; a lost page never reconnects on its own.
    const sockets: WebSocket[] = [];
    const connectPage = () => {
      const socket = new WebSocket(ownerBridgeUrl(port));
      sockets.push(socket);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== 'status' && message.type !== 'eval') return;
        socket.send(
          JSON.stringify({
            type: 'result',
            id: message.id,
            payload: { ok: true, value: { worldIdentity: 'reopened-world' } },
          }),
        );
      });
      socket.on('error', () => {});
    };
    const opened = () => fixtures.browser.open.mock.calls.length;
    let connectedPages = 0;
    const pages = setInterval(() => {
      if (opened() > connectedPages) {
        connectedPages = opened();
        connectPage();
      }
    }, 20);
    const ready = async () => {
      let revision = '';
      await vi.waitFor(async () => {
        const status = (await request(port, '/status', 'GET')) as {
          value: { phase: string; revision: string };
        };
        expect(status.value.phase).toBe('ready');
        revision = status.value.revision;
      });
      return revision;
    };
    try {
      await ready();
      expect(opened()).toBe(1);
      for (const socket of sockets) socket.terminate();
      const startedAt = Date.now();
      const found = (await request(port, '/find', 'POST', { name: 'Player' })) as {
        ok: boolean;
        value: { waitedMs: number };
      };
      expect(found).toMatchObject({ ok: true, value: { waitedMs: expect.any(Number) } });
      expect(opened()).toBe(2);
      expect(Date.now() - startedAt).toBeLessThan(20_000);
    } finally {
      clearInterval(pages);
      for (const socket of sockets) socket.terminate();
      fixtures.page.evaluate.mockResolvedValue(undefined);
      await request(port, '/stop', 'POST').catch(() => undefined);
      await daemon;
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('never re-runs an admitted mutation after its instance changed', async () => {
    await withLiveOwner(async (fixture) => {
      fixture.answer = (code) => {
        if (code.includes('camera.set')) fixture.world = 'replacement-world';
        return {};
      };
      expect(
        await request(fixture.port, '/camera/set', 'POST', { position: [1, 2, 3] }),
      ).toMatchObject({ ok: false, error: { code: 'live-instance-changed' } });
      expect(fixture.evaluated.filter((code) => code.includes('camera.set'))).toHaveLength(1);
    });
  });

  it('never admits a request whose caller disconnected during a retry', async () => {
    await withLiveOwner(async (fixture) => {
      await fixture.hold();
      const caller = new AbortController();
      const abandoned = fetch(`http://127.0.0.1:${fixture.port}/camera/set`, {
        method: 'POST',
        headers: { connection: 'close' },
        body: JSON.stringify({ position: [4, 5, 6] }),
        signal: caller.signal,
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The retry's admission check awaits this slow bridge status round-trip.
      fixture.statusDelayMs = 600;
      fixture.release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      caller.abort();
      await abandoned;
      fixture.statusDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(fixture.evaluated.some((code) => code.includes('camera.set'))).toBe(false);
    });
  });

  it('fails promptly with live-not-running when the owner stops during a wait', async () => {
    await withLiveOwner(async (fixture) => {
      await fixture.hold();
      const waiting = request(fixture.port, '/find', 'POST', { name: 'Player' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const startedAt = Date.now();
      await request(fixture.port, '/stop', 'POST');
      expect(await waiting).toMatchObject({
        ok: false,
        error: { code: 'live-not-running', detail: { waitedMs: expect.any(Number) } },
      });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    });
  });

  it('reports the bounded deadline of a small readyTimeoutMs', async () => {
    await withLiveOwner(async (fixture) => {
      await fixture.hold();
      const startedAt = Date.now();
      const result = (await request(fixture.port, '/find', 'POST', {
        name: 'Player',
        readyTimeoutMs: 300,
      })) as { error: { detail: { waitedMs: number } } };
      expect(result).toMatchObject({ ok: false, error: { code: 'live-eval-running' } });
      expect(result.error.detail.waitedMs).toBeGreaterThanOrEqual(300);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    });
  });

  it('ends a wait pinned by --ref as live-revision-stale', async () => {
    await withLiveOwner(async (fixture) => {
      const revision = await fixture.ready();
      fixtures.readLiveProjectInputs.mockImplementation(async () => 'edited-for-ref');
      expect(await request(fixture.port, '/focus', 'POST', { ref: `${revision}/1` })).toMatchObject(
        { ok: false, error: { code: 'live-revision-stale' } },
      );
      expect(fixture.evaluated.some((code) => code.includes('focus'))).toBe(false);
    });
  });

  it('fails fast behind an evaluation that outlived its caller wait', async () => {
    await withLiveOwner(async (fixture) => {
      expect(
        await request(fixture.port, '/eval', 'POST', {
          revision: await fixture.ready(),
          code: 'hold',
          timeoutMs: 50,
        }),
      ).toMatchObject({ ok: false, error: { code: 'live-eval-continuing' } });
      const startedAt = Date.now();
      expect(await request(fixture.port, '/find', 'POST', { name: 'Player' })).toMatchObject({
        ok: false,
        error: { code: 'live-eval-running' },
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      fixture.release();
      await vi.waitFor(async () =>
        expect(await request(fixture.port, '/find', 'POST', { name: 'Player' })).toMatchObject({
          ok: true,
        }),
      );
    });
  }, 15_000);

  it('re-runs an unpinned RHI capture after its World was replaced, releasing its own hold', async () => {
    await withLiveOwner(async (fixture) => {
      const first = await fixture.ready();
      let captures = 0;
      fixture.answer = (code) => {
        if (!code.includes('rhiCapture.captureFrame')) return {};
        captures += 1;
        if (captures === 1) fixture.world = 'replacement-world';
        return { ok: true, value: { kind: 'rhi-tape', digest: `sha256:${captures}` } };
      };
      const result = (await request(fixture.port, '/rhi/capture', 'POST', {
        readyTimeoutMs: 3_000,
      })) as { value: { revision: string } };
      expect(result).toMatchObject({
        ok: true,
        value: { digest: 'sha256:2', waitedMs: expect.any(Number) },
      });
      expect(result.value.revision).not.toBe(first);
      expect(await request(fixture.port, '/status', 'GET')).toMatchObject({
        value: { unfinishedEval: false },
      });
    });
  });

  it('rejects a non-object request body without stopping the owner', async () => {
    await withLiveOwner(async (fixture) => {
      expect(await request(fixture.port, '/find', 'POST', null)).toMatchObject({
        ok: false,
        error: { code: 'tool-invalid-args' },
      });
      await fixture.ready();
    });
  });

  it('fails fast while project inputs are unreadable', async () => {
    await withLiveOwner(async (fixture) => {
      fixtures.readLiveProjectInputs.mockRejectedValue(new Error('fixture unreadable'));
      const startedAt = Date.now();
      expect(
        await request(fixture.port, '/capture', 'POST', { readyTimeoutMs: 5_000 }),
      ).toMatchObject({ ok: false, error: { code: 'live-not-ready' } });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
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
      new Promise<{ jsonValue(): Promise<boolean>; dispose(): Promise<void> }>((resolve) => {
        allowFirstFrame = () => resolve({ jsonValue: async () => true, dispose: async () => {} });
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
    const socket = new WebSocket(ownerBridgeUrl(port));
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
    fixtures.frame.waitForFunction.mockImplementation(async () => ({
      jsonValue: async () => true,
      dispose: async () => {},
    }));
    delete (fixtures.page as typeof fixtures.page & { on?: unknown }).on;
    if (previous === undefined) delete process.env.FORGEAX_RUNS_DIR;
    else process.env.FORGEAX_RUNS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
