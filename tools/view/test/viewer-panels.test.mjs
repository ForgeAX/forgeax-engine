import assert from 'node:assert/strict';
import { Context } from '@forgeax/engine-plugin';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import displayFrontendPlugin from '../packages/view-plugin-display/src/frontend.ts';
import { setLocale as setDisplayLocale } from '../packages/view-plugin-display/src/i18n/index.ts';
import viewportFrontendPlugin, { viewPlayPresentationPlugin } from '../packages/view-plugin-viewport/src/frontend.ts';
import {
  createViewPageHost,
  createViewPageTypeRegistry,
  listOpenablePageTypes,
  readPageTypeTitleRevision,
  resolvePageTypeLabel,
  resolvePageTypeTitle,
  subscribePageTypeTitles,
} from '../packages/viewer/src/host/page-registry.ts';
import { mountViewReactPanel } from '../packages/viewer/src/host/panel-bridge.ts';
import { createViewSlotRegistry } from '../packages/viewer/src/host/slot-registry.ts';
import {
  claimsForPage,
  isPanelClosable,
  reconcileDockPanels,
} from '../packages/viewer/src/shell/panel-reconciler.ts';
import { createBrowserPagePlatform } from '../src/platform/browser-page.ts';
import { mountViewViewer } from '../packages/viewer/src/host/frontend.ts';

it('preserves missing Viewer connection input diagnostics with the default document', async () => {
  const savedDocument = globalThis.document;
  const savedRegistry = globalThis.__forgeaxViewSlotRegistry;
  globalThis.document = fakeDocument().document;
  delete globalThis.__forgeaxViewSlotRegistry;
  try {
    await assert.rejects(mountViewViewer(), {
      name: 'ViewWorkspaceError', code: 'view-workspace-invalid-args',
      expected: 'endpoint to be a non-empty string',
    });
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    if (savedRegistry === undefined) delete globalThis.__forgeaxViewSlotRegistry;
    else globalThis.__forgeaxViewSlotRegistry = savedRegistry;
  }
});

function fakeDockApi() {
  const panels = [];
  return {
    panels,
    getPanel(id) {
      return panels.find((panel) => panel.id === id);
    },
    addPanel(options) {
      const panel = {
        id: options.id,
        options,
        group: { api: { location: { type: 'grid' } } },
        api: {
          title: options.title,
          renderer: undefined,
          setRenderer(renderer) {
            this.renderer = renderer;
          },
          setTitle(title) {
            this.title = title;
          },
          parameters: options.params,
          close() {
            const index = panels.indexOf(panel);
            if (index >= 0) panels.splice(index, 1);
          },
          updateParameters(next) {
            this.parameters = next;
            panel.options.params = next;
          },
        },
      };
      panels.push(panel);
      return panel;
    },
  };
}

