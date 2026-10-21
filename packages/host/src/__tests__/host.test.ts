import { once } from 'node:events';
import { Context } from '@forgeax/engine-plugin';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createBackendHost } from '../backend.js';
import { createFrontendHost } from '../frontend.js';
import {
  attachHostWebSocketServer,
  createHostTransport,
  createHostWebSocketClient,
} from '../index';
import { createHostAssembly, validateHostAssembly } from '../protocol.js';
import {
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_CHANGED_TOPIC,
  HOST_ASSEMBLY_SERVICE,
} from '../transport.js';

const assembly = () =>
  createHostAssembly({
    root: { program: 'game#main', codeRevision: 'one', config: { answer: 42 } },
  });
describe('native root Host assembly', () => {
  it('validates the versioned JSON projection and rejects old Entries', () => {
    const value = assembly();
    expect(validateHostAssembly(JSON.parse(JSON.stringify(value))).ok).toBe(true);
    expect(validateHostAssembly({ ...value, entries: [] }).ok).toBe(false);
    expect(validateHostAssembly({ ...value, sessionGeneration: 2 }).ok).toBe(false);
    expect(() => createHostAssembly({ config: { nan: NaN } })).toThrow();
  });
  it('admits exactly the HostAssembly and root descriptor fields', () => {
    const value = assembly();
    const reason = (candidate: unknown) => {
      const checked = validateHostAssembly(candidate);
      return checked.ok ? undefined : checked.error.detail;
    };
    expect(
      validateHostAssembly(
        createHostAssembly({ root: { program: 'game#main', codeRevision: 'one', source: 'g' } }),
      ).ok,
    ).toBe(true);
    expect(reason({ ...value, schemaVersion: 1 })).toEqual({
      reason: 'invalid schema or session generation',
    });
    expect(reason({ ...value, root: { ...value.root, entry: 'main' } })).toEqual({
      reason: 'invalid root descriptor',
    });
    expect(reason({ ...value, toString: 'x' })).toEqual({ reason: 'unknown assembly fields' });
  });
  it('waits outside the native parent and cleans only its own contributions', async () => {
    const ctx = new Context();
    let disposed = 0;
    const host = await createFrontendHost({
      context: ctx,
      assembly: assembly(),
      resolveRoot: async () => ({
        apply(ctx: Context, config: { answer: number }) {
          ctx.provide('answer', config.answer);
          ctx.plugin({
            inject: ['answer'],
            apply(ctx: Context) {
              expect(ctx.get('answer')).toBe(42);
              ctx.effect(() => () => {
                disposed++;
              });
            },
          });
        },
      }),
    });
    expect(host.status.state).toBe('active');
    expect(host.assembly.inspection.every((row) => row.state === 'active')).toBe(true);
    await host.dispose();
    expect(disposed).toBe(1);
    expect(ctx.fiber.uid).not.toBeNull();
    await ctx.fiber.dispose();
  });
  it('does not finish activation after disposal while its status reporter is pending', async () => {
    let release = () => {};
    let entered = () => {};
    const reporting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await createFrontendHost({
      autoActivate: false,
      assembly: assembly(),
      resolveRoot: async () => () => {},
      reportStatus: async (status) => {
        if (status.state === 'active') {
          entered();
          await pending;
        }
      },
    });
    const activation = host.activate();
    const rejected = expect(activation).rejects.toBeDefined();
    await reporting;
    await host.dispose();
    release();
    await rejected;
    expect(host.status.state).toBe('disposed');
  });
  it('requires a new environment before replacing the root session', async () => {
    const host = await createFrontendHost({
      assembly: assembly(),
      resolveRoot: async () => () => {},
    });
    const next = createHostAssembly({
      sessionGeneration: 2,
      root: { program: 'game#main', codeRevision: 'two' },
    });
    await expect(host.update(next)).rejects.toMatchObject({
      code: 'host-assembly-reload-required',
    });
    expect(host.status.state).toBe('active');
    await host.dispose();
  });
  it('retains backend authority and rejects stale activation reports', async () => {
    const backend = await createBackendHost({ assembly: assembly() });
    const client = backend.transport.connect();
    await client.request(HOST_ACTIVATION_REPORT_SERVICE, {
      state: 'active',
      revision: backend.assembly.current.revision,
      sessionGeneration: 1,
    });
    const old = backend.assembly.current;
    if (!old.root) throw new Error('fixture root missing');
    await backend.update({ root: old.root }, { expectedRevision: old.revision });
    await expect(
      client.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: 'active',
        revision: old.revision,
        sessionGeneration: 1,
      }),
    ).rejects.toBeDefined();
    await backend.dispose();
  });
  it('bounds a resolver that ignores cancellation and never reports it as active', async () => {
    const host = await createFrontendHost({
      assembly: assembly(),
      autoActivate: false,
      startupTimeoutMs: 20,
      cleanupTimeoutMs: 50,
      resolveRoot: () => new Promise(() => {}),
    });
    await expect(host.activate()).rejects.toMatchObject({
      code: 'host-assembly-activation-timeout',
    });
    expect(host.status.state).toBe('failed');
    await host.dispose();
  });
  it('rejects sparse JSON and freezes the validated wire snapshot', () => {
    expect(() => createHostAssembly({ config: new Array(2) })).toThrow();
    const input = assembly();
    const decoded = JSON.parse(JSON.stringify(input));
    const checked = validateHostAssembly(decoded);
    expect(checked.ok).toBe(true);
    decoded.root.config.answer = 0;
    if (checked.ok) {
      expect(checked.value.root?.config).toEqual({ answer: 42 });
      expect(Object.isFrozen(checked.value.root?.config)).toBe(true);
    }
  });
});

