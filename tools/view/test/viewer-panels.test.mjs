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
import { applyStageMigration } from '../packages/viewer/src/shell/workbench-layout/grid-layout-migration.ts';
import { canTransferPanelBetweenDocks, panelPlacementFor, shellHomeClaimForPanel, transferDockPanel, transferSourceFor } from '../packages/viewer/src/shell/panel-transfer.ts';
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
  const groups = [];
  const api = {
    panels,
    groups,
    getPanel(id) {
      return panels.find((panel) => panel.id === id);
    },
    addGroup() {
      const group = { panels: [], api: { location: { type: 'grid' }, height: 300 } };
      groups.push(group);
      return group;
    },
    addEdgeGroup(position) {
      const group = { panels: [], api: { location: { type: 'edge', position }, height: 300 } };
      groups.push(group);
      return group;
    },
    addPanel(options) {
      const referencePanel = typeof options.position?.referencePanel === 'string'
        ? api.getPanel(options.position.referencePanel)
        : undefined;
      const group = options.position?.referenceGroup ?? referencePanel?.group ?? groups.find(candidate => candidate.api.location.type === 'grid') ?? api.addGroup();
      const panel = {
        id: options.id,
        options,
        group,
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
            const groupIndex = group.panels.indexOf(panel);
            if (groupIndex >= 0) group.panels.splice(groupIndex, 1);
          },
          updateParameters(next) {
            this.parameters = next;
            panel.options.params = next;
          },
        },
      };
      panels.push(panel);
      group.panels.push(panel);
      return panel;
    },
  };
  return api;
}

function fakeTransferDock(id, { failAfterAdd = false } = {}) {
  const panels = [];
  const groups = [];
  const api = {
    id,
    panels,
    groups,
    getPanel(panelId) { return panels.find(panel => panel.id === panelId); },
    addGroup() {
      const group = {
        id: `${id}-group-${groups.length}`,
        panels: [],
        element: node('div'),
        api: { location: { type: 'grid' }, height: 300 },
      };
      groups.push(group);
      return group;
    },
    addEdgeGroup(position = 'bottom') {
      const group = {
        id: `${id}-edge-${position}`,
        panels: [],
        element: node('div'),
        api: { location: { type: 'edge', position }, height: 300 },
      };
      groups.push(group);
      return group;
    },
    addPanel(options) {
      const group = options.position?.referenceGroup
        ?? groups.find(candidate => candidate.api.location.type === 'grid')
        ?? api.addGroup();
      const anchor = node('div');
      anchor.dataset.forgeaxViewSlot = options.id;
      group.element.append(anchor);
      const panel = {
        id: options.id,
        title: options.title,
        group,
        api: {
          isActive: true,
          isVisible: true,
          location: group.api.location,
          getParameters: () => options.params,
          setActive() { this.isActive = true; },
          close() {
            panels.splice(panels.indexOf(panel), 1);
            group.panels.splice(group.panels.indexOf(panel), 1);
            anchor.remove();
            if (!group.panels.length && group.api.location.type === 'grid') groups.splice(groups.indexOf(group), 1);
          },
        },
      };
      panels.push(panel);
      group.panels.push(panel);
      options.params.attach(options.id, anchor);
      if (failAfterAdd) throw new Error('forced destination failure');
      return panel;
    },
  };
  return api;
}