it('starts with declared panels without loading or saving project layout history', async () => {
  const source = await readFile(new URL('../packages/viewer/src/shell/ViewerShell.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:getPresentation|setPresentation|restoreDockPanels|fromJSON)\s*\(/);
  assert.match(source, /reconcileDockPanels\(api, claims/);
});

function fakeDocument() {
  const root = node('div');
  const document = {
    createElement: (tag) => ({ ...node(tag), ownerDocument: document }),
    getElementById(id) {
      return walk(root).find((element) => element.id === id) ?? null;
    },
    visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
    defaultView: { dispatchEvent() {}, setTimeout,
      ResizeObserver: class { observe() {} disconnect() {} },
      MutationObserver: class { observe() {} disconnect() {} },
      getComputedStyle: () => ({ visibility: 'visible' }),
    },
  };
  return { document, root };
}

function node(tag) {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    name: '',
    className: '',
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    isConnected: true, closest() { return null; }, getClientRects() { return [{}]; },
    addEventListener() {},
    removeEventListener() {},
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    },
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.append(...children);
    },
    contains(child) {
      return walk(this).includes(child);
    },
    remove() {
      const index = this.parentNode?.children.indexOf(this) ?? -1;
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
  };
}

function walk(root) {
  return [root, ...root.children.flatMap(walk)];
}

describe('dynamic Viewer panel contributions', () => {
  it('registers, snapshots, rejects conflicts, and disposes page types', () => {
    const registry = createViewPageTypeRegistry();
    const pageHost = createViewPageHost({ registry });
    const snapshots = [];
    const unsubscribe = registry.subscribe((types) => snapshots.push(types));
    const dispose = pageHost.registerType({
      context: 'project',
      typeId: 'scene',
      titleKey: 'view.pages.scene',
      order: 0,
      closable: false,
      singleton: true,
      initial: true,
      openable: false,
      layout: 'dock',
      showPanelRail: false,
      hideWhenInactive: true,
    });
    assert.equal(registry.getTypes()[0].typeId, 'scene');
    assert.throws(
      () => pageHost.registerType({
        context: 'project',
        typeId: 'scene',
        title: 'Other',
        order: 1,
        closable: true,
        singleton: true,
        initial: false,
        openable: true,
        layout: 'dock',
        showPanelRail: true,
        hideWhenInactive: true,
      }),
      /already registered/,
    );
    assert.equal(registry.getTypes()[0].titleKey, 'view.pages.scene');
    dispose();
    dispose();
    assert.deepEqual(registry.getTypes(), []);
    assert.equal(snapshots.length, 3);
    unsubscribe();
  });

  it('binds a live page title controller without baking scene fields into the shell', () => {
    let title = undefined;
    const listeners = new Set();
    const registry = createViewPageTypeRegistry();
    const pageHost = createViewPageHost({ registry });
    const dispose = pageHost.registerType({
      context: 'project',
      typeId: 'scene',
      titleKey: 'view.pages.scene',
      order: 0,
      closable: false,
      singleton: true,
      initial: true,
      openable: false,
      layout: 'dock',
      showPanelRail: false,
      hideWhenInactive: true,
      createController: () => ({
        getTitle: () => title,
        subscribeTitle: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    });
    const pageType = registry.getTypes()[0];
    assert.equal(resolvePageTypeTitle(pageType, (key) => key === 'view.pages.scene' ? 'Scene' : key), 'Scene');
    title = 'Main';
    assert.equal(resolvePageTypeTitle(pageType, () => 'Scene'), 'Main');
    assert.equal(resolvePageTypeLabel(pageType, () => 'Scene'), 'Scene');
    let notified = 0;
    const unsubscribe = subscribePageTypeTitles(registry.getTypes(), () => {
      notified += 1;
    });
    for (const listener of listeners) listener();
    assert.equal(notified, 1);
    assert.equal(readPageTypeTitleRevision(registry.getTypes()), 'Main');
    unsubscribe();
    dispose();
    assert.equal(listeners.size, 0);
  });

  it('mounts a bare page surface and lists only hidden singleton page types', () => {
    const registry = createViewPageTypeRegistry();
    const pageHost = createViewPageHost({ registry });
    const disposeScene = pageHost.registerType({
      context: 'project',
      typeId: 'scene',
      title: 'Scene',
      order: 0,
      closable: false,
      singleton: true,
      initial: true,
      openable: false,
      layout: 'dock',
      showPanelRail: false,
      hideWhenInactive: true,
    });
    const disposeDisplay = pageHost.registerType({
      context: 'project',
      typeId: 'display',
      title: 'AI Display',
      order: 10,
      closable: false,
      singleton: true,
      initial: true,
      openable: false,
      layout: 'surface',
      showPanelRail: false,
      hideWhenInactive: false,
    });
    const disposePlugins = pageHost.registerType({
      context: 'project',
      typeId: 'plugins',
      title: 'Plugins',
      order: 20,
      closable: true,
      singleton: true,
      initial: false,
      openable: true,
      layout: 'dock',
      showPanelRail: true,
      hideWhenInactive: true,
    });
    const surface = node('iframe');
    const unmount = pageHost.mount('display', surface);
    const anchor = node('div');
    registry.attach('display', anchor);

    assert.equal(anchor.contains(surface), true);
    assert.deepEqual(
      registry.getTypes().filter(({ initial }) => initial).map(({ typeId }) => typeId),
      ['scene', 'display'],
    );
    assert.deepEqual(
      listOpenablePageTypes(registry.getTypes(), []).map(({ typeId }) => typeId),
      ['plugins'],
    );
    assert.deepEqual(
      listOpenablePageTypes(registry.getTypes(), [{ typeId: 'plugins' }]),
      [],
    );
    unmount();
    disposePlugins();
    disposeDisplay();
    disposeScene();
  });

  it('requires pageType and filters claims for the active page', async () => {
    const { document } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    assert.throws(() => registry.claim({ id: 'missing-page' }), /requires pageType/);
    assert.throws(
      () => registry.claim({ id: 'missing-layout', pageType: 'scene' }),
      /requires layout/,
    );
    await assert.rejects(
      mountViewReactPanel({ registry, id: 'missing-page', panel: 'Example' }),
      /requires pageType/,
    );
    const claims = [
      { id: 'scene-panel', pageType: 'scene' },
      { id: 'plugins-panel', pageType: 'plugins' },
    ];
    assert.deepEqual(claimsForPage(claims, 'plugins'), [claims[1]]);
    assert.deepEqual(claimsForPage(claims, null), []);
  });

  it('starts empty and preserves generic claim metadata through unclaim', () => {
    const { document } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    assert.deepEqual(registry.getClaims(), []);
    const unclaim = registry.claim({
      id: 'example',
      pageType: 'scene',
      titleKey: 'example.title',
      activity: { icon: 'box' },
      layout: { dock: 'left', size: { value: 0.2, unit: 'fraction' }, stack: 'tabs', order: 7 },
    });
    assert.equal(registry.getClaims()[0].id, 'example');
    assert.deepEqual(registry.getClaims()[0].layout.size, { value: 0.2, unit: 'fraction' });
    unclaim();
    assert.deepEqual(registry.getClaims(), []);
  });

  it('mounts before a page opens and reattaches when its Dock slot returns', async () => {
    const { document, root } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    registry.claim({
      id: 'example',
      pageType: 'scene',
      layout: { dock: 'fill', stack: 'tabs', order: 0 },
    });
    const child = node('span');
    const firstHost = await registry.resolveWhenReady('example');
    registry.mount('example', child);
    assert.equal(firstHost.parentNode, null);
    assert.equal(firstHost.contains(child), true);
    const firstAnchor = node('div');
    firstAnchor.id = 'forgeax-view-slot-example';
    root.append(firstAnchor);
    registry.resolve('example');
    firstAnchor.remove();
    const nextAnchor = node('div');
    nextAnchor.id = 'forgeax-view-slot-example';
    root.append(nextAnchor);
    const nextHost = registry.resolve('example');
    assert.equal(nextHost, firstHost);
    assert.equal(nextHost.contains(child), true);
    assert.equal(nextHost.parentNode, nextAnchor);
  });

  it('solves a generic grid-docked layout from independent panel claims', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'scene-tree', titleKey: 'scene', layout: { dock: 'left', size: { value: 0.17, unit: 'fraction' }, stack: 'tabs', order: 0 } },
      { id: 'viewport', titleKey: 'viewport', layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'inspector', titleKey: 'inspector', layout: { dock: 'right', size: { value: 0.25, unit: 'fraction' }, stack: 'tabs', order: 0 } },
      { id: 'content-browser', titleKey: 'content', layout: { dock: 'bottom', size: { value: 0.34, unit: 'fraction' }, stack: 'tabs', order: 0 } },
    ];
    reconcileDockPanels(api, [claims[3]]);
    assert.deepEqual(api.panels.map(({ id }) => id), ['content-browser']);
    reconcileDockPanels(api, claims, { availableWidth: 1000, availableHeight: 600 });
    assert.deepEqual(
      api.panels.map(({ id }) => id),
      ['viewport', 'content-browser', 'scene-tree', 'inspector'],
    );
    assert.deepEqual(api.getPanel('content-browser').options.position, {
      direction: 'below',
      referencePanel: 'viewport',
    });
    assert.equal(api.getPanel('content-browser').options.initialHeight, 204);
    assert.deepEqual(api.getPanel('scene-tree').options.position, {
      direction: 'left',
      referencePanel: 'viewport',
    });
    assert.equal(api.getPanel('scene-tree').options.initialWidth, 170);
    assert.deepEqual(api.getPanel('inspector').options.position, {
      direction: 'right',
      referencePanel: 'viewport',
    });
    assert.equal(api.getPanel('inspector').options.initialWidth, 250);
    reconcileDockPanels(api, [claims[1]]);
    assert.deepEqual(api.panels.map(({ id }) => id), ['viewport']);
  });

  it('passes panel closable=false into dock params for pinned slots', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'viewport', titleKey: 'viewport', closable: false, layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'inspector', titleKey: 'inspector', layout: { dock: 'right', size: { value: 0.25, unit: 'fraction' }, stack: 'tabs', order: 0 } },
    ];
    reconcileDockPanels(api, claims, { availableWidth: 1000, availableHeight: 600 });
    assert.equal(isPanelClosable(claims[0]), false);
    assert.equal(api.getPanel('viewport').options.params.closable, false);
    assert.equal(api.getPanel('inspector').options.params.closable, undefined);
  });

  it('contains no preview seeding or shell-owned display mock', async () => {
    const [main, shell] = await Promise.all([
      readFile(new URL('../packages/viewer/src/main.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../packages/viewer/src/shell/ViewerShell.tsx', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(main, /mountPreviewPanels|SceneTree.*scene-tree/s);
    assert.doesNotMatch(shell, /VIEW_SHELL_SLOTS|fx-view-display-mock|seedDockLayout/);
    assert.doesNotMatch(shell, /\shidden=\{!active\}/);
    assert.match(shell, /aria-hidden=\{!active\}/);
    assert.match(shell, /hidden=\{!active && pageType\.hideWhenInactive\}/);
    assert.match(shell, /data-forgeax-view-dock-page/);
    assert.match(shell, /openDockPages/);
    assert.doesNotMatch(shell, /hidden=\{activePageType\?\.layout !== 'dock'\}/);
    const viewport = await readFile(new URL('../packages/view-plugin-viewport/src/frontend.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(viewport, /viewInlinePreviewsPlugin|inline-previews/);
  });
});

describe('display Frontend Fiber surface ownership', () => {
  it('renders cached run output without an execution iframe or input forwarding', async () => {
    setDisplayLocale('en');
    const { document, root } = fakeDocument();
    const registry = createViewPageTypeRegistry();
    const pageHost = createViewPageHost({ registry });
    const effects = [];
    let status;
    await displayFrontendPlugin.apply({
      get() {}, provide(name, value) { if (name === 'viewDisplayStatus') status = value; },
      effect(factory) { effects.push(factory()); },
    }, { document, pageHost });
    const anchor = node('div');
    root.append(anchor);
    registry.attach('display', anchor);
    const surface = document.getElementById('forgeax-view-display-surface');
    assert.equal(surface.tagName, 'SECTION');
    assert.equal(registry.getTypes()[0].hideWhenInactive, true);
    assert.equal(walk(root).filter(element => element.tagName === 'IFRAME').length, 0);
    status.update({ status: 'running', binding: { root: '/project', runId: 'run' }, observation: {
      status: { phase: 'ready', revision: 'r' },
      image: { capturedAt: '2000-01-01T00:00:00Z', revision: 'r', png: 'data:image/png;base64,AA==' },
      logs: [{ sequence: 12, level: 'info', text: 'ready' }], droppedLogs: 11,
    } });
    assert.match(surface.children[2].textContent, /Last captured image/);
    assert.equal(surface.children[3].getAttribute('src'), 'data:image/png;base64,AA==');
    assert.match(surface.children[5].children[1].textContent, /11 earlier log entries omitted/);
    status.update({ status: 'error', error: 'Disconnected' });
    assert.equal(surface.children[3].hidden, true);
    await effects[0]();
  });

  it('owns an explicit borrowed carrier iframe on a fixed bare page', async () => {
    const { document, root } = fakeDocument();
    const pageRegistry = createViewPageTypeRegistry();
    const pageHost = createViewPageHost({ registry: pageRegistry });
    const effects = [];
    const context = {
      get() {},
      provide() {},
      effect(factory) {
        effects.push(factory());
      },
    };
    await displayFrontendPlugin.apply(context, { document, pageHost, displayCarrier: true });
    const anchor = node('div');
    root.append(anchor);
    pageRegistry.attach('display', anchor);
    const surface = document.getElementById('forgeax-view-display-surface');
    assert.equal(surface?.tagName, 'IFRAME');
    assert.equal(surface?.style.pointerEvents, 'none');
    assert.equal(surface?.dataset.forgeaxViewTargetRole, 'ai-control');
    assert.deepEqual(pageRegistry.getTypes().map(({ typeId, layout }) => ({ typeId, layout })), [
      { typeId: 'display', layout: 'surface' },
    ]);
    assert.equal(walk(root).filter((element) => element.tagName === 'IFRAME').length, 1);
    await assert.rejects(
      displayFrontendPlugin.apply(context, { document, pageHost, displayCarrier: true }),
      /one unique surface/,
    );
    await effects[0]();
    assert.equal(document.getElementById('forgeax-view-display-surface'), null);
    assert.deepEqual(pageRegistry.getTypes(), []);
  });

  it('claims the scene viewport dock before Play or Engine surface attach', async () => {
    const { document } = fakeDocument();
    const claims = [];
    const panelHost = {
      claim: (claim) => {
        claims.push(claim);
        return () => {};
      },
      waitForSlot: async () => undefined,
      mount: () => () => {},
    };
    const context = new Context();
    context.provide('viewOperationClient', { subscribe: () => () => {}, getState: async () => ({}) });
    context.provide('viewScenePage', { typeId: 'scene' });
    const fiber = context.plugin(viewportFrontendPlugin, { document, panelHost });
    await Promise.resolve();
    assert.equal(claims[0]?.id, 'viewport');
    assert.equal(claims[0]?.pageType, 'scene');
    assert.equal(context.get('viewWorkspaceShell', false), undefined);
    await context.plugin(viewPlayPresentationPlugin, { document });
    await fiber.await();
    assert.equal(typeof context.get('viewWorkspaceShell')?.dispose, 'function');
    await context.fiber.dispose();
  });

  it('owns the Scene preview presenter without creating an empty iframe', async () => {
    const { document, root } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    const panelHost = {
      claim: (claim) => registry.claim(claim),
      waitForSlot: (id) => registry.resolveWhenReady(id),
      mount: (id, child) => registry.mount(id, child),
    };
    const context = new Context();
    context.provide('viewOperationClient', { subscribe: () => () => {}, getState: async () => ({}) });
    await context.plugin(viewPlayPresentationPlugin, { document });
    context.provide('viewScenePage', { typeId: 'scene' });
    await context.plugin(viewportFrontendPlugin, { document, panelHost });
    const anchor = node('div');
    anchor.id = 'forgeax-view-slot-viewport';
    root.append(anchor);
    registry.resolve('viewport');
    const surface = document.getElementById('forgeax-view-workspace');

    assert.equal(registry.getClaims()[0].pageType, 'scene');
    assert.equal(surface?.tagName, 'DIV');
    assert.equal(walk(root).filter(element => element.tagName === 'IFRAME').length, 0);
    await context.fiber.dispose();
    assert.deepEqual(registry.getClaims(), []);
  });

  it('owns the platform Play document without navigating loopback', async () => {
    const { document, root } = fakeDocument();
    document.body = root;
    document.defaultView.addEventListener = () => {};
    document.defaultView.removeEventListener = () => {};
    const target = { targetId: 'play-1', generation: 1, width: 1280, height: 720, url: 'http://localhost:1234/' };
    let state = { projectPhase: 'running', targetBinding: 'play', play: { target } };
    let publish;
    const context = new Context();
    context.provide('viewOperationClient', {
      subscribe(listener) { publish = listener; listener(state); return () => {}; },
      getState: async () => state,
    });
    const surface = document.createElement('iframe');
    surface.srcdoc = '<canvas></canvas>';
    root.append(surface);
    const created = [], detached = [];
    context.provide('frontendPlatform', {
      createFrame(url) {
        created.push(url);
        return { element: surface, ready: Promise.resolve(), async dispose() {
          detached.push(url); surface.remove();
        } };
      },
    });
    await context.plugin(viewPlayPresentationPlugin, { document });
    assert.deepEqual(created, [target.url]);
    assert.equal(walk(root).filter(element => element.tagName === 'IFRAME').length, 1);
    assert.equal(surface.src, undefined);
    assert.equal(surface.srcdoc, '<canvas></canvas>');
    state = { ...state, targetBinding: 'scene' };
    publish(state);
    assert.equal(surface.style.visibility, 'visible', 'An adopted Play must retain native frames until Engine acknowledges cleanup');
    assert.equal(surface.style.opacity, '0');
    assert.equal(surface.style.pointerEvents, 'none');
    assert.deepEqual(detached, []);
    state = { projectPhase: 'running', targetBinding: 'scene' };
    publish(state);
    await context.fiber.dispose();
    assert.deepEqual(detached, [target.url]);
    assert.equal(walk(root).filter(element => element.tagName === 'IFRAME').length, 0);
  });

  it('binds only the Fiber-created iframe and never creates a fallback node', async () => {
    const evaluated = [];
    const frame = {};
    const page = {
      goto() {},
      locator() {},
      waitForTimeout() {},
      async waitForFunction(_predicate, id) {
        assert.equal(id, 'forgeax-view-display-surface');
      },
      async evaluate(operation) {
        evaluated.push(operation.toString());
      },
      frame({ name }) {
        assert.equal(name, 'forgeax-view-display-surface');
        return frame;
      },
      on() {},
      off() {},
      isClosed: () => false,
    };
    const platform = createBrowserPagePlatform({ page });
    const resource = await platform.createPage({
      leaseId: 'lease',
      generation: 1,
      width: 800,
      height: 600,
    });
    assert.equal(resource.surfaceId, 'forgeax-view-display-surface');
    assert.doesNotMatch(evaluated[0], /createElement|append\(/);
    assert.doesNotMatch(evaluated[0], /surface\.(?:width|height)\s*=/);
    assert.doesNotMatch(evaluated[0], /setAttribute\(['"](?:width|height)|style\.(?:width|height)\s*=\s*.*px/);
    assert.match(evaluated[0], /surface\.style\.width = '100%'/);
    assert.match(evaluated[0], /surface\.style\.height = '100%'/);
    await resource.dispose();
  });
});

it('defers hidden panel creation, retires removed claims immediately, and preserves resized layout', () => {
  const api = fakeDockApi();
  const claims = [
    { id: 'scene', layout: { dock: 'fill', stack: 'tabs', order: 0 } },
    { id: 'content', layout: { dock: 'bottom', size: { value: 0.34, unit: 'fraction' }, stack: 'tabs', order: 0 } },
  ];
  reconcileDockPanels(api, claims, { availableWidth: 0, availableHeight: 0 });
  assert.equal(api.panels.length, 0, 'hidden initial layout must wait for its real extent');
  reconcileDockPanels(api, claims, { availableWidth: 1200, availableHeight: 900 });
  const content = api.getPanel('content');
  assert.equal(content.options.initialHeight, 306);
  content.options.initialHeight = 170;
  reconcileDockPanels(api, claims, { availableWidth: 0, availableHeight: 0 });
  reconcileDockPanels(api, claims, { availableWidth: 1200, availableHeight: 900 });
  assert.equal(api.getPanel('content'), content);
  assert.equal(content.options.initialHeight, 170, 'revealing a page must preserve user sizing');
  reconcileDockPanels(api, [claims[0]], { availableWidth: 0, availableHeight: 0 });
  assert.equal(api.getPanel('content'), undefined, 'hidden claim retirement remains immediate');
});