describe('Host cancellation ownership', () => {
  it('passes an explicit unbounded startup policy into a custom activator', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let receivedTimeout: number | null | undefined;
    const host = await createFrontendHost({
      assembly: assembly(),
      autoActivate: false,
      startupTimeoutMs: null,
      async activateRoot(ctx, _root, _signal, timeoutMs) {
        receivedTimeout = timeoutMs;
        const fiber = ctx.plugin({ apply() {} }).ctx.fiber;
        await waiting;
        return { fiber };
      },
    });
    vi.useFakeTimers();
    try {
      const activation = host.activate();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(receivedTimeout).toBeNull();
      expect(host.status.state).toBe('loading');
      release();
      await activation;
      expect(host.status.state).toBe('active');
    } finally {
      release();
      vi.useRealTimers();
      await host.dispose();
    }
  });

  it('disposes partially installed roots when a custom activation never settles', async () => {
    const context = new Context();
    let disposed = 0;
    const host = await createFrontendHost({
      context,
      assembly: assembly(),
      autoActivate: false,
      startupTimeoutMs: 20,
      async activateRoot(ctx) {
        ctx.plugin({
          apply(ctx) {
            ctx.effect(() => () => {
              disposed++;
            });
          },
        });
        return new Promise(() => {});
      },
    });
    await expect(host.activate()).rejects.toMatchObject({
      code: 'host-assembly-activation-timeout',
    });
    expect(disposed).toBe(1);
    await host.dispose();
    expect(context.fiber.uid).not.toBeNull();
    await context.fiber.dispose();
  });
  it('revokes frontend contributions when the transport disconnects', async () => {
    const backend = await createBackendHost({ assembly: assembly() });
    const client = backend.transport.connect();
    let released = false;
    const host = await createFrontendHost({
      transport: client,
      resolveRoot: async () => ({
        apply(ctx) {
          ctx.effect(() => () => {
            released = true;
          });
        },
      }),
    });
    await backend.dispose();
    await expect.poll(() => released).toBe(true);
    await host.dispose();
  });
});

