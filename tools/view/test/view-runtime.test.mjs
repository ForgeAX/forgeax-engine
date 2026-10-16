import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FALLBACK_REASONS,
  ViewCarrierAdapter,
  ViewResourceBroker,
  createBrowserPagePlatform,
  createLeaseRequest,
  createViewProductPlan,
  startView,
  VIEW_STATUS_SERVICE,
  VIEW_STATUS_TOPIC,
  viewDisplayFrontendPlugin,
} from '../src/index.ts';
import { createBackendHost, createFrontendHost } from '@forgeax/engine-host';
import { createHostAssembly } from '@forgeax/engine-host/protocol';

function decorateBrowserPage(page) {
  const frame = {
    goto: async () => undefined,
    evaluate: async () => undefined,
    locator: () => ({ first: () => ({ screenshot: async () => Buffer.from('frame') }) }),
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    page: () => page,
    url: () => 'about:blank',
  };
  page.frame = () => frame;
  page.locator ??= () => ({
    count: async () => 1,
    elementHandle: async () => ({
      evaluate: async () => 'IFRAME',
      contentFrame: async () => frame,
      dispose: async () => undefined,
    }),
  });
  page.waitForFunction ??= async () => undefined;
  page.waitForTimeout ??= async () => undefined;
  return page;
}

function request(overrides = {}) {
  return createLeaseRequest({
    run: { serviceId: 'engine-service', runId: 'run-1' },
    generation: 1,
    headless: false,
    gpu: 'auto',
    width: 800,
    height: 600,
    ...overrides,
  });
}

class FakePlatform {
  constructor({ capabilities, delay = 0 } = {}) {
    this.capabilities = capabilities;
    this.delay = delay;
    this.created = [];
    this.closed = [];
    this.disposed = 0;
    this.nextId = 0;
  }

  getCapabilities() {
    return this.capabilities ?? {};
  }

  async createPage({ leaseId, width, height, signal }) {
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    const page = {
      targetId: `fake-target-${++this.nextId}`,
      surfaceId: `fake-surface-${this.nextId}`,
      requestedCanvasSize: { width, height },
      dispose: async () => {
        if (!this.closed.includes(page)) {
          this.closed.push(page);
          page.closedLeaseId = leaseId;
        }
      },
    };
    this.created.push(page);
    if (signal?.aborted) return page;
    return page;
  }

  async dispose() {
    this.disposed += 1;
  }
}

describe('View carrier selection and fallbacks', () => {
  it('requires the explicit in-process resource broker', () => {
    assert.throws(
      () => new ViewCarrierAdapter(),
      /requires the in-process View resource broker/,
    );
  });

  it('keeps headless requests out of the View broker', async () => {
    const broker = new ViewResourceBroker({ platform: new FakePlatform() });
    const allocate = broker.allocate.bind(broker);
    broker.allocate = async () => {
      throw new Error('headless selection must not allocate');
    };
    const adapter = new ViewCarrierAdapter({ broker });
    const decision = await adapter.select(request({ headless: true }));
    assert.equal(decision.fallbackReason, FALLBACK_REASONS.HEADLESS_REQUESTED);
    broker.allocate = allocate;
    await broker.dispose();
  });

  it('rejects an incompatible capability before page allocation', async () => {
    const platform = new FakePlatform({ capabilities: { gpuModes: ['software'] } });
    const broker = new ViewResourceBroker({ platform });
    try {
      const adapter = new ViewCarrierAdapter({ broker });
      const decision = await adapter.select(request({ gpu: 'hardware' }));
      assert.equal(decision.fallbackReason, FALLBACK_REASONS.CAPABILITY_MISMATCH);
      assert.equal(platform.created.length, 0);
    } finally {
      await broker.dispose();
    }
  });

  it('preserves the admitted run when a second headed request arrives', async () => {
    const broker = new ViewResourceBroker({ platform: new FakePlatform() });
    try {
      const adapter = new ViewCarrierAdapter({ broker });
      const first = await adapter.select(request());
      const second = await adapter.select(request({ run: { serviceId: 'other-service', runId: 'run-2' } }));
      assert.equal(first.carrier, 'borrowed');
      assert.equal(second.fallbackReason, FALLBACK_REASONS.OCCUPIED);
      assert.equal(broker.handshake().occupancy.leaseId, first.target.leaseId);
      await adapter.release(first);
    } finally {
      await broker.dispose();
    }
  });

  it('atomically admits at most one concurrent request', async () => {
    const broker = new ViewResourceBroker({ platform: new FakePlatform({ delay: 5 }) });
    try {
      const adapter = new ViewCarrierAdapter({ broker });
      const [a, b] = await Promise.all([
        adapter.select(request({ run: { serviceId: 's1', runId: 'r1' } })),
        adapter.select(request({ run: { serviceId: 's2', runId: 'r2' } })),
      ]);
      const decisions = [a, b];
      assert.equal(decisions.filter((value) => value.carrier === 'borrowed').length, 1);
      assert.equal(decisions.filter((value) => value.fallbackReason === FALLBACK_REASONS.OCCUPIED).length, 1);
      await adapter.release(decisions.find((value) => value.carrier === 'borrowed'));
    } finally {
      await broker.dispose();
    }
  });
});

