import { WorkspaceFixture as ViewWorkspaceBroker, transactionPreview, assetOperationsFixture } from './support/workspace-owner.mjs';
import { ViewWorkspaceBroker as RawViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { WebSocket as NodeWebSocket } from 'ws';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostTransport } from '@forgeax/engine-host/transport';
import { listPackSources } from '@forgeax/engine-pack/build';

import {
  VIEW_DISPLAY_TAB_ID,
  VIEW_WORKSPACE_SERVICES,
  VIEW_WORKSPACE_TAB_ID,
  ViewWorkspaceError,
  ViewWorkspaceShell,
  ViewWorkspaceInputController,
  createBrowserPagePresentation,
  createBrowserPagePlatform,
  createViewWorkspaceClient,
  connectViewWorkspace,
  connectViewFrontend,
  mountViewWorkspace,
  createEngineWorkspaceAdapter,
  createWorkspaceId,
  createWorkspaceRequest,
  startView,
  VIEW_DISPLAY_SURFACE_ID,
} from '../src/index.ts';
import { VIEW_PACK_REVEAL_TOPIC, VIEW_PACK_REVEAL_ACK_SERVICE } from '../packages/view-workspace-core/src/contract.ts';
import { slotElementId } from '../src/shell/contract.ts';

const TEST_PANEL_IDS = [
  'plugins',
  'display',
  'inspector',
  'content-browser',
  'scene-tree',
  'material-preview',
  'material-properties',
  'mesh-preview',
  'mesh-properties',
  'texture-preview',
  'texture-properties',
  'asset-properties',
];

const cleanup = [];

it('preserves missing browser presentation input diagnostics', () => {
  const presentation = createBrowserPagePresentation();
  for (const invoke of [() => presentation.createSurface(), () => presentation.createSurface({})]) {
    assert.throws(invoke, {
      name: 'TypeError', message: 'Engine display target must expose its exact surfaceId',
    });
  }
  assert.throws(() => presentation.attach(), {
    name: 'Error', message: 'Engine display surface identity does not match its target',
  });
});

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function camera(x = 0) {
  return { position: [x, 2, 6], target: [x, 1, 0], up: [0, 1, 0] };
}

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

function engineFixture() {
  const calls = [];
  let cameraState = camera();
  let cameraVersion = 0;
  const previews = new Set();
  const engine = {
    async openProject({ root }) {
      calls.push(['project.open', root]);
      return { project: { id: `project:${root}`, root, name: 'Fixture' }, handle: { root } };
    },
    async closeProject({ project }) {
      calls.push(['project.close', project.id]);
    },
    async listAssets({ project }) {
      calls.push(['assets.list', project.id]);
      return [
        {
          guid: 'scene-guid',
          kind: 'scene',
          name: 'Main scene',
          previewable: true,
          sourcePath: 'assets/scene.pack.ts',
          sourceKind: 'pack.ts',
          revision: '1',
        },
        {
          guid: 'mesh-guid',
          kind: 'mesh',
          name: 'Mesh',
          previewable: true,
          sourcePath: 'assets/scene.pack.ts',
          sourceKind: 'pack.ts',
          revision: '1',
        },
      ];
    },
    async openPreview({ asset, project, width, height }) {
      const targetId = `target:${project.id}:${asset.guid}`;
      const preview = await transactionPreview({
        asset, camera: camera(),
        target: { targetId, sessionId: `session:${targetId}`, worldId: `world:${targetId}`, frameId: 1, headed: true, width, height },
        close() { calls.push(['preview.close', targetId]); previews.delete(preview); },
        capture(value) { calls.push(['preview.capture', value.targetId]); return { targetId, frameId: 2 }; },
      });
      preview.tools = { inspect: ({ entityId }) => ({ entityId, components: [] }) };
      const commit = preview.commitCamera;
      preview.commitCamera = async value => { calls.push(['camera.commit', value.operationId]); return commit(value); };
      previews.add(preview);
      calls.push(['asset.open', asset.guid]);
      return preview;
    },
    async assetInspect({ subject }) {
      calls.push(['asset.inspect', subject]);
      return {
        guid: subject,
        kind: 'scene',
        name: 'Main scene',
        sourcePath: 'assets/scene.pack.ts',
      };
    },
    pack: {
      async inspect(sourcePath) {
        calls.push(['inspect-meta', sourcePath]);
        return {
          revision: '1',
          meta: {
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            packageId: '11111111-1111-4111-8111-111111111111',
            importer: 'pack-ts',
            source: sourcePath,
            importSettings: { contractVersion: '1.0.0', externalAssets: [] },
            subAssets: [],
          },
        };
      },
      async rebuild(sourcePath, mode) {
        calls.push(['rebuild', sourcePath, mode]);
        return { revision: '2', meta: { importer: 'pack-ts', source: sourcePath, subAssets: [] } };
      },
    },
  };
  return { calls, engine: assetOperationsFixture(engine), previews };
}

function client(transport, clientId, token) {
  return createViewWorkspaceClient({ transport, clientId, token });
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.srcAssignments = 0;
    if (tagName === 'iframe') this.contentWindow = { alive: true };
  }

  set src(value) {
    this._src = value;
    this.srcAssignments += 1;
  }

  get src() {
    return this._src;
  }

  get nextSibling() {
    return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const parent = node.parentNode;
      const index = parent?.children?.indexOf?.(node) ?? -1;
      if (index !== -1) parent.children.splice(index, 1);
      this.children.push(node);
      node.parentNode = this;
    }
  }

  appendChild(node) {
    this.append(node);
  }

  insertBefore(node, before) {
    if (node?.parentNode?.children) {
      const currentIndex = node.parentNode.children.indexOf(node);
      if (currentIndex !== -1) node.parentNode.children.splice(currentIndex, 1);
    }
    const beforeIndex = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(beforeIndex === -1 ? this.children.length : beforeIndex, 0, node);
    node.parentNode = this;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index === -1) return node;
    this.children.splice(index, 1);
    node.parentNode = null;
    destroyBrowsingContext(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  setAttribute() {}

  remove() {
    this.removed = true;
    this.parentNode?.removeChild?.(this);
  }
}

function destroyBrowsingContext(node) {
  for (const child of node?.children ?? []) destroyBrowsingContext(child);
  if (node?.tagName === 'iframe' && node.contentWindow) {
    node.contentWindow.alive = false;
    node.contentWindow = null;
  }
}

function fakeDocument() {
  const body = new FakeElement('body');
  const elements = new Map();
  for (const slot of TEST_PANEL_IDS) {
    const slotElement = new FakeElement('div');
    slotElement.id = slotElementId(slot);
    elements.set(slotElement.id, slotElement);
    body.append?.(slotElement);
  }
  const surface = new FakeElement('div');
  surface.id = VIEW_DISPLAY_SURFACE_ID;
  elements.set(surface.id, surface);
  body.append?.(surface);
  const layoutHost = new FakeElement('div');
  layoutHost.id = 'forgeax-view-layout-host';
  elements.set(layoutHost.id, layoutHost);
  body.append?.(layoutHost);
  return {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    body,
  };
}

