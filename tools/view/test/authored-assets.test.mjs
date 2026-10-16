import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { WorkspaceFixture as ViewWorkspaceBroker, assetOperationsFixture } from './support/workspace-owner.mjs';
import { createWorkspaceRequest, VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';
import { createEngineWorkspaceAdapter } from '@forgeax/view-workspace-core/engine-adapter';
import { ViewWorkspaceShell } from '@forgeax/view-plugin-viewport/workspace-shell';

const cleanup = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

const PACK_META = {
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  packageId: '11111111-1111-4111-8111-111111111111',
  importer: 'pack-ts',
  source: 'assets/scene.pack.ts',
  importSettings: { contractVersion: '1.0.0', externalAssets: [] },
  subAssets: [
    { guid: 'scene-guid', sourceIndex: 0, sourceKey: 'scene', kind: 'scene', name: 'Main scene' },
    { guid: 'mesh-guid', sourceIndex: 1, sourceKey: 'mesh', kind: 'mesh', name: 'Mesh' },
  ],
};

function packEntry(guid, extras = {}) {
  return {
    guid,
    kind: guid === 'mesh-guid' ? 'mesh' : 'scene',
    name: guid === 'mesh-guid' ? 'Mesh' : 'Main scene',
    sourcePath: 'assets/scene.pack.ts',
    ...extras,
  };
}

function authoredEngine() {
  const calls = [];
  let revision = 'a'.repeat(64);
  const engine = {
    async openProject({ root }) {
      return { project: { id: `project:${root}`, root, name: 'Fixture' }, handle: { root } };
    },
    async closeProject() {},
    async listAssets({ project }) {
      calls.push(['asset.list', project.id]);
      return [
        packEntry('scene-guid', { previewable: true, cookReceiptUrl: '/receipts/scene.json', sourceKey: 'scene/main' }),
        packEntry('mesh-guid', { previewable: true }),
      ];
    },
    async openPreview() {
      throw new Error('preview is not required for Engine inspect/rebuild');
    },
    async assetInspect({ subject }) {
      calls.push(['asset.inspect', subject]);
      return packEntry(subject, { cookReceiptUrl: '/receipts/scene.json' });
    },
    pack: {
      async inspect(sourcePath) {
        calls.push(['inspect-meta', sourcePath]);
        return { revision, meta: PACK_META };
      },
      async preflight(sourcePath) {
        calls.push(['preflight', sourcePath]);
        return { revision };
      },
      async rebuild(sourcePath, mode) {
        calls.push(['rebuild', sourcePath, mode]);
        revision = 'b'.repeat(64);
        return { revision, meta: PACK_META };
      },
    },
  };
  return { calls, engine: assetOperationsFixture(engine), getRevision: () => revision };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
  }

  get textContent() { return (this._text ?? '') + this.children.map(child => child.textContent ?? '').join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }

  append(...nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      this.children.push(node);
      node.parentNode = this;
    }
  }

  appendChild(node) {
    this.append(node);
  }

  replaceChildren(...nodes) {
    this._text = '';
    for (const child of [...this.children]) {
      child.parentNode = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  addEventListener() {}

  remove() {
    this.parentNode = null;
  }
}

function fakeDocument() {
  const body = new FakeElement('body');
  return {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: () => null,
    body,
  };
}

describe('View Engine asset-source projection', () => {
  it('inspects PackEntry plus ScriptablePack meta and forwards rebuild to Engine', async () => {
    const fixture = authoredEngine();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    cleanup.push(() => broker.dispose());
    const options = { clientId: 'cli', token: broker.accessToken };
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    const inspected = await broker.call(
      createWorkspaceRequest(
        'asset.inspect',
        { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
        options,
      ),
    );
    assert.equal(inspected.inspection.source.path, 'assets/scene.pack.ts');
    assert.equal(inspected.inspection.source.kind, 'pack.ts');
    assert.equal(inspected.inspection.meta.importer, 'pack-ts');
    assert.equal(inspected.inspection.meta.subAssets[0].guid, 'scene-guid');
    assert.equal(inspected.inspection.ddc.receiptUrl, '/receipts/scene.json');
    assert.equal(
      fixture.calls.some((call) => call[0] === 'rebuild'),
      false,
    );

    const rebuilt = await broker.call(
      createWorkspaceRequest(
        'asset.source.rebuild',
        {
          projectId: 'project:/fixture',
          tabId: VIEW_WORKSPACE_TAB_ID,
          guid: 'scene-guid',
          expectedRevision: 'a'.repeat(64),
          requestId: 'request-rebuild',
        },
        options,
      ),
    );
    assert.equal(rebuilt.mode, 'rebuild');
    assert.equal(rebuilt.sourcePath, 'assets/scene.pack.ts');
    assert.equal(rebuilt.revision, 'b'.repeat(64));
    assert.equal(rebuilt.inspection.revision, 'b'.repeat(64));
    assert.deepEqual(
      fixture.calls.filter((call) => call[0] === 'rebuild'),
      [['rebuild', 'assets/scene.pack.ts', 'rebuild']],
    );
  });

  it('rejects stale Engine expectedRevision and unknown workspace operations', async () => {
    const fixture = authoredEngine();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    cleanup.push(() => broker.dispose());
    const options = { clientId: 'cli', token: broker.accessToken };
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    await broker.call(
      createWorkspaceRequest(
        'asset.inspect',
        { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
        options,
      ),
    );
    await assert.rejects(
      () =>
        broker.call(
          createWorkspaceRequest(
            'asset.source.rebuild',
            {
              projectId: 'project:/fixture',
              tabId: VIEW_WORKSPACE_TAB_ID,
              guid: 'scene-guid',
              expectedRevision: '0'.repeat(64),
              requestId: 'request-stale',
            },
            options,
          ),
        ),
      (error) => {
        assert.equal(error.code, 'pack-source-revision-conflict');
        return true;
      },
    );
    await assert.throws(
      () =>
        createWorkspaceRequest(
          'assets.cook',
          { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
          options,
        ),
      (error) => {
        assert.equal(error.code, 'view-workspace-operation-unknown');
        return true;
      },
    );
    assert.equal(
      fixture.calls.some((call) => call[0] === 'rebuild'),
      false,
    );
  });

  it('projects Engine catalog cookReceiptUrl after list', async () => {
    const fixture = authoredEngine();
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    cleanup.push(() => broker.dispose());
    const options = { clientId: 'cli', token: broker.accessToken };
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    const listed = await broker.call(
      createWorkspaceRequest(
        'assets.list',
        { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
        options,
      ),
    );
    assert.equal(listed.assets[0].cookReceiptUrl, '/receipts/scene.json');
    assert.equal(listed.assets[0].ddc.receiptUrl, '/receipts/scene.json');
    assert.equal(listed.assets[0].sourceKey, 'scene/main');
    assert.equal(broker.snapshot().assets[0].sourceKey, 'scene/main');
  });

  it('fails closed when Engine has no asset.source.rebuild capability', async () => {
    const fixture = authoredEngine();
    delete fixture.engine.rebuildAssetSource;
    delete fixture.engine.pack.rebuild;
    delete fixture.engine.pack.preflight;
    delete fixture.engine.pack.inspect;
    const broker = new ViewWorkspaceBroker({ engine: fixture.engine, accessToken: 'workspace-test-token' });
    cleanup.push(() => broker.dispose());
    const options = { clientId: 'cli', token: broker.accessToken };
    await broker.call(
      createWorkspaceRequest('project.open', { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID }, options),
    );
    await broker.call(
      createWorkspaceRequest(
        'asset.inspect',
        { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
        options,
      ),
    );
    await assert.rejects(
      () =>
        broker.call(
          createWorkspaceRequest(
            'asset.source.rebuild',
            { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
            options,
          ),
        ),
      (error) => {
        assert.equal(error.code, 'view-workspace-operation-unavailable');
        assert.equal(error.detail.operation, 'asset.source.rebuild');
        return true;
      },
    );
  });

  it('projects a left source-grouped tree and right read-only Engine pack meta', async () => {
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.update({
      selectedTabId: VIEW_WORKSPACE_TAB_ID,
      project: { id: 'project:/fixture', root: '/fixture', name: 'Fixture' },
      assets: [
        {
          guid: 'scene-guid',
          kind: 'scene',
          name: 'Main scene',
          sourcePath: 'assets/scene.pack.ts',
          cookReceiptUrl: '/receipts/scene.json',
          ddc: { receiptUrl: '/receipts/scene.json', state: 'current' },
        },
        { guid: 'mesh-guid', kind: 'mesh', name: 'Mesh', sourcePath: 'assets/scene.pack.ts' },
      ],
      inspection: {
        guid: 'scene-guid',
        asset: {
          guid: 'scene-guid',
          kind: 'scene',
          name: 'Main scene',
          sourcePath: 'assets/scene.pack.ts',
        },
        source: { path: 'assets/scene.pack.ts', kind: 'pack.ts', revision: 'a'.repeat(64) },
        meta: PACK_META,
        ddc: { receiptUrl: '/receipts/scene.json', state: 'current' },
        revision: 'a'.repeat(64),
      },
    });
    assert.equal(shell.workbenchElement.dataset.forgeaxViewWorkspace, 'workbench');
    assert.equal(shell.assetsElement.children.length, 1);
    assert.equal(shell.assetsElement.children[0].dataset.sourcePath, 'assets/scene.pack.ts');
    assert.equal(shell.assetsElement.children[0].children[1].children.length, 2);
    assert.equal(shell.inspectorElement.dataset.forgeaxViewWorkspace, 'inspector');
    assert.equal(shell.inspectorFieldsElement.children[0].dataset.forgeaxViewWorkspace, 'pack-meta');
    assert.equal(shell.inspectorFieldsElement.children[1].dataset.guid, 'scene-guid');
    assert.match(shell.inspectorInfoElement.children[0].textContent ?? '', /\/receipts\/scene\.json/);
    assert.equal(shell.assetsElement.children[0].children[1].children[0].dataset.ddcState, 'current');
    assert.equal(shell.inspectorActionsElement.children[0].textContent, 'Rebuild');
    assert.equal(shell.inspectorActionsElement.children[1].textContent, 'Cold-cook');
  });

  it('selects an asset through inspect then preview, and skips a second preview of the same GUID', async () => {
    const calls = [];
    const inspection = {
      guid: 'scene-guid',
      asset: { guid: 'scene-guid', kind: 'scene', name: 'Main scene', previewable: true },
      source: { path: 'assets/scene.pack.ts', kind: 'pack.ts', revision: '1' },
      meta: PACK_META,
      revision: '1',
    };
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.api = {
      async inspectAsset(guid) {
        calls.push(['inspect', guid]);
        return { inspection };
      },
      async openAsset(guid) {
        calls.push(['open', guid]);
      },
    };
    shell.state.project = { id: 'project:/fixture', root: '/fixture' };
    shell.state.assets = [inspection.asset];
    await shell.selectAsset('scene-guid');
    shell.state.preview = { asset: inspection.asset };
    await shell.selectAsset('scene-guid');
    assert.deepEqual(calls, [
      ['inspect', 'scene-guid'],
      ['open', 'scene-guid'],
      ['inspect', 'scene-guid'],
    ]);
  });

  it('shows reconnect progress and prevents a duplicate reconnect request', async () => {
    let resolveReopen;
    let reopens = 0;
    const calls = [];
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.update({
      revision: 1,
      project: { id: 'project:/fixture', root: '/fixture' },
      workspaceTargetLost: true,
      tabs: [],
    });
    shell.api = {
      async reopenProject() {
        reopens += 1;
        await new Promise((resolve) => { resolveReopen = resolve; });
        calls.push('reopen');
        return {
          project: { id: 'project:/fixture', root: '/fixture' },
          projectTarget: { url: 'http://localhost/new' },
        };
      },
      async listAssets() {
        calls.push(`list:${shell.state.project?.id}`);
        return { assets: [] };
      },
      async getState() {
        return shell.snapshot();
      },
    };
    const reconnecting = shell.reconnectProject();
    assert.equal(shell.state.projectReconnecting, true);
    await shell.reconnectProject();
    assert.equal(reopens, 1);
    resolveReopen();
    await reconnecting;
    assert.equal(shell.state.projectReconnecting, false);
    assert.deepEqual(calls, ['reopen', 'list:project:/fixture']);
  });

  it('rejects an empty project root for owner-driven openProject', async () => {
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.api = {
      async openProject() {
        throw new Error('engine should not be called');
      },
    };
    await shell.openProject('   ');
    assert.match(shell.state.error, /Project root is required/);
    assert.match(shell.errorElement.textContent ?? '', /Project root is required/);
    shell.update({ revision: 2, project: null, tabs: [] });
    assert.match(shell.state.error, /Project root is required/);
    assert.match(shell.projectElement.textContent ?? '', /View owner process/);
  });

  it('projects a structured provider hint without exposing the raw error object', async () => {
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.api = {
      async openProject() {
        throw Object.assign(new Error('project.open failed'), {
          hint: 'provider: tool-domain-failed -> engine-workspace-result-timeout',
        });
      },
    };
    await shell.openProject('/fixture');
    assert.equal(
      shell.state.error,
      'project.open failed (provider: tool-domain-failed -> engine-workspace-result-timeout)',
    );
  });

  it('keeps reconnect in flight while the workspace target is being reopened', async () => {
    let resolveReopen;
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.update({
      revision: 2,
      project: { id: 'project:/fixture', root: '/fixture' },
      workspaceTargetLost: true,
      tabs: [],
    });
    shell.api = {
      reopenProject: () => new Promise((resolve) => {
        resolveReopen = resolve;
      }),
      async listAssets() { return { assets: [] }; },
      async getState() { return shell.snapshot(); },
    };
    const reconnecting = shell.reconnectProject();
    shell.update({ revision: 3, workspaceTargetLost: true, selectedTabId: VIEW_WORKSPACE_TAB_ID });
    assert.equal(shell.state.projectReconnecting, true);
    assert.match(shell.projectElement.textContent ?? '', /Reconnecting project/);
    resolveReopen({
      project: { id: 'project:/fixture', root: '/fixture' },
      projectTarget: { url: 'http://localhost/new' },
    });
    await reconnecting;
  });

  it('forwards rebuild and cold-cook to Engine asset-source tools', async () => {
    const calls = [];
    const shell = new ViewWorkspaceShell({ document: fakeDocument() });
    cleanup.push(() => shell.dispose());
    shell.api = {
      async rebuildAssetSource(guid, args) {
        calls.push(['rebuild', guid, args.expectedRevision]);
      },
      async coldCookAssetSource(guid, args) {
        calls.push(['cold-cook', guid, args.expectedRevision]);
      },
    };
    shell.state.project = { id: 'project:/fixture', root: '/fixture' };
    shell.state.inspection = {
      guid: 'scene-guid',
      asset: { guid: 'scene-guid', kind: 'scene' },
      meta: PACK_META,
      revision: 'a'.repeat(64),
    };
    await shell.cookSelected('rebuild');
    await shell.cookSelected('cold-cook');
    assert.deepEqual(calls, [
      ['rebuild', 'scene-guid', 'a'.repeat(64)],
      ['cold-cook', 'scene-guid', 'a'.repeat(64)],
    ]);
  });

  it('unwraps Engine CommandResult catalog/inspect and gateway rebuild', async () => {
    const calls = [];
    const adapter = createEngineWorkspaceAdapter({
      async openProject() {
        return { project: { id: 'p', root: '/p' } };
      },
      async closeProject() {},
      async assetList() {
        return { ok: true, value: [packEntry('scene-guid')] };
      },
      async assetInspect({ subject }) {
        return { ok: true, value: packEntry(subject) };
      },
      async openPreview() {
        return { target: { targetId: 't', headed: true } };
      },
      gateway: {
        async execute(operation) {
          calls.push(operation.kind);
          return {
            ok: true,
            value: {
              sourcePath: operation.sourcePath,
              revision: operation.kind === 'inspect-meta' ? '1' : '2',
              meta: PACK_META,
            },
          };
        },
      },
    });
    const listed = await adapter.listAssets({ project: { id: 'p', root: '/p' } });
    assert.equal(listed[0].guid, 'scene-guid');
    const inspected = await adapter.inspectAsset({
      project: { id: 'p', root: '/p' },
      asset: packEntry('scene-guid'),
      subject: 'scene-guid',
    });
    assert.equal(inspected.meta.importer, 'pack-ts');
    const rebuilt = await adapter.rebuild({
      asset: packEntry('scene-guid'),
      sourcePath: 'assets/scene.pack.ts',
      mode: 'rebuild',
      requestId: 'request-rebuild',
      expectedRevision: '1',
    });
    assert.equal(rebuilt.revision, '2');
    assert.deepEqual(calls, ['inspect-meta', 'rebuild']);
  });

  it('forwards asset.source.rebuild through Engine ToolClient.run', async () => {
    const calls = [];
    const adapter = createEngineWorkspaceAdapter({
      async openProject() {
        return { project: { id: 'p', root: '/p' } };
      },
      async closeProject() {},
      async listAssets() {
        return [packEntry('scene-guid')];
      },
      async openPreview() {
        return { target: { targetId: 't', headed: true } };
      },
      tools: {
        async run(id, args) {
          calls.push([id, args.sourcePath, args.requestId]);
          return { outcome: 'succeeded', result: { revision: '2', meta: PACK_META } };
        },
      },
    });
    const rebuilt = await adapter.rebuild({
      asset: packEntry('scene-guid'),
      sourcePath: 'assets/scene.pack.ts',
      mode: 'cold-cook',
      requestId: 'request-cold',
    });
    assert.equal(rebuilt.revision, '2');
    assert.deepEqual(calls, [['asset.source.cold-cook', 'assets/scene.pack.ts', 'request-cold']]);
  });
});