describe('View leases and lifecycle cleanup', () => {
  it('admits occupancy only after the display surface allocation is ready', async () => {
    let resolvePage;
    const broker = new ViewResourceBroker({
      platform: {
        createPage() {
          return new Promise((resolve) => {
            resolvePage = resolve;
          });
        },
      },
    });
    const allocation = broker.allocate(request());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(broker.occupied, false);
    assert.equal(broker.handshake().state, 'allocating');
    assert.equal(broker.handshake().occupancy, null);
    resolvePage({
      targetId: 'ready-target',
      surfaceId: 'forgeax-view-display-surface',
      async dispose() {},
    });
    const decision = await allocation;
    assert.equal(decision.carrier, 'view');
    assert.equal(broker.occupied, true);
    assert.equal(broker.handshake().state, 'occupied');
    await decision.release();
    await broker.dispose();
  });

  it('destroys a page that completes after cancellation', async () => {
    let resolvePage;
    const platform = {
      created: [],
      async createPage() {
        return new Promise((resolve) => {
          resolvePage = resolve;
        });
      },
      async dispose() {},
    };
    const broker = new ViewResourceBroker({ platform });
    const controller = new AbortController();
    const allocation = broker.allocate(request(), { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const page = {
      targetId: 'late-target',
      surfaceId: 'late-surface',
      disposeCalled: 0,
      async dispose() {
        this.disposeCalled += 1;
      },
    };
    resolvePage(page);
    const decision = await allocation;
    assert.equal(decision.fallbackReason, FALLBACK_REASONS.CANCELLED);
    assert.equal(page.disposeCalled, 1);
    assert.equal(broker.occupied, false);
    await broker.dispose();
  });

  it('rejects stale generations and only releases the exact target', async () => {
    const platform = new FakePlatform();
    const broker = new ViewResourceBroker({ platform });
    const first = await broker.allocate(request({ generation: 2 }));
    const stale = await broker.allocate(request({ generation: 1 }));
    assert.equal(first.carrier, 'view');
    assert.equal(stale.fallbackReason, FALLBACK_REASONS.STALE_GENERATION);
    const wrongRelease = await broker.release({ ...first.target, targetId: 'wrong' });
    assert.equal(wrongRelease.released, false);
    const wrongSurfaceRelease = await broker.release({ ...first.target, surfaceId: 'wrong-surface' });
    assert.equal(wrongSurfaceRelease.released, false);
    assert.equal(broker.occupied, true);
    await first.release();
    assert.equal(broker.occupied, false);
    await broker.dispose();
  });

  it('releases pages and platform resources through broker disposal', async () => {
    const platform = new FakePlatform();
    const broker = new ViewResourceBroker({ platform });
    const first = await broker.allocate(request());
    await first.release('test-release');
    assert.equal(platform.closed.length, 1);
    const second = await broker.allocate(request({ generation: 2 }));
    await broker.dispose();
    assert.equal(platform.closed.length, 2);
    assert.equal(platform.disposed, 1);
    assert.equal(second.target.generation, 2);
  });
});

describe('Explicit browser-page platform', () => {
  it('preserves missing page and lease input diagnostics', async () => {
    assert.throws(() => createBrowserPagePlatform(), {
      name: 'TypeError', message: 'an existing browser page is required',
    });
    const platform = createBrowserPagePlatform({ page: decorateBrowserPage({
      goto: async () => undefined, evaluate: async () => undefined,
    }) });
    await assert.rejects(platform.createPage(), {
      name: 'TypeError', message: 'browser page leaseId must be a non-empty string',
    });
    await platform.dispose();
  });

  it('starts as a read-only observer without a browser carrier', async () => {
    const view = await startView({ frontend: false, workspaceServer: false });
    try {
      assert.equal(view.carrier, undefined);
      assert.equal(view.broker, undefined);
      assert.equal(view.backendHost.context.get('viewStatus')().status, 'idle');
    } finally { await view.dispose(); }
  });

  it('leases an already-open browser page without closing its owner', async () => {
    const listeners = new Map();
    const page = {
      closed: false,
      closeCalls: 0,
      goto: async () => undefined,
      evaluate: async () => undefined,
      isClosed() {
        return this.closed;
      },
      on(event, listener) {
        listeners.set(event, listener);
      },
      off(event, listener) {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
      async close() {
        this.closeCalls += 1;
        this.closed = true;
      },
    };
    decorateBrowserPage(page);
    const platform = createBrowserPagePlatform({ page });
    const broker = new ViewResourceBroker({ platform });
    const decision = await broker.allocate(request());
    assert.equal(decision.carrier, 'view');
    assert.equal(broker.getPage(decision.target), page);
    await decision.release('test-release');
    assert.equal(page.closeCalls, 0);
    assert.equal(platform.getCapabilities().ready, true);
    await broker.dispose();
    assert.equal(page.closeCalls, 0);
  });

  it('withdraws a lease when its exact execution frame detaches', async () => {
    const listeners = new Map();
    const page = {
      goto: async () => undefined,
      evaluate: async () => undefined,
      isClosed: () => false,
      on(event, listener) {
        listeners.set(event, listener);
      },
      off(event, listener) {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
    };
    decorateBrowserPage(page);
    const platform = createBrowserPagePlatform({ page });
    const broker = new ViewResourceBroker({ platform });
    const decision = await broker.allocate(request());
    assert.equal(decision.carrier, 'view');
    listeners.get('framedetached')?.(page.frame());
    assert.equal(broker.occupied, false);
    assert.equal(broker.handshake().state, 'ready');
    await broker.dispose();
  });

  it('returns the exact page through the in-process carrier adapter', async () => {
    const page = {
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    };
    decorateBrowserPage(page);
    const view = await startView({
      frontend: true,
      platform: createBrowserPagePlatform({ page }),
    });
    try {
      const selected = await view.carrier.select(request());
      assert.equal(selected.carrier, 'borrowed');
      page.locator = () => ({
        evaluate: async () => ({
          id: selected.target.surfaceId,
          leaseId: selected.target.leaseId,
          generation: String(selected.target.generation),
        }),
      });
      const attached = await view.carrier.attach(selected);
      assert.equal(attached.page, page);
      assert.deepEqual(attached.target, selected.target);
      await attached.close('test-release');
      assert.equal(view.broker.occupied, false);
    } finally {
      await view.dispose();
    }
  });

  it('activates the paired backend and frontend through native Engine Hosts', async () => {
    const page = {
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    };
    decorateBrowserPage(page);
    const activationReports = [];
    const view = await startView({
      frontend: true,
      platform: createBrowserPagePlatform({ page }),
      onActivationReport(report) {
        activationReports.push(report);
      },
    });
    try {
      assert.equal(view.backendHost.context.get('viewBroker'), view.broker);
      assert.equal(view.backendHost.context.get('viewCarrier'), view.carrier);
      assert.equal(view.frontendHost.status.state, 'active');
      assert.equal(view.frontendHost.context.get('viewDisplayStatus').renderStatus(), 'View ready (idle)');
      assert.equal(view.backendHost.assembly.current.root.program, '@forgeax/view/frontend-root');
      assert.equal(view.backendHost.assembly.current.schemaVersion, 2);
      assert.equal(activationReports.at(-1)?.state, 'active');
      assert.equal(activationReports.at(-1)?.revision, view.backendHost.assembly.current.revision);
      const statusClient = view.backendHost.transport.connect();
      assert.equal((await statusClient.request(VIEW_STATUS_SERVICE, undefined)).state, 'ready');
      statusClient.close();
    } finally {
      await view.dispose();
    }
  });

  it('projects broker status transitions through the Host transport', async () => {
    const page = {
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    };
    decorateBrowserPage(page);
    const view = await startView({
      frontend: true,
      platform: createBrowserPagePlatform({ page }),
    });
    try {
      const shell = view.frontendHost.context.get('viewDisplayStatus');
      assert.equal(shell.snapshot().status, 'idle');
      const selected = await view.carrier.select(request());
      assert.equal(shell.snapshot().status, 'running');
      assert.equal(shell.snapshot().run.runId, 'run-1');
      await selected.release('test-release');
      assert.equal(shell.snapshot().status, 'idle');
    } finally {
      await view.dispose();
    }
  });

  it('loads the public display frontend module through the native root contract', async () => {
    const plan = createViewProductPlan();
    const display = plan.frontend.find(({ id }) => id === 'forgeax.view.page.ai-display.frontend');
    assert.equal(display.module, '@forgeax/view/plugins/display/frontend');
    const frontendHost = await createFrontendHost({
      assembly: createHostAssembly({ root: { program: display.module, codeRevision: '0.2.0' } }),
      resolveRoot: async () => (await import('@forgeax/view-plugin-display/frontend')).default,
      startupPlugins: [{ name: 'fixture-client', provide: ['viewOperationClient', 'pageHost'], apply(ctx) {
        ctx.provide('viewOperationClient', {});
        ctx.provide('pageHost', { registerType: () => () => {} });
      } }],
    });
    try {
      assert.equal(frontendHost.status.state, 'active');
      assert.ok(frontendHost.context.get('viewDisplayStatus', false));
    } finally {
      await frontendHost.dispose();
    }
  });

  it('borrows an existing backend Host without disposing its lifecycle', async () => {
    const page = {
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    };
    decorateBrowserPage(page);
    const platform = createBrowserPagePlatform({ page });
    const backendHost = await createBackendHost();
    const view = await startView({ platform, backendHost });
    try {
      assert.equal(view.backendHost, backendHost);
      assert.equal(backendHost.context.get('viewBroker'), view.broker);
      await view.dispose();
      assert.equal(backendHost.context.get('viewBroker', false), undefined);
      const borrowed = backendHost.transport.connect();
      assert.equal(borrowed.connected, true);
      borrowed.close();
    } finally {
      await backendHost.dispose();
    }
  });

  it('can hand the backend binding to Engine without creating a second frontend Host', async () => {
    const page = {
      goto: async () => undefined,
      evaluate: async () => undefined,
      on() {},
      off() {},
      isClosed: () => false,
    };
    decorateBrowserPage(page);
    const view = await startView({
      platform: createBrowserPagePlatform({ page }),
      frontend: false,
    });
    try {
      assert.equal(view.frontendHost, undefined);
      assert.equal(view.hostBinding.backend, view.backendHost);
      assert.equal(view.hostBinding.frontendAssembly.root.program, '@forgeax/view/frontend-root');
      assert.deepEqual(view.hostBinding.frontendModule, { specifier: '@forgeax/view/frontend-root' });
      assert.deepEqual(view.backendHost.assembly.current.root, view.hostBinding.frontendAssembly.root);
    } finally {
      await view.dispose();
    }
  });
});

describe('Frontend status transport', () => {
  function frontendContext(transport) {
    const services = {};
    const effects = [];
    return {
      services,
      effects,
      context: {
        provide(name, value) {
          services[name] = value;
        },
        get(name) {
          return name === 'hostTransport' ? transport : undefined;
        },
        effect(factory) {
          effects.push(factory());
        },
      },
    };
  }

  it('keeps a newer event over a delayed initial snapshot and maps unavailable state', async () => {
    let resolveInitial;
    let disconnect;
    const subscriptions = new Map();
    const transport = {
      subscribe(topic, listener) {
        subscriptions.set(topic, listener);
        return () => subscriptions.delete(topic);
      },
      request(service) {
        assert.equal(service, VIEW_STATUS_SERVICE);
        return new Promise((resolve) => {
          resolveInitial = resolve;
        });
      },
      onDisconnect(listener) {
        disconnect = listener;
        return () => {
          disconnect = undefined;
        };
      },
    };
    const mounted = frontendContext(transport);
    await viewDisplayFrontendPlugin.apply(mounted.context);
    subscriptions.get(VIEW_STATUS_TOPIC)({
      state: 'occupied',
      run: { serviceId: 'engine-service', runId: 'run-1' },
    });
    resolveInitial({ state: 'ready' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(mounted.services.viewDisplayStatus.snapshot().status, 'running');
    mounted.services.viewDisplayStatus.update({ state: 'unavailable' });
    assert.equal(mounted.services.viewDisplayStatus.renderStatus(), 'View unavailable');
    disconnect?.({ message: 'transport closed' });
    assert.match(mounted.services.viewDisplayStatus.renderStatus(), /View connection error/);
    await mounted.effects[0]();
  });

  it('aborts a pending initial status request before waiting during dispose', async () => {
    let aborted = 0;
    const transport = {
      subscribe() {
        return () => {};
      },
      request(_service, _payload, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted += 1;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
      onDisconnect() {
        return () => {};
      },
    };
    const mounted = frontendContext(transport);
    await viewDisplayFrontendPlugin.apply(mounted.context);
    await mounted.effects[0]();
    assert.equal(aborted, 1);
  });
});
