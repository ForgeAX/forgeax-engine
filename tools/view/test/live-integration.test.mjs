import { Context } from '@forgeax/engine-plugin';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pagePlugin, { attachViewPage, waitForLiveViewerShell } from '../src/page.ts';
import { createViewBackend } from '../src/plugins/backend.ts';
import { contract } from '../src/commands.ts';
import shellPlugin from '../packages/viewer/src/plugins/shell.ts';
import presentationPlugin from '../packages/view-plugin-viewport/src/presentation.ts';
import workspaceFrontend from '../packages/viewer/src/host/workspace-frontend.ts';

describe('plugin-owned live composition', () => {
  it('exposes a native plugin and a pure separately executable command contract', () => {
    assert.equal(pagePlugin.provide, 'viewPage');
    assert.equal(typeof pagePlugin.apply, 'function');
    assert.deepEqual(contract.commands.map((command) => command.path), [
      ['view', 'start'],
      ['view', 'status'],
      ['view', 'stop'],
      ['view', 'project', 'open'],
      ['view', 'workspace', 'call'],
    ]);
    for (const command of contract.commands.slice(0, 4)) {
      assert.equal(command.executor, '@forgeax/view/command-executor');
    }
    assert.equal(contract.commands[4].executor, undefined);
  });

  it('requires an explicitly owned Page and an interface URL before navigating', async () => {
    await assert.rejects(attachViewPage(), /already-open owner Page/);
    await assert.rejects(attachViewPage({ page: { goto() {} } }), /issued interface URL/);
  });

  it('waits for the embedded shell readiness signal', async () => {
    await waitForLiveViewerShell({ async waitForFunction(probe, argument, options) {
      assert.equal(typeof probe, 'function');
      assert.equal(argument, undefined);
      assert.equal(options.timeout, 123);
    } }, { timeout: 123 });
  });

  it('installs the workspace provider on the exact product Host and disposes it once', async () => {
    let binding;
    let disposed = 0;
    const backend = await createViewBackend({
      platform: { async createPage() {}, async dispose() {} },
      workspaceServer: false,
      frontendConfig: { embedded: true, layout: { responsiveAutoTuck: false } },
      workspacePlugin: {
        name: 'fixture.workspace', provide: 'engineWorkspace',
        apply(ctx, options) {
          binding = options.hostBinding;
          ctx.provide('engineWorkspace', {});
          ctx.effect(() => () => { disposed += 1; });
        },
      },
    });
    assert.equal(binding.backend, backend.backendHost);
    assert.equal(binding.frontendAssembly.schemaVersion, 2);
    assert.equal(binding.frontendAssembly.root.program, '@forgeax/view/frontend-root');
    assert.deepEqual(binding.frontendModule, { specifier: '@forgeax/view/frontend-root' });
    assert.deepEqual(backend.backendHost.assembly.current.root, binding.frontendAssembly.root);
    await backend.dispose();
    assert.equal(disposed, 1);
  });

  it('publishes one root outside embedded mode', async () => {
    const backend = await createViewBackend({
      platform: { async createPage() {}, async dispose() {} },
      workspaceServer: false,
      frontendConfig: { layout: { responsiveAutoTuck: false } },
      workspacePlugin: {
        name: 'fixture.workspace', provide: 'engineWorkspace',
        apply(ctx) {
          ctx.provide('engineWorkspace', {});
        },
      },
    });
    const root = backend.backendHost.assembly.current.root;
    assert.equal(root.program, '@forgeax/view/frontend-root');
    assert.equal(root.config.frontendConfig.embedded, undefined);
    await backend.dispose();
  });

  it('mounts the embedded shell through its independent entry', async () => {
    const order = [];
    const shell = {
      name: 'fixture.embedded-shell',
      provide: ['panelHost'],
      apply(ctx) {
        order.push('shell');
        ctx.provide('panelHost', { fixture: true });
      },
    };
    const context = new Context();
    try {
      const fiber = await context.plugin(shellPlugin, { embedded: true, embeddedShell: shell });
      await fiber.await();
      assert.deepEqual(order, ['shell']);
      assert.deepEqual(context.get('panelHost'), { fixture: true });
    } finally { await context.fiber.dispose(); }
  });

  it('delegates through the native plugin lifecycle without an embedded shell', async () => {
    const context = new Context();
    try {
      const fiber = await context.plugin(workspaceFrontend, {});
      await fiber.await();
      assert.equal(context.get('panelHost', false), undefined);
      assert.ok([...context.registry.values()].some(value => value.name === 'forgeax.view.service.workspace-client.frontend'));
      assert.equal(context.get('viewPlayPresentation', false), undefined);
      const presentation = await context.plugin(presentationPlugin);
      await presentation.await();
      assert.equal(typeof context.get('viewPlayPresentation', false)?.attach, 'function');
      await fiber.dispose();
      assert.equal(context.get('viewPlayPresentation', false), undefined);
    } finally { await context.fiber.dispose(); }
  });

  it('prefers the Engine-provided presentation inside the embedded page', async () => {
    const { default: viewportFrontend, viewPlayPresentationPlugin } = await import(
      '@forgeax/view-plugin-viewport/frontend'
    );
    const enginePresentation = { createSurface: () => ({ exact: true }) };
    const fakeNode = () => ({
      className: '',
      style: {},
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      remove() {},
      dataset: {},
      id: '',
      children: [],
      append(...nodes) {
        this.children.push(...nodes);
      },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    });
    const document = {
      createElement: () => ({ ...fakeNode(), ownerDocument: document }),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const context = new Context();
    context.provide('engineWorkspacePresentation', enginePresentation);
    context.provide('viewScenePage', { typeId: 'scene' });
    context.provide('viewOperationClient', { subscribe: () => () => {}, getState: async () => ({}) });
    await context.plugin(viewPlayPresentationPlugin, { document });
    context.provide('panelHost', {
      claim: () => () => {}, waitForSlot: async () => undefined,
      mount: () => () => {}, mountPanelInto: async () => async () => undefined,
    });
    try {
      await context.plugin(viewportFrontend, { document });
      const shell = context.get('viewWorkspaceShell');
      assert.equal(shell.presentation.workspace.surfacePlacement, 'shell');
      assert.equal(shell.presentation.workspace.createSurface, enginePresentation.createSurface);
      const viewportContainer = { id: 'viewport-targets' };
      const surface = {
        style: {},
        parentNode: viewportContainer,
        parentElement: viewportContainer,
        getAttribute() { return null; },
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
      };
      await shell.presentation.workspace.attach({ element: surface, target: { targetId: 't', generation: 1 }, tabId: 'forgeax-user-workspace' });
      assert.equal(surface.parentNode.id, 'viewport-targets');
      assert.equal(surface.style.position, 'relative');
      assert.equal(surface.style.width, '100%');
      assert.equal(surface.style.height, '100%');
      assert.equal(surface.style.transform, 'none');
    } finally { await context.fiber.dispose(); }
  });
});