describe('View workspace API', () => {
  it('tracks the exact headed project View page after navigation away from the entry URL', async () => {
    const transport = createHostTransport();
    const project = { id: 'project:headed', root: '/headed', name: 'Headed' };
    const target = { sessionId: 'session-headed', targetId: 'target-headed', generation: 1, worldId: 'world-headed', headed: true, width: 800, height: 600 };
    const broker = new RawViewWorkspaceBroker({ engine: { project: { project, target, phase: 'running', browserGeneration: 1 } }, accessToken: 'workspace-test-token' });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => { unregister(); transport.close(); await broker.dispose(); });
    const wrong = transport.connect({ kind: 'frontend', sourceId: 'forgeax-workspace:session-headed:other-target' });
    assert.equal(broker.pageSessions.has(wrong.caller.connectionId), false);
    const raw = transport.connect({ kind: 'frontend', sourceId: 'forgeax-workspace:session-headed:target-headed' });
    const page = client(raw, 'headed-page', 'workspace-test-token');
    await page.getState();
    assert.equal(broker.pageSessions.has(raw.caller.connectionId), true);
    await page.selectTab(VIEW_DISPLAY_TAB_ID);
    assert.equal((await page.getState()).selectedTabId, VIEW_DISPLAY_TAB_ID);
    assert.equal(broker.selectedTabId, VIEW_WORKSPACE_TAB_ID);
    raw.close();
    for (let attempt = 0; attempt < 20 && broker.pageSessions.has(raw.caller.connectionId); attempt++)
      await new Promise(done => setTimeout(done, 10));
    assert.equal(broker.pageSessions.has(raw.caller.connectionId), false);
    const revision = broker.revision;
    wrong.close();
    await new Promise(done => setTimeout(done, 0));
    assert.equal(broker.revision, revision, 'a non-page frontend disconnect cannot change View state');
  });

  it('routes Pack reveal to one exact page and accepts only its matching visible receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'view-reveal-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'zero.pack.json'), JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }));
    const project = { id: 'project:reveal', root, name: 'Reveal' };
    const transport = createHostTransport();
    const broker = new RawViewWorkspaceBroker({ engine: { project: { project } }, packSources: listPackSources });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => { unregister(); transport.close(); await broker.dispose(); });
    const a = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    const b = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    broker.attachPageSession(a.caller, transport);
    broker.attachPageSession(b.caller, transport);
    const eventsA = []; const eventsB = [];
    a.subscribe(VIEW_PACK_REVEAL_TOPIC, event => eventsA.push(event));
    b.subscribe(VIEW_PACK_REVEAL_TOPIC, event => eventsB.push(event));
    const revision = (await listPackSources(root)).sources[0].revision;
    const input = { projectId: project.id, sourcePath: 'zero.pack.json', revision };
    const call = (operation, args) => broker.call(createWorkspaceRequest(operation, args, { clientId: 'cli', token: broker.accessToken }));
    assert.equal((await call('pages.list', {})).pages.length, 2);
    assert.equal((await call('pack.reveal', input)).code, 'view-page-ambiguous');
    assert.equal(eventsA.length, 0);
    assert.equal(eventsB.length, 0);
    const pending = call('pack.reveal', { ...input, connectionId: a.caller.connectionId });
    for (let attempt = 0; attempt < 100 && eventsA.length === 0; attempt++) await new Promise(done => setTimeout(done, 10));
    assert.equal(eventsA.length, 1);
    assert.equal(eventsB.length, 0);
    const intent = eventsA[0];
    assert.equal((await b.request(VIEW_PACK_REVEAL_ACK_SERVICE, { ...intent, shown: true })).code, 'view-reveal-stale');
    await a.request(VIEW_PACK_REVEAL_ACK_SERVICE, { ...intent, shown: true });
    assert.deepEqual(await pending, { ok: true, code: 'shown', requestId: intent.requestId,
      connectionId: a.caller.connectionId, projectId: project.id, sourcePath: input.sourcePath, revision });
    const controller = new AbortController();
    const cancelled = broker.revealPack({ ...input, connectionId: a.caller.connectionId }, controller.signal);
    for (let attempt = 0; attempt < 100 && eventsA.length < 2; attempt++) await new Promise(done => setTimeout(done, 10));
    const cancelledIntent = eventsA[1];
    controller.abort();
    assert.equal((await cancelled).code, 'view-reveal-cancelled');
    assert.equal(eventsA.length, 3);
    assert.deepEqual(eventsA[2], { ...cancelledIntent, cancelled: true });
    assert.equal(eventsB.length, 0, 'cancellation stays on the addressed page');
    assert.equal((await a.request(VIEW_PACK_REVEAL_ACK_SERVICE, { ...cancelledIntent, shown: true })).code, 'view-reveal-stale');
    const eventCount = eventsA.length;
    assert.equal((await broker.revealPack({ ...input, connectionId: a.caller.connectionId }, controller.signal)).code, 'view-reveal-cancelled');
    assert.equal(eventsA.length, eventCount, 'an already cancelled request cannot be delivered');
    const stale = broker.revealPack({ ...input, connectionId: a.caller.connectionId });
    for (let attempt = 0; attempt < 100 && eventsA.length < 4; attempt++) await new Promise(done => setTimeout(done, 10));
    await writeFile(join(root, 'zero.pack.json'), JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [], changed: true }));
    assert.equal((await a.request(VIEW_PACK_REVEAL_ACK_SERVICE, { ...eventsA[3], shown: true })).code, 'view-reveal-stale');
    assert.equal((await stale).code, 'view-reveal-stale');
    assert.equal((await broker.revealPack({ ...input, revision: 'sha256:stale', connectionId: a.caller.connectionId })).code, 'view-pack-stale');
  });
  it('keeps two accepted frontend page selections and topic deliveries separate', async () => {
    const transport = createHostTransport();
    const displayByPage = new Map();
    const broker = new ViewWorkspaceBroker({ accessToken: 'workspace-test-token',
      display: caller => ({ state: displayByPage.get(caller?.connectionId) ?? 'idle' }) });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => { unregister(); transport.close(); await broker.dispose(); });
    const rawA = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    broker.attachPageSession(rawA.caller, transport);
    const a = client(rawA, 'view-frontend', 'workspace-test-token');
    const eventsA = [];
    a.subscribe((state) => eventsA.push(state.selectedTabId));
    await a.selectTab(VIEW_DISPLAY_TAB_ID);
    assert.equal((await a.getState()).selectedTabId, VIEW_DISPLAY_TAB_ID);
    displayByPage.set(rawA.caller.connectionId, 'running');
    assert.equal((await a.getState()).tabs[0].state, 'running');
    const countA = eventsA.length;

    const rawB = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    broker.attachPageSession(rawB.caller, transport);
    const b = client(rawB, 'view-frontend', 'workspace-test-token');
    const eventsB = [];
    b.subscribe((state) => eventsB.push(state.selectedTabId));
    assert.equal((await b.getState()).selectedTabId, VIEW_WORKSPACE_TAB_ID);
    assert.equal((await b.getState()).tabs[0].state, 'idle');
    assert.equal((await a.getState()).selectedTabId, VIEW_DISPLAY_TAB_ID);
    assert.equal(eventsA.length, countA);

    await b.selectTab(VIEW_DISPLAY_TAB_ID);
    assert.equal(eventsA.length, countA);
    const countB = eventsB.length;
    await a.selectTab(VIEW_WORKSPACE_TAB_ID);
    assert.equal((await b.getState()).selectedTabId, VIEW_DISPLAY_TAB_ID);
    assert.equal(eventsB.length, countB);
    rawA.close();
    await broker.revokeConnection(rawA.caller.connectionId);
    assert.equal((await b.getState()).selectedTabId, VIEW_DISPLAY_TAB_ID);
  });

  it('does not send one page asset open request to another page', async () => {
    const fixture = engineFixture();
    const transport = createHostTransport();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => { unregister(); transport.close(); await broker.dispose(); });
    const rawA = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    const rawB = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    broker.attachPageSession(rawA.caller, transport);
    broker.attachPageSession(rawB.caller, transport);
    const a = client(rawA, 'view-frontend', 'workspace-test-token');
    const b = client(rawB, 'view-frontend', 'workspace-test-token');
    const eventsB = [];
    b.subscribe((state) => eventsB.push(state));
    await a.openProject('/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    await a.listAssets('project:/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    await a.openAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal((await a.getState()).openRequest?.asset.guid, 'scene-guid');
    assert.equal((await b.getState()).openRequest, null);
    assert.ok(eventsB.every((state) => state.openRequest == null));
  });

  it('directs legacy CLI page operations only when one View page is connected', async () => {
    const fixture = engineFixture();
    const transport = createHostTransport();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => { unregister(); transport.close(); await broker.dispose(); });
    const rawA = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    broker.attachPageSession(rawA.caller, transport);
    const page = client(rawA, 'view-frontend', 'workspace-test-token');
    const cli = client(transport.connect(), 'view-cli', 'workspace-test-token');
    await cli.openProject('/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    await cli.listAssets('project:/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    await page.selectTab(VIEW_DISPLAY_TAB_ID);
    assert.equal((await cli.getState()).selectedTabId, VIEW_DISPLAY_TAB_ID);
    const opened = await cli.openAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal(opened.openRequest?.asset.guid, 'scene-guid');
    assert.equal((await page.getState()).openRequest?.asset.guid, 'scene-guid');
    assert.equal(broker.openRequest, null);
    const callsBefore = fixture.calls.filter(([operation]) => operation === 'asset.open').length;
    const rawB = transport.connect({ kind: 'frontend', sourceId: 'view-frontend' });
    broker.attachPageSession(rawB.caller, transport);
    await assert.rejects(() => cli.openAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID }),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-page-ambiguous');
    assert.equal(fixture.calls.filter(([operation]) => operation === 'asset.open').length, callsBefore);
    assert.equal((await client(rawB, 'view-frontend', 'workspace-test-token').getState()).openRequest, null);
  });

  it('exposes one authoritative tab state and shared project asset results to two clients', async () => {
    const fixture = engineFixture();
    const transport = createHostTransport();
    const broker = new ViewWorkspaceBroker({
      engine: fixture.engine,
      accessToken: 'workspace-test-token',
      display: () => ({ state: 'occupied', occupancy: { targetId: 'cli-target' } }),
    });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => {
      unregister();
      transport.close();
      await broker.dispose();
    });
    const frontend = client(transport.connect(), 'view-frontend', 'workspace-test-token');
    const cli = client(transport.connect(), 'forgeax-cli', 'workspace-test-token');

    const initial = await frontend.getState();
    assert.deepEqual(initial.tabs.map((tab) => tab.tabId), [VIEW_DISPLAY_TAB_ID, VIEW_WORKSPACE_TAB_ID]);
    assert.equal(initial.selectedTabId, VIEW_WORKSPACE_TAB_ID);
    await cli.openProject('/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    const assets = await frontend.listAssets('project:/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal(assets.assets[0].kind, 'scene');
    assert.equal((await cli.getState()).project.id, 'project:/fixture');
    assert.equal(fixture.calls.filter(([name]) => name === 'project.open').length, 1);
    assert.equal(fixture.calls.filter(([name]) => name === 'assets.list').length, 1);

    const listed = () => fixture.calls.filter(([name]) => name === 'assets.list').length;
    const waitListed = async (count) => {
      for (let attempt = 0; attempt < 20 && listed() < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    transport.publish('engine.workspace.state', { catalogEpoch: 0 });
    await waitListed(2);
    assert.equal(listed(), 2);
    transport.publish('engine.workspace.state', { catalogEpoch: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(listed(), 2);
    const assetsBeforeFailure = (await frontend.getState()).assets;
    fixture.engine.listAssets = async () => {
      throw new Error('catalog list failed');
    };
    transport.publish('engine.workspace.state', { catalogEpoch: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual((await frontend.getState()).assets, assetsBeforeFailure);
    assert.equal((await frontend.getState()).workspaceTargetLost, false);

    await frontend.selectTab(VIEW_DISPLAY_TAB_ID);
    const selected = await cli.getState();
    assert.equal(selected.selectedTabId, VIEW_DISPLAY_TAB_ID);
    assert.equal(selected.tabs.find((tab) => tab.kind === 'display').state, 'occupied');
    assert.equal(selected.project.id, 'project:/fixture');
  });

  it('does not republish workspace state when only camera telemetry changes', async () => {
    const fixture = engineFixture();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    const revisions = [];
    broker.subscribe((state) => revisions.push(state.revision));
    const options = { clientId: 'cli', token: 'workspace-test-token' };
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    const afterOpen = revisions.length;
    broker.changed();
    broker.changed();
    assert.equal(revisions.length, afterOpen);
    await broker.call(
      createWorkspaceRequest(
        'asset.open',
        { guid: 'scene-guid', projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
        options,
      ),
    );
    const afterOpenAsset = revisions.length;
    assert.ok(afterOpenAsset > afterOpen);
    const target = (await broker.call(createWorkspaceRequest('tabs.get', {}, options))).preview.target;
    await broker.call(
      createWorkspaceRequest(
        'camera.begin',
        { tabId: VIEW_WORKSPACE_TAB_ID, targetId: target.targetId, targetGeneration: target.generation, baseVersion: 0, interactionId: 'drag-1' },
        options,
      ),
    );
    await broker.call(
      createWorkspaceRequest(
        'camera.update',
        { tabId: VIEW_WORKSPACE_TAB_ID, targetId: target.targetId, targetGeneration: target.generation, interactionId: 'drag-1', camera: camera(3) },
        options,
      ),
    );
    assert.equal(revisions.length, afterOpenAsset);
    await broker.dispose();
  });

  it('keeps scene entity selection on the workspace broker, independent of asset inspection', async () => {
    const fixture = engineFixture();
    const transport = createHostTransport();
    const broker = new ViewWorkspaceBroker({
      engine: fixture.engine,
      accessToken: 'workspace-test-token',
    });
    const unregister = broker.registerTransport(transport);
    cleanup.push(async () => {
      unregister();
      transport.close();
      await broker.dispose();
    });
    const frontend = client(transport.connect(), 'view-frontend', 'workspace-test-token');
    await frontend.openProject('/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    await frontend.openAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID });
    const target = (await frontend.getState()).preview.target;
    const binding = { targetId: target.targetId, targetGeneration: target.generation };
    await frontend.selectSceneEntity('red-box', { label: 'RedBox', tabId: VIEW_WORKSPACE_TAB_ID, ...binding });
    const selected = await frontend.getState();
    assert.deepEqual(selected.sceneSelection, { primary: { entityId: 'red-box', label: 'RedBox' }, ...binding });
    await frontend.inspectAsset('scene-guid', { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID });
    const afterAssetInspect = await frontend.getState();
    assert.equal(afterAssetInspect.inspection.guid, 'scene-guid');
    assert.deepEqual(afterAssetInspect.sceneSelection, { primary: { entityId: 'red-box', label: 'RedBox' }, ...binding });
    await frontend.clearSceneSelection({ tabId: VIEW_WORKSPACE_TAB_ID, ...binding });
    assert.equal((await frontend.getState()).sceneSelection, null);
  });

  it('keeps scene preview target headed and long-lived across independent calls', async () => {
    const fixture = engineFixture();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    await broker.call(
      createWorkspaceRequest(
        'project.open',
        { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
        { clientId: 'cli', token: broker.accessToken },
      ),
    );
    const opened = await broker.call(
      createWorkspaceRequest(
        'asset.open',
        { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
        { clientId: 'cli', token: broker.accessToken },
      ),
    );
    assert.equal(opened.preview.target.sessionId.startsWith('session:'), true);
    assert.equal(opened.preview.target.worldId.startsWith('world:'), true);
    assert.equal(fixture.previews.size, 1);
    const stateAfter = await broker.call(
      createWorkspaceRequest('tabs.get', {}, { clientId: 'frontend', token: broker.accessToken }),
    );
    assert.equal(stateAfter.preview.asset.guid, 'scene-guid');
    assert.equal(stateAfter.preview.target.targetId, opened.preview.target.targetId);
    await broker.dispose();
    assert.equal(fixture.previews.size, 0);
  });

  it('exposes the Engine headed project target before an asset preview is opened', async () => {
    const target = {
      targetId: 'project-target',
      sessionId: 'project-session',
      worldId: 'project-world',
      headed: true,
      width: 1280,
      height: 720,
      url: 'http://127.0.0.1:43123/?forgeaxWorkspace=1',
    };
    const engine = {
      async openProject({ root }) {
        return { project: { id: 'project:headed', root, name: 'Headed' }, target, handle: { root } };
      },
      async closeProject() {},
      async listAssets() { return []; },
      async openPreview() { throw new Error('preview should not be required for project.open'); },
    };
    const broker = new ViewWorkspaceBroker({ engine, accessToken: 'workspace-test-token' });
    const opened = await broker.call(
      createWorkspaceRequest(
        'project.open',
        { root: '/headed', tabId: VIEW_WORKSPACE_TAB_ID },
        { clientId: 'cli', token: broker.accessToken },
      ),
    );
    assert.deepEqual(opened.projectTarget, target);
    assert.deepEqual(opened.tabs.find((tab) => tab.tabId === VIEW_WORKSPACE_TAB_ID).target, target);
    await broker.dispose();
  });

  it('closes the previous Engine project and preview when switching projects', async () => {
    const fixture = engineFixture();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    const options = { clientId: 'cli', token: broker.accessToken };
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/one', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    await broker.call(
      createWorkspaceRequest(
        'asset.open',
        { projectId: 'project:/one', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
        options,
      ),
    );
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/two', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    assert.equal(fixture.previews.size, 0);
    assert.deepEqual(
      fixture.calls.filter(([name]) => name === 'project.close'),
      [['project.close', 'project:/one']],
    );
    assert.equal((await broker.call(createWorkspaceRequest('tabs.get', {}, options))).project.root, '/two');
    await broker.dispose();
  });

  it('commits camera input once, rejects stale versions, and blocks capture during a draft', async () => {
    const fixture = engineFixture();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    const requestOptions = { clientId: 'frontend', token: broker.accessToken };
    await broker.call(
      createWorkspaceRequest(
        'project.open',
        { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
        requestOptions,
      ),
    );
    const state = await broker.call(
      createWorkspaceRequest(
        'asset.open',
        { guid: 'scene-guid', projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
        requestOptions,
      ),
    );
    const targetId = state.preview.target.targetId;
    const targetGeneration = state.preview.target.generation;
    const begun = await broker.call(
      createWorkspaceRequest(
        'camera.begin',
        { tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration, baseVersion: 0, interactionId: 'interaction-1' },
        requestOptions,
      ),
    );
    assert.equal(begun.interactionId, 'interaction-1');
    const draft = await broker.call(
      createWorkspaceRequest(
        'camera.get',
        { tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration },
        requestOptions,
      ),
    );
    assert.equal(draft.committed, false);
    await assert.rejects(
      broker.call(
        createWorkspaceRequest('preview.capture', { tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration }, requestOptions),
      ),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-target-busy',
    );
    await broker.call(
      createWorkspaceRequest(
        'camera.update',
        { tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration, interactionId: 'interaction-1', camera: camera(3) },
        requestOptions,
      ),
    );
    const committed = await broker.call(
      createWorkspaceRequest(
        'camera.commit',
        {
          tabId: VIEW_WORKSPACE_TAB_ID,
          targetId, targetGeneration,
          interactionId: 'interaction-1',
          operationId: 'commit-1',
          expectedVersion: 0,
          camera: camera(3),
        },
        requestOptions,
      ),
    );
    const retried = await broker.call(
      createWorkspaceRequest(
        'camera.commit',
        {
          tabId: VIEW_WORKSPACE_TAB_ID,
          targetId, targetGeneration,
          interactionId: 'interaction-1',
          operationId: 'commit-1',
          expectedVersion: 0,
          camera: camera(3),
        },
        requestOptions,
      ),
    );
    assert.deepEqual(retried, committed);
    assert.equal(fixture.calls.filter(([name]) => name === 'camera.commit').length, 2);
    await assert.rejects(
      broker.call(
        createWorkspaceRequest(
          'camera.begin',
          { tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration, baseVersion: 0, interactionId: 'stale' },
          requestOptions,
        ),
      ),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-camera-conflict',
    );
    const capture = await broker.call(
      createWorkspaceRequest('preview.capture', { tabId: VIEW_WORKSPACE_TAB_ID, targetId, targetGeneration }, requestOptions),
    );
    assert.equal(capture.targetId, targetId);
  });

  it('requires the issued token and keeps CLI display selection read-only', async () => {
    const fixture = engineFixture();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    await assert.rejects(
      broker.call(createWorkspaceRequest('tabs.get', {}, { clientId: 'bad', token: 'wrong-token' })),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-unauthorized',
    );
    await assert.rejects(
      broker.call(
        createWorkspaceRequest(
          'tabs.select',
          { tabId: 'missing-tab' },
          { clientId: 'cli', token: broker.accessToken },
        ),
      ),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-tab-not-found',
    );
    await assert.rejects(
      broker.call(
        createWorkspaceRequest(
          'project.open',
          { root: '/fixture', tabId: VIEW_DISPLAY_TAB_ID },
          { clientId: 'cli', token: broker.accessToken },
        ),
      ),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-tab-read-only',
    );
  });

  it('reports a missing Engine workspace capability instead of inventing a preview', async () => {
    const broker = new ViewWorkspaceBroker({ accessToken: 'workspace-test-token' });
    assert.equal(broker.capabilities().ready, false);
    await assert.rejects(
      broker.call(
        createWorkspaceRequest(
          'project.open',
          { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
          {
            clientId: 'cli',
            token: broker.accessToken,
          },
        ),
      ),
      (error) => {
        assert.equal(error instanceof ViewWorkspaceError, true);
        assert.equal(error.code, 'view-workspace-operation-unavailable');
        assert.equal(error.detail.operation, 'project.open');
        assert.equal(error.detail.description, undefined);
        return true;
      },
    );
    await broker.dispose();
  });

  it('keeps Engine operations available without a display and treats tabId as an optional binding', async () => {
    const fixture = engineFixture();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, display: () => ({ state: 'unavailable' }) });
    cleanup.push(() => broker.dispose());
    const options = { clientId: 'cli', token: broker.accessToken };
    assert.equal(broker.capabilities().ready, true);
    await broker.call(createWorkspaceRequest('project.open', { root: '/fixture' }, options));
    const assets = await broker.call(createWorkspaceRequest('assets.list', { projectId: 'project:/fixture' }, options));
    assert.equal(assets.assets[0].guid, 'scene-guid');
    await assert.rejects(broker.call(createWorkspaceRequest('assets.list', { projectId: 'other' }, options)));
    await broker.call(createWorkspaceRequest('tabs.select', { tabId: VIEW_DISPLAY_TAB_ID }, options));
    assert.equal((await broker.call(createWorkspaceRequest('assets.list', { projectId: 'project:/fixture' }, options))).assets.length, 2);
  });
});

it('exposes a Play target to preview observers only after its browser is ready', async () => {
  const play = {
    target: { targetId: 'play-target', generation: 1 },
    asset: { guid: 'scene-guid', kind: 'scene' },
    phase: 'starting',
  };
  const broker = new RawViewWorkspaceBroker({ engine: { play, previews: [] } });
  cleanup.push(() => broker.dispose());

  const starting = broker.snapshot();
  assert.equal(starting.play?.phase, 'starting');
  assert.equal(starting.targetBinding, 'play');
  assert.equal(starting.preview, null);

  play.phase = 'running';
  assert.equal(broker.snapshot().preview?.target.targetId, 'play-target');

  play.phase = 'failed';
  assert.equal(broker.snapshot().preview, null);
});

describe('View workspace frontend boundary', () => {
  it('rejects a normal content-browser Frontend Plugin without panelHost', async () => {
    const fixture = engineFixture();
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
      workspaceEngine: fixture.engine,
      frontend: false,
    });
    cleanup.push(() => view.dispose());
    const browserDocument = fakeDocument();
    const browserWindow = { addEventListener() {}, removeEventListener() {} };
    await assert.rejects(
      mountViewWorkspace({
        endpoint: view.workspaceEndpoint,
        token: view.workspaceAccessToken,
        WebSocket: NodeWebSocket,
        document: browserDocument,
        window: browserWindow,
      }),
      (error) =>
        /requires (panelHost|pageHost)/.test(error.message) ||
        /requires (panelHost|pageHost)/.test(error.detail?.cause?.message ?? ''),
    );
  });

  it('wires the frontend client to the backend workspace plugin through the paired Host', async () => {
    const fixture = engineFixture();
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
      workspaceEngine: fixture.engine,
    });
    cleanup.push(() => view.dispose());
    const frontend = view.frontendHost.context.get('viewOperationClient');
    assert.equal(frontend.clientId, 'view-frontend');
    await frontend.openProject('/fixture', { tabId: VIEW_WORKSPACE_TAB_ID });
    const current = await frontend.getState();
    const assets = await frontend.listAssets(current.project.id, { tabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal(assets.assets.some((asset) => asset.kind === 'scene'), true);
    assert.equal(view.workspaceCore, view.backendHost.context.get('viewWorkspaceCore'));
  });

  it('keeps an independent frontend session separate from the resident CLI project', async () => {
    const fixture = engineFixture();
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
      workspaceEngine: fixture.engine,
    });
    cleanup.push(() => view.dispose());
    assert.equal(typeof view.workspaceEndpoint, 'string');
    await assert.rejects(
      connectViewWorkspace({
        endpoint: view.workspaceEndpoint,
        token: 'wrong-token',
        clientId: 'external-cli',
      }),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-unauthorized',
    );
    const cli = await connectViewWorkspace({
      endpoint: view.workspaceEndpoint,
      token: view.workspaceAccessToken,
      clientId: 'external-cli',
    });
    cleanup.push(() => cli.close('test-cleanup'));
    await cli.openProject('/external-cli', { tabId: VIEW_WORKSPACE_TAB_ID });
    const frontend = view.frontendHost.context.get('viewOperationClient');
    const intent = await frontend.getState();
    assert.equal(intent.project, null);
    assert.deepEqual(intent.projectIntent, { root: '/external-cli' });
    await frontend.openProject('/frontend', { tabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal((await frontend.getState()).project.root, '/frontend');
    assert.equal(
      (await cli.listAssets('project:/external-cli', { tabId: VIEW_WORKSPACE_TAB_ID })).assets[0].kind,
      'scene',
    );
    await assert.rejects(
      cli.openAsset('missing-guid', {
        projectId: 'project:/external-cli',
        tabId: VIEW_WORKSPACE_TAB_ID,
      }),
      (error) => error instanceof ViewWorkspaceError && error.code === 'view-workspace-asset-not-found',
    );
  });

  it('decodes official remote View business codes carried by a Host transport error', async () => {
    const failures = {
      capability: {
        code: 'view-engine-capability-unavailable',
        expected: 'Engine workspace capability project.open to be installed',
        hint: 'Build and install the matching Engine workspace plugin before opening a project.',
        detail: { capability: 'project.open' },
      },
      asset: {
        code: 'view-workspace-asset-unsupported',
        expected: 'Engine asset.open to support asset kind material',
        hint: 'Use an Engine type-preview capability for this asset kind.',
        detail: { kind: 'material' },
      },
    };
    const transport = {
      request(_service, request) {
        const failure = request.operation === 'asset.open' ? failures.asset : failures.capability;
        return Promise.reject(
          Object.assign(new Error(failure.hint), {
            name: 'HostAssemblyError',
            code: 'host-transport-failure',
            expected: failure.expected,
            hint: failure.hint,
            detail: {
              service: 'host/socket',
              reason: 'remote workspace operation failed',
              remoteCode: failure.code,
              ...failure.detail,
            },
          }),
        );
      },
    };
    const workspace = client(transport, 'independent-cli', 'workspace-token');
    await assert.rejects(workspace.openProject('/fixture'), (error) => {
      assert.equal(error instanceof ViewWorkspaceError, true);
      assert.equal(error.code, failures.capability.code);
      assert.equal(error.expected, failures.capability.expected);
      assert.equal(error.hint, failures.capability.hint);
      assert.equal(error.detail.remoteCode, failures.capability.code);
      return true;
    });
    await assert.rejects(
      workspace.openAsset('material-guid', {
        projectId: 'project:/fixture',
        tabId: VIEW_WORKSPACE_TAB_ID,
      }),
      (error) => {
        assert.equal(error instanceof ViewWorkspaceError, true);
        assert.equal(error.code, failures.asset.code);
        assert.equal(error.expected, failures.asset.expected);
        assert.equal(error.hint, failures.asset.hint);
        assert.equal(error.detail.remoteCode, failures.asset.code);
        return true;
      },
    );
  });

  it('samples input through API calls and renders no local camera authority', async () => {
    const calls = [];
    const api = {
      async getCamera() {
        calls.push('get');
        return { version: 0, camera: camera() };
      },
      async beginCamera(value) {
        calls.push(['begin', value.baseVersion]);
        return { interactionId: 'input-1', baseVersion: 0, camera: camera() };
      },
      async updateCamera(value) {
        calls.push(['update', value.input]);
        return { camera: camera(1) };
      },
      async commitCamera(value) {
        calls.push(['commit', {
          interactionId: value.interactionId,
          expectedVersion: value.expectedVersion,
          camera: value.camera,
        }]);
      },
      async abortCamera(value) {
        calls.push(['abort', value.reason]);
      },
    };
    const controller = new ViewWorkspaceInputController({
      api,
      targetId: 'target-1',
      interactionIdFactory: () => 'input-1',
    });
    await controller.begin();
    controller.queueInput({ type: 'pointer-move', movementX: 2, movementY: -1 });
    await controller.finish();
    assert.deepEqual(calls.map((value) => (Array.isArray(value) ? value[0] : value)), [
      'get',
      'begin',
      'update',
      'commit',
    ]);
    assert.deepEqual(calls[2][1], { type: 'look', yaw: -0.006, pitch: 0.003,
      pitchLimit: Math.PI / 2 - 0.01, distance: 5 });
    assert.deepEqual(calls[3][1], {
      interactionId: 'input-1',
      expectedVersion: 0,
      camera: undefined,
    });
  });

  it('commits with the begin-time version when Engine omits baseVersion', async () => {
    const calls = [];
    const api = {
      async getCamera() {
        return { version: 4, camera: camera() };
      },
      async beginCamera(value) {
        calls.push(['begin', value.interactionId, value.baseVersion]);
        return { camera: camera(), version: 4 };
      },
      async updateCamera() {
        return {};
      },
      async commitCamera(value) {
        calls.push(['commit', value.interactionId, value.expectedVersion]);
      },
      async abortCamera() {
        calls.push('abort');
      },
    };
    const controller = new ViewWorkspaceInputController({
      api,
      targetId: 'target-1',
      interactionIdFactory: () => 'local-interaction',
    });
    await controller.begin();
    await controller.finish();
    assert.deepEqual(calls, [
      ['begin', 'local-interaction', 4],
      ['commit', 'local-interaction', 4],
    ]);
  });

  it('serializes an immediate pointer-up behind the in-flight begin transaction', async () => {
    let resolveCamera;
    const calls = [];
    const api = {
      getCamera: () => {
        calls.push('get');
        return new Promise((resolve) => {
          resolveCamera = resolve;
        });
      },
      async beginCamera(value) {
        calls.push('begin');
        return { interactionId: value.interactionId, baseVersion: 0, camera: camera() };
      },
      async updateCamera(value) {
        calls.push('update');
        return { camera: value.input ? camera(1) : value.camera };
      },
      async commitCamera() {
        calls.push('commit');
      },
      async abortCamera() {
        calls.push('abort');
      },
    };
    const controller = new ViewWorkspaceInputController({
      api,
      targetId: 'target-1',
      interactionIdFactory: () => 'interaction-1',
    });
    const begin = controller.begin();
    controller.queueInput({ type: 'pointer-move', movementX: 1, movementY: 0 });
    const finish = controller.finish();
    resolveCamera({ version: 0, camera: camera() });
    await Promise.all([begin, finish]);
    assert.deepEqual(calls, ['get', 'begin', 'update', 'commit']);
  });

  it('does not abort a pointer transaction when an optional lock was never granted', async () => {
    const calls = [];
    const api = {
      async getCamera() {
        return { version: 0, camera: camera() };
      },
      async beginCamera(value) {
        calls.push('begin');
        return { interactionId: value.interactionId, baseVersion: 0, camera: camera() };
      },
      async updateCamera(value) {
        calls.push('update');
        return { camera: value.camera ?? camera(1), version: 0 };
      },
      async commitCamera() {
        calls.push('commit');
      },
      async abortCamera() {
        calls.push('abort');
      },
    };
    const document = {
      pointerLockElement: null,
      listeners: new Map(),
      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      },
      removeEventListener(type) {
        this.listeners.delete(type);
      },
    };
    const element = new FakeElement('div');
    const controller = new ViewWorkspaceInputController({
      api,
      targetId: 'target-1',
      interactionIdFactory: () => 'interaction-1',
      document,
      window: { addEventListener() {}, removeEventListener() {} },
    });
    const remove = controller.attach(element);
    await controller.begin();
    // Browsers may emit a pointerlockchange after rejecting an optional lock
    // request. Since no lock was ever engaged, this must not abort the API
    // transaction.
    document.listeners.get('pointerlockchange')();
    controller.queueInput({ type: 'pointer-move', movementX: 1, movementY: 0 });
    await controller.finish();
    assert.deepEqual(calls, ['begin', 'update', 'commit']);
    remove('input-disposed');
  });

  it('can be constructed without a DOM and keeps presentation behind the API', () => {
    const shell = new ViewWorkspaceShell();
    assert.deepEqual(shell.snapshot().assets, []);
    shell.update({ selectedTabId: VIEW_DISPLAY_TAB_ID, tabs: [{ tabId: VIEW_DISPLAY_TAB_ID }] });
    assert.equal(shell.snapshot().selectedTabId, VIEW_DISPLAY_TAB_ID);
    shell.dispose();
  });

  it('uses a supplied mount element when document lookup cannot see it', () => {
    const document = fakeDocument();
    const host = document.createElement('div');
    const mount = document.createElement('div');
    mount.id = 'forgeax-view-workspace';
    host.append?.(mount);
    const shell = new ViewWorkspaceShell({ document, element: mount });
    assert.equal(shell.element, mount);
    assert.equal(mount.parentNode, host);
    assert.equal(document.body.children.includes(mount), false);
    shell.dispose();
  });

  it('consumes the Engine outer preview operation shape while keeping handle opaque', async () => {
    let closed = 0;
    const target = {
      targetId: 'outer-target',
      sessionId: 'session',
      worldId: 'world',
      headed: true,
      width: 640,
      height: 480,
    };
    const preview = {
      target,
      handle: { app: {}, world: {}, sceneRoot: {} },
      async getCamera() {
        return { camera: camera(), version: 3 };
      },
      async close() {
        closed += 1;
      },
    };
    const adapter = createEngineWorkspaceAdapter({
      async openProject() {
        return { project: { id: 'project', root: '/project' }, handle: {} };
      },
      async closeProject() {},
      async listAssets() {
        return [];
      },
      async openPreview() {
        return preview;
      },
    });
    const opened = await adapter.openPreview({
      project: { id: 'project', root: '/project' },
      asset: { guid: 'scene', kind: 'scene' },
      width: 640,
      height: 480,
    });
    assert.equal((await adapter.getCamera(opened, { targetId: target.targetId })).version, 3);
    await adapter.closePreview(opened, { targetId: target.targetId });
    assert.equal(closed, 1);
  });

  it('maps the Engine generated unsupported-preview capability to the View contract', async () => {
    const adapter = createEngineWorkspaceAdapter({
      async openProject() {
        return { project: { id: 'project', root: '/project' }, handle: {} };
      },
      async closeProject() {},
      async listAssets() {
        return [];
      },
      async openPreview() {
        throw Object.assign(
          new Error('Engine workspace preview capability is unavailable for asset kind material'),
          {
            code: 'engine-workspace-preview-capability-unavailable',
            expected: 'an Engine type-preview owner for this asset kind',
            hint: 'Select a SceneAsset or an Engine-owned material, mesh, texture, or VFX asset.',
            detail: { kind: 'material' },
          },
        );
      },
    });

    await assert.rejects(
      adapter.openPreview({
        project: { id: 'project', root: '/project' },
        asset: { guid: 'material', kind: 'material' },
        width: 640,
        height: 480,
      }),
      (error) => {
        assert.equal(error instanceof ViewWorkspaceError, true);
        assert.equal(error.code, 'view-workspace-asset-unsupported');
        assert.equal(error.expected, 'Engine asset.open to support asset kind material');
        assert.equal(error.hint, 'Use an Engine type-preview capability for this asset kind.');
        assert.deepEqual(error.detail, { kind: 'material' });
        return true;
      },
    );
  });

  it('generates request and interaction IDs without importing a Node runtime module', () => {
    const request = createWorkspaceRequest('tabs.get', {}, { clientId: 'client' });
    assert.match(request.requestId, /^request:/);
    assert.match(createWorkspaceId('interaction'), /^interaction:/);
  });

  it('presents stable Engine targets for both tabs and selects visibility without duplicating targets', async () => {
    const document = fakeDocument();
    const window = { addEventListener() {}, removeEventListener() {} };
    const attached = [];
    const removed = [];
    const presentation = {
      async attach({ target, element }) {
        attached.push([target.targetId, element]);
        return () => removed.push(target.targetId);
      },
    };
    const shell = new ViewWorkspaceShell({ document, window, presentation });
    const workspaceTarget = {
      targetId: 'workspace-target',
      sessionId: 'workspace-session',
      worldId: 'workspace-world',
      headed: true,
      width: 800,
      height: 600,
    };
    const displayTarget = {
      targetId: 'cli-target',
      sessionId: 'cli-session',
      worldId: 'cli-world',
      headed: true,
      width: 1024,
      height: 768,
    };
    const state = {
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target: displayTarget },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target: workspaceTarget },
      ],
      project: { id: 'project', root: '/project', name: 'Project' },
      editorPreview: { asset: { guid: 'scene', kind: 'scene', name: 'Scene' }, target: workspaceTarget },
      assets: [],
    };
    shell.update(state);
    await new Promise((resolve) => setImmediate(resolve));
    const displaySurface = shell.surfaceByTab.get(VIEW_DISPLAY_TAB_ID).surface;
    const workspaceSurface = shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID).surface;
    assert.equal(shell.surfaceByTab.size, 2);
    assert.equal(displaySurface.hidden, false);
    assert.equal(workspaceSurface.hidden, true);
    assert.notEqual(displaySurface, workspaceSurface);
    shell.update({ ...state, selectedTabId: VIEW_WORKSPACE_TAB_ID });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shell.surfaceByTab.get(VIEW_DISPLAY_TAB_ID).surface, displaySurface);
    assert.equal(shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID).surface, workspaceSurface);
    assert.equal(displaySurface.hidden, true);
    assert.equal(workspaceSurface.hidden, false);
    // Stop revokes Game observations before native startup/cleanup completes.
    // The Editor must not resume its Renderer while that starting Play is retained.
    const returning = { ...state, selectedTabId: VIEW_WORKSPACE_TAB_ID, targetBinding: 'editor',
      play: { target: { ...workspaceTarget, targetId: 'game-target' }, phase: 'starting' } };
    shell.update(returning);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workspaceSurface.hidden, true);
    shell.update({ ...returning, play: { ...returning.play, phase: 'running' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workspaceSurface.hidden, false);
    assert.deepEqual(attached.map(([targetId]) => targetId).sort(), ['cli-target', 'workspace-target']);
    await shell.dispose();
    assert.deepEqual(removed.sort(), ['cli-target', 'workspace-target']);
  });

  it('keeps inert target surfaces stable without loading target URLs', async () => {
    const document = fakeDocument();
    const shell = new ViewWorkspaceShell({
      document,
      window: { addEventListener() {}, removeEventListener() {} },
    });
    const target = {
      targetId: 'headed-target',
      sessionId: 'headed-session',
      worldId: 'headed-world',
      headed: true,
      width: 640,
      height: 480,
      url: 'http://127.0.0.1:9000/engine-target',
    };
    const state = {
      selectedTabId: VIEW_WORKSPACE_TAB_ID,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display' },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target },
      ],
      project: { id: 'project', root: '/project' },
      editorPreview: { asset: { guid: 'scene', kind: 'scene' }, target },
      assets: [],
    };
    shell.update(state);
    const root = shell.rootElement;
    const targets = shell.targetContainer;
    const surface = shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID).surface;
    const sourceAssignments = surface.srcAssignments;
    assert.equal(surface.tagName, 'canvas');
    assert.equal(surface.src, undefined);
    shell.update({ ...state, editorPreview: { ...state.editorPreview, target: { ...target } } });
    assert.equal(shell.rootElement, root);
    assert.equal(shell.targetContainer, targets);
    assert.equal(shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID).surface, surface);
    assert.equal(surface.src, undefined);
    assert.equal(surface.srcAssignments, sourceAssignments);
    await shell.dispose();
  });

  it('waits for the exact provisional project surface without loading its URL', async () => {
    const target = {
      targetId: 'project-target',
      sessionId: 'project-session',
      worldId: 'project-world',
      headed: true,
      width: 1280,
      height: 720,
      url: 'http://127.0.0.1:43123/?forgeaxWorkspace=1',
    };
    const attached = [];
    const shell = new ViewWorkspaceShell({
      document: fakeDocument(),
      presentation: {
        surfacePlacement: 'owner',
        attach() {
          attached.push('unexpected');
          throw new Error('a provisional URL target is not an owned Engine surface');
        },
      },
    });
    shell.update({
      selectedTabId: VIEW_WORKSPACE_TAB_ID,
      tabs: [{ tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target }],
      project: { id: 'project:headed', root: '/headed', name: 'Headed' },
      projectTarget: target,
      preview: null,
      assets: [],
    });
    assert.equal(shell.surfaceByTab.has(VIEW_WORKSPACE_TAB_ID), false);
    assert.equal(shell.targetContainer.children.length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(attached, []);
    assert.equal(shell.state.error, null);
    await shell.dispose();
  });

  it('prefers the exact workspace surface over its generated URL', async () => {
    const document = fakeDocument();
    const surface = document.createElement('canvas');
    const target = {
      targetId: 'same-document', headed: true, width: 1280, height: 720,
      url: 'http://127.0.0.1:43123/?forgeaxWorkspace=1',
    };
    let acquisitions = 0;
    const shell = new ViewWorkspaceShell({ document, presentation: {
      workspace: { surfacePlacement: 'owner', createSurface: () => { acquisitions += 1; return surface; } },
    } });
    const state = {
      selectedTabId: VIEW_WORKSPACE_TAB_ID,
      tabs: [{ tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target }],
      project: { id: 'project', root: '/project' }, projectTarget: target,
      editorPreview: { asset: { guid: 'scene', kind: 'scene' }, target }, assets: [],
    };
    shell.update(state);
    assert.equal(shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID).surface, surface);
    shell.ensureSurface(VIEW_WORKSPACE_TAB_ID, target);
    assert.equal(acquisitions, 1, 'An Engine owner without carrier lease fields is not repeatedly reacquired');
    shell.update(state);
    assert.equal(shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID).surface, surface);
    assert.equal(surface.src, undefined);
    await shell.dispose();
  });

  it('restores a createSurface-only Editor before removing the viewport, including its sibling position', async () => {
    const document = fakeDocument();
    const surface = document.createElement('div');
    const canvas = document.createElement('canvas');
    const sibling = document.createElement('aside');
    surface.append(canvas);
    document.body.append(surface, sibling);
    surface.id = 'app-shell';
    const lookup = document.getElementById;
    document.getElementById = id => id === surface.id ? surface : lookup(id);
    let acquisitions = 0;
    const shell = new ViewWorkspaceShell({ document, presentation: { workspace: {
      surfacePlacement: 'shell', createSurface: () => { acquisitions++; return surface; },
    } } });
    const target = { targetId: 'editor', generation: 1 };
    const state = { selectedTabId: VIEW_WORKSPACE_TAB_ID, project: { id: 'project', root: '/project' },
      editorPreview: { target, asset: { guid: 'scene', kind: 'scene' } }, assets: [], tabs: [] };
    shell.update(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(surface.parentNode, shell.targetContainer);
    shell.update(state);
    assert.equal(acquisitions, 1);
    const disposing = shell.dispose();
    assert.equal(shell.dispose(), disposing, 'Repeated disposal waits for the same cleanup');
    assert.equal(surface.parentNode, document.body, 'DOM restoration is synchronous');
    assert.equal(surface.nextSibling, sibling);
    assert.equal(canvas.parentNode, surface);
    await disposing;
    await shell.dispose();
    assert.equal(surface.parentNode, document.body);
  });

  it('returns the bootstrap Engine surface before the viewport is removed without a preview target', async () => {
    const document = fakeDocument();
    const surface = document.createElement('div');
    surface.id = 'app-shell';
    const canvas = document.createElement('canvas');
    surface.append(canvas);
    document.body.append(surface);
    const lookup = document.getElementById;
    document.getElementById = id => id === surface.id ? surface : lookup(id);
    const shell = new ViewWorkspaceShell({ document });
    assert.equal(surface.parentNode, shell.targetContainer);
    const disposed = shell.dispose();
    assert.equal(surface.parentNode, document.body, 'The startup canvas survives synchronous dock removal');
    await disposed;
    assert.equal(canvas.parentNode, surface);
  });

  it('guards shell placement by generation and reacquires only after the previous attach drains', async () => {
    const document = fakeDocument();
    const oldSurface = document.createElement('div');
    const newSurface = document.createElement('div');
    document.body.append(oldSurface, newSurface);
    let finish;
    const events = [];
    const shell = new ViewWorkspaceShell({ document, presentation: { workspace: {
      surfacePlacement: 'shell',
      createSurface({ target }) { events.push(`create:${target.generation}`); return target.generation === 1 ? oldSurface : newSurface; },
      async attach({ target }) {
        events.push(`attach:${target.generation}`);
        if (target.generation === 1) await new Promise(resolve => { finish = resolve; });
        return () => events.push(`detach:${target.generation}`);
      },
    } } });
    const state = generation => ({ selectedTabId: VIEW_WORKSPACE_TAB_ID, project: { id: 'project', root: '/project' },
      editorPreview: { target: { targetId: 'editor', generation }, asset: { guid: 'scene', kind: 'scene' } }, assets: [], tabs: [] });
    shell.update(state(1));
    await new Promise(resolve => setImmediate(resolve));
    shell.update(state(2));
    shell.update(state(2));
    assert.deepEqual(events, ['create:1', 'attach:1']);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['create:1', 'attach:1', 'detach:1', 'create:2', 'attach:2']);
    assert.equal(oldSurface.parentNode, document.body);
    assert.equal(newSurface.parentNode, shell.targetContainer);
    await shell.dispose();
    assert.equal(newSurface.parentNode, document.body);
  });

  it('releases presentation listeners without waiting for remote input disposal', async () => {
    const document = fakeDocument();
    const surface = document.createElement('div');
    document.body.append(surface);
    let released = false;
    let finishInput;
    const shell = new ViewWorkspaceShell({ document, presentation: { workspace: {
      createSurface: () => surface, attach: () => () => { released = true; },
    } } });
    shell.update({ selectedTabId: VIEW_WORKSPACE_TAB_ID, project: { id: 'project', root: '/project' },
      editorPreview: { target: { targetId: 'editor', generation: 1 }, asset: { guid: 'scene', kind: 'scene' } }, assets: [], tabs: [] });
    await new Promise(resolve => setImmediate(resolve));
    shell.inputController = { dispose: () => new Promise(resolve => { finishInput = resolve; }) };
    const disposing = shell.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, true, 'Resize listeners stop before waiting for remote input cleanup');
    finishInput();
    await disposing;
  });

  it('does not fabricate a shell-placed surface when the exact adapter is unavailable', async () => {
    const shell = new ViewWorkspaceShell({ document: fakeDocument(), presentation: { workspace: {
      surfacePlacement: 'shell', createSurface: () => null,
    } } });
    shell.update({ selectedTabId: VIEW_WORKSPACE_TAB_ID, project: { id: 'project', root: '/project' },
      editorPreview: { target: { targetId: 'editor', generation: 1 }, asset: { guid: 'scene', kind: 'scene' } }, assets: [], tabs: [] });
    assert.equal(shell.surface, null);
    assert.equal(shell.targetContainer.children.length, 0);
    await shell.dispose();
  });

  it('restores a borrowed Editor even when its adapter attachment fails', async () => {
    const document = fakeDocument();
    const surface = document.createElement('div');
    document.body.append(surface);
    const shell = new ViewWorkspaceShell({ document, presentation: { workspace: {
      createSurface: () => surface, attach: () => { throw new Error('attachment failed'); },
    } } });
    shell.update({ selectedTabId: VIEW_WORKSPACE_TAB_ID, project: { id: 'project', root: '/project' },
      editorPreview: { target: { targetId: 'editor', generation: 1 }, asset: { guid: 'scene', kind: 'scene' } }, assets: [], tabs: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shell.state.error, 'attachment failed');
    assert.equal(surface.parentNode, document.body);
    await shell.dispose();
  });

  it('does not clone a display target URL into a second iframe', async () => {
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    const displayTarget = {
      targetId: 'cli-display-target',
      sessionId: 'cli-display-session',
      worldId: 'cli-display-world',
      headed: true,
      width: 1280,
      height: 720,
      url: 'http://127.0.0.1:43124/engine-display',
    };
    const workspaceTarget = {
      targetId: 'workspace-target',
      sessionId: 'workspace-session',
      worldId: 'workspace-world',
      headed: true,
      width: 1280,
      height: 720,
      url: 'http://127.0.0.1:43125/?forgeaxWorkspace=1',
    };
    shell.update({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target: displayTarget },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target: workspaceTarget },
      ],
      project: { id: 'project', root: '/project' },
      projectTarget: workspaceTarget,
      preview: null,
      assets: [],
    });

    const displayEntry = shell.surfaceByTab.get(VIEW_DISPLAY_TAB_ID);
    const workspaceEntry = shell.surfaceByTab.get(VIEW_WORKSPACE_TAB_ID);
    assert.equal(displayEntry.surface.tagName, 'canvas');
    assert.equal(displayEntry.surface.dataset.forgeaxViewSurface, 'engine-target');
    assert.equal(displayEntry.surface.srcAssignments, 0);
    assert.equal(workspaceEntry, undefined, 'A project target alone is not an Editor scene surface');
    await shell.dispose();
  });

  it('waits without fabricating a surface until the display Fiber iframe exists', async () => {
    const document = fakeDocument();
    let displaySurface;
    document.querySelectorAll = (selector) =>
      selector === 'iframe[data-forgeax-view-surface="engine-target"]' && displaySurface
        ? [displaySurface]
        : [];
    const shell = new ViewWorkspaceShell({
      document,
      presentation: createBrowserPagePresentation({ document }),
    });
    const displayTarget = {
      targetId: 'cli-display-target',
      leaseId: 'lease-bootstrap',
      generation: 1,
      surfaceId: 'forgeax-view-display-surface',
      headed: true,
    };
    const snapshot = {
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [{ tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target: displayTarget }],
      project: null,
      preview: null,
      assets: [],
    };
    shell.update(snapshot);
    assert.equal(shell.surfaceByTab.has(VIEW_DISPLAY_TAB_ID), false);
    assert.equal(shell.surface, null);

    displaySurface = document.createElement('iframe');
    displaySurface.id = displayTarget.surfaceId;
    displaySurface.dataset.forgeaxViewSurface = 'engine-target';
    displaySurface.dataset.forgeaxViewTargetId = displayTarget.targetId;
    displaySurface.dataset.forgeaxViewLeaseId = displayTarget.leaseId;
    displaySurface.dataset.forgeaxViewGeneration = String(displayTarget.generation);
    document.body.append(displaySurface);
    shell.update(snapshot);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shell.surfaceByTab.get(VIEW_DISPLAY_TAB_ID).surface, displaySurface);
    await shell.dispose();
  });

  it('reuses the platform-owned display iframe without moving its browsing context', async () => {
    const document = fakeDocument();
    const displaySurface = document.createElement('iframe');
    displaySurface.id = 'forgeax-display-lease-1';
    displaySurface.dataset.forgeaxViewSurface = 'engine-target';
    displaySurface.dataset.forgeaxViewTargetId = 'cli-display-target';
    displaySurface.dataset.forgeaxViewLeaseId = 'lease-1';
    displaySurface.dataset.forgeaxViewGeneration = '7';
    document.body.append(displaySurface);
    document.querySelectorAll = (selector) =>
      selector === 'iframe[data-forgeax-view-surface="engine-target"]' ? [displaySurface] : [];
    const shell = new ViewWorkspaceShell({
      document,
      presentation: createBrowserPagePresentation({ document }),
    });
    const displayTarget = {
      targetId: 'cli-display-target',
      leaseId: 'lease-1',
      generation: 7,
      surfaceId: 'forgeax-display-lease-1',
      headed: true,
      width: 320,
      height: 240,
    };
    shell.update({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [{ tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target: displayTarget }],
      project: null,
      preview: null,
      assets: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shell.surfaceByTab.get(VIEW_DISPLAY_TAB_ID).surface, displaySurface);
    assert.equal(displaySurface.parentNode, document.body);
    assert.equal(shell.targetContainer.children.includes(displaySurface), false);
    await shell.dispose();
    assert.equal(displaySurface.parentNode, document.body);
  });

  it('uses a host-provided display canvas without hiding its Engine runtime', async () => {
    const document = fakeDocument();
    const displayCanvas = document.createElement('canvas');
    const attached = [];
    const presentation = {
      display: {
        createSurface({ target, tabId }) {
          attached.push(['create', tabId, target.targetId]);
          return displayCanvas;
        },
        attach({ target, element }) {
          attached.push(['attach', target.targetId, element]);
          return () => attached.push(['detach', target.targetId]);
        },
      },
    };
    const shell = new ViewWorkspaceShell({ document, presentation });
    const displayTarget = {
      targetId: 'cli-display-target',
      sessionId: 'cli-display-session',
      worldId: 'cli-display-world',
      headed: true,
      width: 1280,
      height: 720,
    };
    const workspaceTarget = {
      targetId: 'workspace-target',
      sessionId: 'workspace-session',
      worldId: 'workspace-world',
      headed: true,
      width: 1280,
      height: 720,
      url: 'http://127.0.0.1:43125/?forgeaxWorkspace=1',
    };
    const state = {
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target: displayTarget },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target: workspaceTarget },
      ],
      project: { id: 'project', root: '/project' },
      projectTarget: workspaceTarget,
      preview: null,
      assets: [],
    };
    shell.update(state);
    await new Promise((resolve) => setImmediate(resolve));
    const displayEntry = shell.surfaceByTab.get(VIEW_DISPLAY_TAB_ID);
    assert.equal(displayEntry.surface, displayCanvas);
    assert.equal(displayEntry.exactSurface, true);
    assert.equal(displayCanvas.hidden, false);
    assert.equal(displayCanvas.style.visibility, 'visible');
    shell.update({ ...state, selectedTabId: VIEW_WORKSPACE_TAB_ID });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(displayCanvas.hidden, false);
    assert.equal(displayCanvas.style.visibility, 'hidden');
    assert.equal(displayCanvas.style.pointerEvents, 'none');
    assert.deepEqual(
      attached.filter(([kind]) => kind === 'create' || kind === 'attach').map(([, value]) => value),
      [VIEW_DISPLAY_TAB_ID, 'cli-display-target'],
    );
    await shell.dispose();
    assert.deepEqual(attached.at(-1), ['detach', 'cli-display-target']);
  });

  it('serializes exact-surface cleanup before replacing an attachment', async () => {
    const document = fakeDocument();
    const displayCanvas = document.createElement('canvas');
    document.body.append(displayCanvas);
    const events = [];
    let releaseFirstAttach;
    const presentation = {
      display: {
        createSurface() {
          events.push('create');
          return displayCanvas;
        },
        attach({ target }) {
          events.push(`attach:${target.targetId}`);
          if (target.targetId === 'target-a') {
            return new Promise((resolve) => {
              releaseFirstAttach = () =>
                resolve(() => {
                  events.push('cleanup:target-a');
                  document.body.append(displayCanvas);
                });
            });
          }
          return () => {
            events.push(`cleanup:${target.targetId}`);
            document.body.append(displayCanvas);
          };
        },
      },
    };
    const shell = new ViewWorkspaceShell({ document, presentation });
    const target = (targetId) => ({
      targetId,
      sessionId: `session:${targetId}`,
      worldId: `world:${targetId}`,
      headed: true,
      width: 640,
      height: 480,
    });
    const state = (selectedTarget) => ({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [{ tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target: selectedTarget }],
      project: null,
      preview: null,
      assets: [],
    });

    shell.update(state(target('target-a')));
    await new Promise((resolve) => setImmediate(resolve));
    shell.update(state(target('target-b')));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['create', 'attach:target-a']);
    assert.equal(displayCanvas.parentNode, shell.targetContainer);

    releaseFirstAttach();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['create', 'attach:target-a', 'cleanup:target-a', 'create', 'attach:target-b']);
    assert.equal(displayCanvas.parentNode, shell.targetContainer);

    await shell.dispose();
    assert.deepEqual(events, [
      'create',
      'attach:target-a',
      'cleanup:target-a',
      'create',
      'attach:target-b',
      'cleanup:target-b',
    ]);
    assert.equal(displayCanvas.parentNode, document.body);
  });

  it('drains a pending exact-surface attach before dispose restores its origin', async () => {
    const document = fakeDocument();
    const displayCanvas = document.createElement('canvas');
    document.body.append(displayCanvas);
    let releaseAttach;
    let cleaned = 0;
    const presentation = {
      display: {
        createSurface() {
          return displayCanvas;
        },
        attach() {
          return new Promise((resolve) => {
            releaseAttach = () =>
              resolve(() => {
                cleaned += 1;
                document.body.append(displayCanvas);
              });
          });
        },
      },
    };
    const shell = new ViewWorkspaceShell({ document, presentation });
    shell.update({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [
        {
          tabId: VIEW_DISPLAY_TAB_ID,
          kind: 'display',
          target: {
            targetId: 'pending-target',
            sessionId: 'session',
            worldId: 'world',
            headed: true,
            width: 640,
            height: 480,
          },
        },
      ],
      project: null,
      preview: null,
      assets: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const disposing = shell.dispose();
    await Promise.resolve();
    assert.equal(cleaned, 0);
    releaseAttach();
    await disposing;
    assert.equal(cleaned, 1);
    assert.equal(displayCanvas.parentNode, document.body);
  });

  it('releases an acquired exact surface when dispose wins before attach starts', async () => {
    const document = fakeDocument();
    const displayCanvas = document.createElement('canvas');
    document.body.append(displayCanvas);
    const events = [];
    const presentation = {
      display: {
        createSurface() {
          events.push('create');
          return displayCanvas;
        },
        attach() {
          events.push('attach');
        },
        detach({ element }) {
          events.push('detach');
          document.body.append(element);
        },
      },
    };
    const shell = new ViewWorkspaceShell({ document, presentation });
    shell.update({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [
        {
          tabId: VIEW_DISPLAY_TAB_ID,
          kind: 'display',
          target: {
            targetId: 'early-dispose-target',
            sessionId: 'session',
            worldId: 'world',
            headed: true,
            width: 640,
            height: 480,
          },
        },
      ],
      project: null,
      preview: null,
      assets: [],
    });
    await shell.dispose();
    assert.deepEqual(events, ['create', 'detach']);
    assert.equal(displayCanvas.parentNode, document.body);
  });

  it('serializes a fast stop and restart before reacquiring an exact surface', async () => {
    const document = fakeDocument();
    const displayCanvas = document.createElement('canvas');
    document.body.append(displayCanvas);
    const events = [];
    const presentation = {
      display: {
        createSurface() {
          events.push('create');
          return displayCanvas;
        },
        attach({ target }) {
          events.push(`attach:${target.targetId}`);
          return () => {
            events.push(`cleanup:${target.targetId}`);
            document.body.append(displayCanvas);
          };
        },
      },
    };
    const shell = new ViewWorkspaceShell({ document, presentation });
    const state = (target) => ({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [{ tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', target }],
      project: null,
      preview: null,
      assets: [],
    });
    const target = (targetId) => ({
      targetId,
      sessionId: `session:${targetId}`,
      worldId: `world:${targetId}`,
      headed: true,
      width: 640,
      height: 480,
    });

    shell.update(state(target('target-a')));
    await new Promise((resolve) => setImmediate(resolve));
    shell.update(state(null));
    shell.update(state(target('target-b')));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, [
      'create',
      'attach:target-a',
      'cleanup:target-a',
      'create',
      'attach:target-b',
    ]);
    assert.equal(displayCanvas.parentNode, shell.targetContainer);
    await shell.dispose();
    assert.deepEqual(events, [
      'create',
      'attach:target-a',
      'cleanup:target-a',
      'create',
      'attach:target-b',
      'cleanup:target-b',
    ]);
    assert.equal(displayCanvas.parentNode, document.body);
  });

  it('detaches local input when the selected tab changes', async () => {
    for (const binding of ['editorPreview', 'preview']) {
    const document = fakeDocument();
    const aborts = [];
    let detached = 0;
    const controller = {
      attach() {
        return () => {
          detached += 1;
        };
      },
      async abort(reason) {
        aborts.push(reason);
      },
    };
    const shell = new ViewWorkspaceShell({
      document,
      window: { addEventListener() {}, removeEventListener() {} },
      inputControllerFactory: () => controller,
    });
    shell.api = {};
    const target = {
      targetId: 'workspace-target',
      sessionId: 'session',
      worldId: 'world',
      headed: true,
      width: 640,
      height: 480,
    };
    shell.update({
      selectedTabId: VIEW_WORKSPACE_TAB_ID,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', targetId: 'cli-target' },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target },
      ],
      [binding]: { ...(binding === 'editorPreview' ? { asset: { guid: 'scene', kind: 'scene' } } : {}), target },
    });
    shell.update({
      selectedTabId: VIEW_DISPLAY_TAB_ID,
      tabs: [
        { tabId: VIEW_DISPLAY_TAB_ID, kind: 'display', targetId: 'cli-target' },
        { tabId: VIEW_WORKSPACE_TAB_ID, kind: 'workspace', target },
      ],
      [binding]: { ...(binding === 'editorPreview' ? { asset: { guid: 'scene', kind: 'scene' } } : {}), target },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(aborts, ['tab-selection']);
    assert.equal(detached, 1);
    await shell.dispose();
    }
  });
});