function fakeTransferRegistry() {
  const hosts = new Map();
  return {
    resolve(id, anchor) {
      let host = hosts.get(id);
      if (!host) {
        host = node('div');
        hosts.set(id, host);
      }
      if (anchor && host.parentNode !== anchor) {
        host.parentNode?.replaceChildren();
        anchor.replaceChildren(host);
      }
      return host;
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
    querySelectorAll(selector) {
      if (selector === '[data-forgeax-view-slot]') return walk(this).slice(1).filter(element => element.dataset.forgeaxViewSlot);
      return [];
    },
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

  it('requires a panel home and filters claims for the active page', async () => {
    const { document } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    assert.throws(() => registry.claim({ id: 'missing-page' }), /requires home/);
    assert.throws(
      () => registry.claim({ id: 'missing-layout', home: { kind: 'page', pageType: 'scene' } }),
      /requires layout/,
    );
    await assert.rejects(
      mountViewReactPanel({ registry, id: 'missing-page', panel: 'Example' }),
      /requires home/,
    );
    const claims = [
      { id: 'scene-panel', home: { kind: 'page', pageType: 'scene' } },
      { id: 'plugins-panel', home: { kind: 'page', pageType: 'plugins' } },
    ];
    assert.deepEqual(claimsForPage(claims, 'plugins'), [claims[1]]);
    assert.deepEqual(claimsForPage(claims, null), []);
  });

  it('limits Shell-home panel layout to order', () => {
    const { document } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    for (const layout of [
      { order: 0, stack: 'tabs' },
      { order: 0, size: { value: 240, unit: 'px' } },
    ]) {
      assert.throws(
        () => registry.claim({ id: 'shell-panel', home: { kind: 'shell-bottom' }, layout }),
        /shell-bottom panel layout supports only order/,
      );
    }
    registry.claim({ id: 'shell-panel', home: { kind: 'shell-bottom' }, layout: { order: 0 } });
    assert.deepEqual(registry.getClaims()[0].layout, { order: 0 });
  });

  it('routes only Shell-home panels through native cross-dock transfer', async () => {
    const registry = fakeTransferRegistry();
    const sourceApi = fakeTransferDock('shell-dock');
    const targetApi = fakeTransferDock('page-dock');
    const claim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    sourceApi.addPanel({ id: claim.id, params: { attach: registry.resolve } });
    const instances = new Map([[sourceApi.id, { api: sourceApi, owner: { kind: 'shell-bottom' } }]]);
    assert.equal(transferSourceFor({ panelId: claim.id, viewId: sourceApi.id }, targetApi, instances, [claim])?.source, sourceApi);

    const pageApi = fakeTransferDock('other-page-dock');
    const pageClaim = { id: 'page-owned', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } };
    pageApi.addPanel({ id: pageClaim.id, params: { attach: registry.resolve } });
    instances.set(pageApi.id, { api: pageApi, owner: { kind: 'page', pageId: 'scene-1', pageType: 'scene' } });
    assert.equal(transferSourceFor({ panelId: pageClaim.id, viewId: pageApi.id }, targetApi, instances, [pageClaim]), undefined);
  });

  it('allows cross-dock targets only for Shell-home panels between page and Shell', () => {
    const shellOwner = { kind: 'shell-bottom' };
    const pageOwner = { kind: 'page', pageId: 'scene-1', pageType: 'scene' };
    const shellClaim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    const pageClaim = { id: 'page-owned', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } };

    assert.equal(canTransferPanelBetweenDocks(shellOwner, pageOwner, shellClaim), true);
    assert.equal(canTransferPanelBetweenDocks(pageOwner, shellOwner, shellClaim), true);
    assert.equal(canTransferPanelBetweenDocks(pageOwner, shellOwner, pageClaim), false);
    assert.equal(canTransferPanelBetweenDocks(shellOwner, shellOwner, shellClaim), false);
  });

  it('returns migrated auto-tuck state when a later stage migration must retry', () => {
    const edgeGroup = { id: 'right-edge', panels: [], api: { location: { type: 'edge', position: 'right' } } };
    const panel = {
      id: 'auto-tucked',
      group: edgeGroup,
      api: {
        location: edgeGroup.api.location,
        moveTo({ group }) {
          const index = panel.group.panels.indexOf(panel);
          if (index >= 0) panel.group.panels.splice(index, 1);
          panel.group = group;
          group.panels.push(panel);
          this.location = group.api.location;
        },
      },
    };
    edgeGroup.panels.push(panel);
    const api = {
      panels: [panel],
      groups: [edgeGroup],
      getPanel(id) { return this.panels.find(candidate => candidate.id === id); },
      addGroup() {
        const group = { id: 'grid', panels: [], api: { location: { type: 'grid' } } };
        this.groups.push(group);
        return group;
      },
    };
    const autoTucked = {
      [panel.id]: { panelId: panel.id, groupId: 'removed-grid', index: 0, locationType: 'grid', tuckedToEdge: 'right' },
    };
    const result = applyStageMigration(
      api,
      { getBoundingClientRect: () => ({ width: 0, height: 0 }) },
      ['right'],
      ['bottom'],
      null,
      autoTucked,
      new Set(),
      ['bottom'],
    );

    assert.equal(result.applied, false);
    assert.deepEqual(result.autoTucked, {});
    assert.equal(panel.api.location.type, 'grid');
  });

  it('classifies panels against the current home claim', () => {
    let claims = [];
    assert.equal(shellHomeClaimForPanel('shared', claims), undefined);

    const sharedClaim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    claims = [sharedClaim];
    assert.equal(shellHomeClaimForPanel(sharedClaim.id, claims), sharedClaim);

    claims = [{ id: 'shared', home: { kind: 'page', pageType: 'material' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } }];
    assert.equal(shellHomeClaimForPanel('shared', claims), undefined);
  });

  it('projects presentation placement from the owning Dockview and panel location', () => {
    assert.deepEqual(
      panelPlacementFor({ kind: 'page', pageId: 'material-1', pageType: 'material' }, 'edge'),
      { kind: 'page', pageId: 'material-1', pageType: 'material', location: 'edge' },
    );
    assert.deepEqual(
      panelPlacementFor({ kind: 'shell-bottom' }, 'edge'),
      { kind: 'shell-bottom', location: 'edge' },
    );
    assert.deepEqual(panelPlacementFor(undefined, undefined), { kind: 'unmounted' });
  });

  it('moves the existing mount host between Dockviews and restores an empty source grid', async () => {
    const registry = fakeTransferRegistry();
    const sourceApi = fakeTransferDock('source-dock');
    const targetApi = fakeTransferDock('target-dock');
    const claim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    sourceApi.addPanel({ id: claim.id, params: { attach: registry.resolve } });
    const host = registry.resolve(claim.id);

    assert.equal(await transferDockPanel({ sourceApi, targetApi, id: claim.id, claim, registry, title: 'Shared' }), true);
    assert.equal(sourceApi.getPanel(claim.id), undefined);
    const destination = targetApi.getPanel(claim.id);
    const destinationAnchor = destination.group.element.querySelectorAll('[data-forgeax-view-slot]')[0];
    assert.equal(registry.resolve(claim.id, destinationAnchor), host);
    assert.equal(host.parentNode, destinationAnchor);
    assert.equal(sourceApi.groups.some(group => group.api.location.type === 'grid'), true);
  });

  it('returns Shell-home panels to the bottom edge without adding a Shell grid', async () => {
    const registry = fakeTransferRegistry();
    const sourceApi = fakeTransferDock('page-dock');
    const shellApi = fakeTransferDock('shell-dock');
    const edgeGroup = shellApi.addEdgeGroup('bottom');
    const claim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    sourceApi.addPanel({ id: claim.id, params: { attach: registry.resolve } });

    assert.equal(await transferDockPanel({
      sourceApi,
      targetApi: shellApi,
      id: claim.id,
      claim,
      registry,
      title: 'Shared',
      position: { direction: 'within', referenceGroup: edgeGroup },
    }), true);
    assert.equal(shellApi.getPanel(claim.id).api.location.type, 'edge');
    assert.equal(shellApi.getPanel(claim.id).group, edgeGroup);
    assert.equal(shellApi.groups.some(group => group.api.location.type === 'grid'), false);
    assert.equal(sourceApi.groups.some(group => group.api.location.type === 'grid'), true);
  });

  it('rolls a failed destination add back to the original mount host', async () => {
    const registry = fakeTransferRegistry();
    const sourceApi = fakeTransferDock('source-dock');
    const targetApi = fakeTransferDock('target-dock', { failAfterAdd: true });
    const claim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    sourceApi.addPanel({ id: claim.id, params: { attach: registry.resolve } });
    const sourceAnchor = sourceApi.getPanel(claim.id).group.element.querySelectorAll('[data-forgeax-view-slot]')[0];
    const host = registry.resolve(claim.id);
    await assert.rejects(transferDockPanel({
      sourceApi, targetApi, id: claim.id, claim, registry, title: 'Shared',
    }), /forced destination failure/);
    assert.equal(sourceApi.getPanel(claim.id) !== undefined, true);
    assert.equal(targetApi.getPanel(claim.id), undefined);
    assert.equal(host.parentNode, sourceAnchor);
    assert.equal(targetApi.groups.some(group => group.api.location.type === 'grid'), true);
  });

  it('starts empty and preserves generic claim metadata through unclaim', () => {
    const { document } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    assert.deepEqual(registry.getClaims(), []);
    const unclaim = registry.claim({
      id: 'example',
      home: { kind: 'page', pageType: 'scene' },
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
      home: { kind: 'page', pageType: 'scene' },
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

  it('reattaches a retained panel when Dock replaces its slot anchor', () => {
    const { document, root } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    const claim = { id: 'inspector', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'right', stack: 'tabs', order: 0 } };
    const unclaim = registry.claim(claim);
    const api = fakeDockApi();
    const firstAnchor = node('div');
    firstAnchor.id = 'forgeax-view-slot-inspector';
    root.append(firstAnchor);
    reconcileDockPanels(api, [claim], { availableWidth: 800, availableHeight: 600, attach: id => registry.resolve(id) });
    const host = registry.resolve('inspector');
    const child = node('div');
    registry.mount('inspector', child);
    firstAnchor.remove();
    const nextAnchor = node('div');
    nextAnchor.id = firstAnchor.id;
    root.append(nextAnchor);
    reconcileDockPanels(api, [claim], { availableWidth: 800, availableHeight: 600, attach: id => registry.resolve(id) });
    assert.equal(nextAnchor.contains(host), true);
    assert.equal(host.contains(child), true);
    unclaim();
  });

  it('solves a generic grid-docked layout from independent panel claims', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'scene-tree', home: { kind: 'page', pageType: 'scene' }, titleKey: 'scene', layout: { dock: 'left', size: { value: 0.17, unit: 'fraction' }, stack: 'tabs', order: 0 } },
      { id: 'viewport', home: { kind: 'page', pageType: 'scene' }, titleKey: 'viewport', layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'inspector', home: { kind: 'page', pageType: 'scene' }, titleKey: 'inspector', layout: { dock: 'right', size: { value: 0.25, unit: 'fraction' }, stack: 'tabs', order: 0 } },
      { id: 'content-browser', home: { kind: 'shell-bottom' }, titleKey: 'content', layout: { order: 0 } },
    ];
    const shellApi = fakeDockApi();
    reconcileDockPanels(shellApi, [claims[3]], { availableWidth: 1000, availableHeight: 240 });
    assert.deepEqual(shellApi.panels.map(({ id }) => id), ['content-browser']);
    assert.equal(shellApi.getPanel('content-browser').options.position, undefined);
    reconcileDockPanels(api, claims.slice(0, 3), { availableWidth: 1000, availableHeight: 600 });
    assert.deepEqual(
      api.panels.map(({ id }) => id),
      ['viewport', 'scene-tree', 'inspector'],
    );
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

  it('places the first Shell panel into the bottom edge group', () => {
    const api = fakeDockApi();
    const edgeGroup = api.addEdgeGroup('bottom');
    const claim = { id: 'content-browser', home: { kind: 'shell-bottom' }, layout: { order: 0 } };

    reconcileDockPanels(api, [claim], { shellBottom: true, availableWidth: 1200, availableHeight: 240 });

    const panel = api.getPanel(claim.id);
    assert.deepEqual(panel.options.position, { direction: 'within', referenceGroup: edgeGroup });
    assert.equal(panel.group.api.location.type, 'edge');
    assert.equal(panel.options.inactive, undefined);
    assert.equal(api.groups.some(group => group.api.location.type === 'grid'), false);
  });

  it('requires the Shell bottom edge group before reconciling Shell-home panels', () => {
    const api = fakeDockApi();
    const claim = { id: 'content-browser', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    assert.throws(
      () => reconcileDockPanels(api, [claim], { shellBottom: true, availableWidth: 1200, availableHeight: 240 }),
      /bottom edge drawer is not initialized/,
    );
  });

  it('keeps a Shell-home panel mounted when page topology is rebuilt', () => {
    const api = fakeDockApi();
    const pageClaim = { id: 'viewport', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } };
    const sharedClaim = { id: 'content-browser', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
    reconcileDockPanels(api, [pageClaim, sharedClaim], { availableWidth: 1000, availableHeight: 600 });
    const pagePanel = api.getPanel(pageClaim.id);
    const sharedPanel = api.getPanel(sharedClaim.id);

    reconcileDockPanels(api, [
      { ...pageClaim, layout: { ...pageClaim.layout, order: 1 } },
      sharedClaim,
    ], { availableWidth: 1000, availableHeight: 600 });

    assert.notEqual(api.getPanel(pageClaim.id), pagePanel, 'page-home panels are rebuilt for the new topology');
    assert.equal(api.getPanel(sharedClaim.id), sharedPanel, 'the shared panel survives page topology changes');
  });

  it('keeps the existing tab active when a contributed panel joins its group', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'viewport', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'inspector', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'right', stack: 'tabs', order: 0 } },
      { id: 'parameters', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'right', stack: 'tabs', order: 900 } },
    ];
    reconcileDockPanels(api, claims, { availableWidth: 1000, availableHeight: 600 });
    assert.equal(api.getPanel('inspector').options.inactive, undefined);
    assert.deepEqual(api.getPanel('parameters').options.position, {
      direction: 'within', referencePanel: 'inspector',
    });
    assert.equal(api.getPanel('parameters').options.inactive, true);
  });

  it('places a right-bottom group below any right group at half its height', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'preview', home: { kind: 'page', pageType: 'material' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'properties', home: { kind: 'page', pageType: 'material' }, layout: { dock: 'right', stack: 'tabs', order: 0 } },
      { id: 'statistics', home: { kind: 'page', pageType: 'material' }, layout: { dock: 'right-bottom', stack: 'tabs', order: 2 } },
    ];
    reconcileDockPanels(api, claims, { availableWidth: 1000, availableHeight: 600 });
    assert.deepEqual(api.panels.map(panel => panel.id), ['preview', 'properties', 'statistics']);
    assert.deepEqual(api.getPanel('statistics').options.position, { direction: 'below', referencePanel: 'properties' });
    assert.equal(api.getPanel('statistics').options.initialHeight, 150);
  });

  it('lets a right-bottom group occupy the right side alone', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'preview', home: { kind: 'page', pageType: 'material' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'statistics', home: { kind: 'page', pageType: 'material' }, layout: { dock: 'right-bottom', stack: 'tabs', order: 2 } },
    ];
    reconcileDockPanels(api, claims, { availableWidth: 1000, availableHeight: 600 });
    assert.deepEqual(api.getPanel('statistics').options.position, { direction: 'right', referencePanel: 'preview' });
    assert.equal(api.getPanel('statistics').options.initialHeight, undefined);
  });

  it('accepts the right-bottom zone during claim registration', () => {
    const { document } = fakeDocument();
    const registry = createViewSlotRegistry(document);
    registry.claim({ id: 'statistics', home: { kind: 'page', pageType: 'material' }, layout: {
      dock: 'right-bottom', stack: 'tabs', order: 2,
    } });
    assert.equal(registry.getClaims()[0].layout.dock, 'right-bottom');
  });

  it('passes panel closable=false into dock params for pinned slots', () => {
    const api = fakeDockApi();
    const claims = [
      { id: 'viewport', home: { kind: 'page', pageType: 'scene' }, titleKey: 'viewport', closable: false, layout: { dock: 'fill', stack: 'tabs', order: 0 } },
      { id: 'inspector', home: { kind: 'page', pageType: 'scene' }, titleKey: 'inspector', layout: { dock: 'right', size: { value: 0.25, unit: 'fraction' }, stack: 'tabs', order: 0 } },
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
    assert.equal(claims[0]?.home.pageType, 'scene');
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

    assert.equal(registry.getClaims()[0].home.pageType, 'scene');
    assert.equal(surface?.tagName, 'DIV');
    assert.equal(walk(root).filter(element => element.tagName === 'IFRAME').length, 0);
    await context.fiber.dispose();
    assert.deepEqual(registry.getClaims(), []);
  });

  it('resizes the native Scene renderer with its viewport instead of retaining the initial canvas extent', async () => {
    const previous = globalThis.ResizeObserver;
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(element) { this.element = element; }
      disconnect() { this.disconnected = true; }
    };
    const { document } = fakeDocument();
    document.defaultView.devicePixelRatio = 2;
    const requests = [];
    const context = new Context();
    let container;
    let detached = false;
    context.provide('viewOperationClient', {
      subscribe: () => () => {}, getState: async () => ({}),
      async resizePreview(input) { requests.push(input); },
    });
    context.provide('viewNativePreviewPresentation', {
      surfacePlacement: 'owner', createSurface: () => undefined,
      attachScene(input) {
        container = input.container;
        Object.assign(container, { clientWidth: 640, clientHeight: 800 });
        return () => { detached = true; };
      },
    });
    context.provide('viewScenePage', { typeId: 'scene' });
    try {
      await context.plugin(viewPlayPresentationPlugin, { document });
      const fiber = context.plugin(viewportFrontendPlugin, { document, panelHost: {
        claim: () => () => {}, waitForSlot: async () => {}, mount: () => () => {},
      } });
      await fiber.await();
      const shell = context.get('viewWorkspaceShell');
      const toolbar = shell.element.parentNode.parentNode.children[0];
      assert.equal(toolbar.className, 'fx-toolbar fx-toolbar--viewport');
      assert.equal(shell.element.contains(toolbar), false, 'Toolbar height must stay outside the render resize container');
      const remove = await shell.presentation.workspace.attach({ target: { targetId: 'scene', generation: 2 }, element: {} });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(requests.map(({ width, height }) => [width, height]), [[1280, 1600]]);
      assert.equal(requests[0].targetGeneration, 2);
      container.clientHeight = 1000;
      observers.filter(observer => observer.element === container).forEach(observer => observer.callback());
      await new Promise(resolve => setTimeout(resolve, 130));
      assert.deepEqual(requests.map(({ width, height }) => [width, height]), [[1280, 1600], [1280, 2000]]);
      remove();
      assert.equal(requests[0].signal.aborted, true);
      assert.equal(detached, true);
      assert.ok(observers.some(observer => observer.element === container && observer.disconnected));
    } finally {
      await context.fiber.dispose();
      globalThis.ResizeObserver = previous;
    }
  });

  it('submits the starting Play extent through Engine before readiness and revokes detached requests', async () => {
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback(); }
      unobserve() {}
      disconnect() {}
    };
    const { document, root } = fakeDocument();
    document.body = root;
    Object.assign(document.defaultView, { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} });
    const target = { targetId: 'retina-play', generation: 4, width: 1280, height: 720, url: 'http://localhost:1234/' };
    let state = { projectPhase: 'running', targetBinding: 'play', play: { target, phase: 'starting' } };
    let publish;
    let ready;
    const handshake = new Promise(resolve => { ready = resolve; });
    const requests = [];
    const context = new Context();
    context.provide('viewOperationClient', {
      subscribe(listener) { publish = listener; listener(state); return () => {}; },
      getState: async () => state,
      async resizePreview(request) {
        requests.push(request);
        await handshake;
        state = { ...state, play: { ...state.play, phase: 'running', target: { ...target, width: request.width, height: request.height } } };
        publish(state);
        return { target: state.play.target };
      },
    });
    context.provide('frontendPlatform', {
      createFrame() {
        const element = document.createElement('iframe'); root.append(element);
        return { element, ready: Promise.resolve(), async dispose() { element.remove(); } };
      },
    });
    try {
      await context.plugin(viewPlayPresentationPlugin, { document });
      const panel = document.createElement('div');
      Object.assign(panel, { clientWidth: 960, clientHeight: 540, getBoundingClientRect: () => ({ left: 10, top: 20, width: 960, height: 540 }) });
      const presentation = context.get('viewPlayPresentation');
      const detach = presentation.attach(panel);
      await Promise.resolve();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].targetId, target.targetId);
      assert.equal(requests[0].targetGeneration, 4);
      assert.equal(requests[0].width, 1920);
      assert.equal(requests[0].height, 1080);
      assert.equal(target.width, 1280, 'Only Engine confirmation changes the target extent');
      await new Promise(resolve => setTimeout(resolve, 130));
      assert.equal(requests.length, 1, 'ResizeObserver must not duplicate the extent while Engine readiness is pending');
      state = { ...state, play: { ...state.play, phase: 'running' } }; publish(state);
      ready();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.length, 1, 'The pending initial resize survives the starting-to-running publication');
      const frame = root.children.find(element => element.tagName === 'IFRAME');
      assert.equal(frame.style.width, '960px');
      assert.equal(frame.style.height, '540px');
      assert.equal(frame.style.transform, 'scale(1)');
      detach();
      assert.equal(requests[0].signal.aborted, true);
      assert.equal(frame.style.visibility, 'visible');
      assert.equal(frame.style.opacity, '0');
      const restore = presentation.attach(panel);
      state = { ...state, targetBinding: 'editor' }; publish(state);
      await new Promise(resolve => setTimeout(resolve, 130));
      assert.equal(requests.length, 1, 'Hidden Play retains native frames without new resize commands');
      state = { ...state, targetBinding: 'play' }; publish(state);
      assert.equal(frame.style.opacity, '1');
      assert.equal(root.children.filter(element => element.tagName === 'IFRAME').length, 1);
      restore();
    } finally {
      ready();
      await context.fiber.dispose();
      globalThis.ResizeObserver = previous;
    }
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
    { id: 'scene', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'fill', stack: 'tabs', order: 0 } },
    { id: 'content', home: { kind: 'page', pageType: 'scene' }, layout: { dock: 'bottom', size: { value: 0.34, unit: 'fraction' }, stack: 'tabs', order: 0 } },
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

it('preserves dock panels while a cross-dock transfer awaits its settled claims', () => {
  const api = fakeDockApi();
  const claim = { id: 'shared', home: { kind: 'shell-bottom' }, layout: { order: 0 } };
  reconcileDockPanels(api, [claim], { availableWidth: 1200, availableHeight: 900 });
  const pending = new Map([[claim.id, Promise.resolve()]]);

  reconcileDockPanels(api, [], { availableWidth: 1200, availableHeight: 900, preservePanelIds: pending });
  assert.ok(api.getPanel(claim.id), 'stale claim reconciliation must retain a transferring panel');

  pending.clear();
  reconcileDockPanels(api, [], { availableWidth: 1200, availableHeight: 900, preservePanelIds: pending });
  assert.equal(api.getPanel(claim.id), undefined, 'the settled empty claim list retires the panel');
});