it('binds, replaces and withdraws connection projections without changing backend assembly or peers', async () => {
  const backend = await createBackendHost();
  const defaultClient = backend.transport.connect({ kind: 'frontend', sourceId: 'default' });
  const targetClient = backend.transport.connect({ kind: 'frontend', sourceId: 'target' });
  const initial = createHostAssembly({ config: { phase: 'initial' } });
  const complete = createHostAssembly({ config: { phase: 'complete' } });
  const events: unknown[] = [];
  targetClient.subscribe(HOST_ASSEMBLY_CHANGED_TOPIC, (value) => events.push(value));
  try {
    expect(() =>
      backend.bindProjection(
        { ...targetClient.caller, capability: 'forged' },
        { assembly: initial },
      ),
    ).toThrow();
    expect(events).toEqual([]);
    const old = backend.bindProjection(targetClient.caller, {
      assembly: complete,
    });
    expect(await targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(complete);
    expect(await defaultClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(
      backend.assembly.current,
    );
    for (const revision of [complete.revision]) {
      await expect(
        targetClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
          state: 'active',
          revision,
          sessionGeneration: 1,
        }),
      ).resolves.toEqual({ accepted: true });
      await expect(
        defaultClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
          state: 'active',
          revision,
          sessionGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: 'host-assembly-revision-mismatch' });
    }
    await expect(
      targetClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: 'active',
        revision: backend.assembly.current.revision,
      }),
    ).rejects.toMatchObject({ code: 'host-assembly-revision-mismatch' });
    await backend.update({ config: { phase: 'default-updated' } });
    expect(events).toEqual([complete]);
    expect(await targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(complete);
    const replacement = backend.bindProjection(targetClient.caller, { assembly: initial });
    old();
    await expect(
      targetClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: 'active',
        revision: complete.revision,
        sessionGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'host-assembly-revision-mismatch' });
    expect(await targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(initial);
    replacement();
    replacement();
    await expect(targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).rejects.toMatchObject({
      code: 'host-assembly-service-unavailable',
    });
    expect(await defaultClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(
      backend.assembly.current,
    );
  } finally {
    defaultClient.close();
    targetClient.close();
    expect(() => backend.bindProjection(targetClient.caller, { assembly: initial })).toThrow();
    await backend.dispose();
  }
});

it('preserves unknown remote business codes across the real WebSocket boundary', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
  const failures = {
    capability: {
      code: 'plugin-capability-unavailable',
      expected: 'Engine workspace capability project.open to be installed',
      hint: 'Build and install the matching Engine workspace plugin before opening a project.',
      detail: { capability: 'project.open' },
    },
    asset: {
      code: 'plugin-asset-unsupported',
      expected: 'Engine asset.open to support asset kind material',
      hint: 'Use an Engine type-preview capability for this asset kind.',
      detail: { kind: 'material' },
    },
  } as const;
  const transport = createHostTransport();
  const unregister = transport.register('plugin.workspace.call', ({ payload }) => {
    const failure =
      (payload as { readonly operation?: unknown }).operation === 'asset.open'
        ? failures.asset
        : failures.capability;
    throw Object.assign(new Error(failure.hint), failure);
  });
  server.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
  let client: Awaited<ReturnType<typeof createHostWebSocketClient>> | undefined;
  try {
    client = await createHostWebSocketClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
    for (const failure of [failures.capability, failures.asset]) {
      await expect(
        client.request('plugin.workspace.call', {
          operation: failure === failures.asset ? 'asset.open' : 'project.open',
        }),
      ).rejects.toMatchObject({
        code: 'host-transport-failure',
        expected: failure.expected,
        hint: failure.hint,
        detail: {
          service: 'host/socket',
          remoteCode: failure.code,
          ...failure.detail,
        },
      });
    }
  } finally {
    client?.close();
    unregister();
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([2, 3])('does not send while socket state=%s precedes the close event', async (state) => {
  let readyState = 1;
  const socket = {
    get readyState() {
      return readyState;
    },
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const client = await createHostWebSocketClient(socket);
  try {
    readyState = state;
    // No close event has arrived: connected retains its existing event semantics.
    expect(client.connected).toBe(true);
    const request = client.request('echo', { closed: true });
    void request.catch(() => undefined);
    const unsubscribe = client.subscribe('closed.topic', () => {});
    unsubscribe();
    unsubscribe();
    expect(socket.send).not.toHaveBeenCalled();
    await expect(request).rejects.toMatchObject({ code: 'host-transport-failure' });
    expect(client.connected).toBe(true);
  } finally {
    client.close();
  }
  expect(client.connected).toBe(false);
});

it('exercises the WebSocket host boundary with request, cancellation, and close', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
  const transport = createHostTransport();
  let cancelled = false;
  let resolveCancellation: (() => void) | undefined;
  const cancellationObserved = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  transport.register('echo', ({ payload }) => payload);
  transport.register(
    'pending',
    ({ signal }) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          cancelled = true;
          resolveCancellation?.();
          reject(new Error('cancelled'));
        });
      }),
  );
  server.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const client = await createHostWebSocketClient(socket);
  const unsubscribe = client.subscribe('fixture.topic', () => {});
  await expect(client.request('echo', { ok: true })).resolves.toEqual({ ok: true });
  const preAborted = new AbortController();
  preAborted.abort();
  await expect(
    client.request('echo', undefined, { signal: preAborted.signal }),
  ).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
  const controller = new AbortController();
  const pending = client.request('pending', undefined, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
  await cancellationObserved;
  expect(cancelled).toBe(true);
  client.close();
  const sendAfterClose = vi.spyOn(socket, 'send');
  unsubscribe();
  unsubscribe();
  expect(sendAfterClose).not.toHaveBeenCalled();
  sendAfterClose.mockRestore();
  const closingSocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const closingClient = await createHostWebSocketClient(closingSocket);
  const closingController = new AbortController();
  const pendingDuringClose = closingClient.request('pending', undefined, {
    signal: closingController.signal,
  });
  const sendDuringClose = vi.spyOn(closingSocket, 'send');
  closingSocket.close();
  expect(closingSocket.readyState).toBe(WebSocket.CLOSING);
  const requestDuringClose = expect(closingClient.request('echo', undefined)).rejects.toMatchObject(
    {
      code: 'host-transport-failure',
    },
  );
  const unsubscribeDuringClose = closingClient.subscribe('closing.topic', () => {});
  unsubscribeDuringClose();
  closingController.abort();
  await expect(pendingDuringClose).rejects.toMatchObject({
    code: 'host-assembly-request-aborted',
  });
  await requestDuringClose;
  expect(sendDuringClose).not.toHaveBeenCalled();
  sendDuringClose.mockRestore();
  const closeClient = await createHostWebSocketClient(
    new WebSocket(`ws://127.0.0.1:${address.port}`),
  );
  const pendingOnClose = closeClient.request('pending', undefined);
  closeClient.close('test close');
  await expect(pendingOnClose).rejects.toMatchObject({ code: 'host-transport-failure' });
  transport.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('rejects a failed socket admission without escaping the WebSocket server callback', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
  const transport = createHostTransport();
  const failures: unknown[] = [];
  let rejectedCaller: Parameters<typeof transport.isConnected>[0] | undefined;
  const removeAdmission = transport.onClientConnect((caller) => {
    rejectedCaller = caller;
    throw Object.assign(new Error('Session limit'), {
      code: 'engine-workspace-session-limit',
      expected: 'at most 16 active workspace sessions',
      hint: 'Close an unused project session before opening another.',
      detail: {},
    });
  });
  transport.register('probe', () => 42);
  server.on('connection', (socket) => {
    try {
      attachHostWebSocketServer(socket, transport);
    } catch (error) {
      failures.push(error);
      socket.close();
    }
  });
  const first = await createHostWebSocketClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
  try {
    await expect(first.request('probe', {})).rejects.toMatchObject({
      detail: { remoteCode: 'engine-workspace-session-limit' },
    });
    expect(failures).toEqual([]);
    expect(rejectedCaller && transport.isConnected(rejectedCaller)).toBe(false);
    removeAdmission();
    const second = await createHostWebSocketClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
    expect(await second.request('probe', {})).toBe(42);
    second.close();
  } finally {
    first.close();
    removeAdmission();
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('inspects the supplied native context scope including its platform owner', async () => {
  const context = new Context();
  let disposed = false;
  const owner = context.plugin({
    name: 'forgeax.view.platform.codex',
    apply(ctx: Context) {
      ctx.effect(() => () => {
        disposed = true;
      });
    },
  });
  await owner.await();
  const frontend = await createFrontendHost({
    context: owner.ctx,
    assembly: assembly(),
    resolveRoot: async () => ({ name: 'project.frontend', apply() {} }),
    autoActivate: true,
  });
  try {
    expect(frontend.assembly.inspection.map((item) => item.name)).toContain(
      'forgeax.view.platform.codex',
    );
    expect(frontend.assembly.inspection.map((item) => item.name)).toContain('project.frontend');
    await frontend.dispose();
    expect(disposed).toBe(false);
  } finally {
    await context.fiber.dispose();
  }
  expect(disposed).toBe(true);
});
