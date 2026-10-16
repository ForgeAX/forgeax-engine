import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ViewWorkspaceBroker } from '../packages/view-workspace-core/src/broker.ts';
import {
  createWorkspaceRequest,
  serializeWorkspaceOpenRequest,
  VIEW_WORKSPACE_TAB_ID,
} from '../packages/view-workspace-core/src/contract.ts';
import {
  observeWorkspaceOpenRequests,
  selectWorkspaceResourcePreview,
  selectWorkspaceResourceSubject,
} from '../packages/view-workspace-core/src/resource-open.ts';

function previewFor(asset) {
  const targetId = `target:${asset.guid}`;
  return {
    asset,
    target: {
      targetId,
      sessionId: `session:${targetId}`,
      worldId: `world:${targetId}`,
      generation: 1,
      headed: true,
      width: 1280,
      height: 720,
    },
  };
}

function engineWithAssets(assets, { omitPreviewKind = false } = {}) {
  const previews = [];
  return {
    project: null,
    get preview() { return previews[0]; },
    get previews() { return previews; },
    async openProject({ root }) {
      this.project = {
        project: { id: `project:${root}`, root, name: 'Fixture' },
        handle: { root },
      };
      return this.project;
    },
    async listAssets() { return assets; },
    async openPreview({ asset }) {
      const preview = previewFor(omitPreviewKind ? { guid: asset.guid, name: asset.name } : asset);
      previews.unshift(preview);
      return preview;
    },
  };
}

function toolApi(engine) {
  const owner = { providerId: 'fixture-engine', generation: 1, sourceId: 'engine-workspace' };
  return {
    list: () => [],
    describe(id) {
      if (typeof id === 'string' && id.startsWith('engine.')) {
        return [{ callable: true, owner }];
      }
      return [];
    },
    run(id, args) {
      const operation = id.slice('engine.'.length);
      const terminal = (async () => {
        if (operation === 'project.open') {
          await engine.openProject({ root: args.root });
          return { outcome: 'succeeded', result: { project: engine.project.project } };
        }
        if (operation === 'assets.list') {
          const list = await engine.listAssets();
          return { outcome: 'succeeded', result: { assets: list } };
        }
        if (operation === 'asset.open') {
          const list = await engine.listAssets();
          const asset = list.find((entry) => entry.guid === args.guid);
          if (!asset) {
            return {
              outcome: 'failed',
              failure: {
                code: 'view-workspace-asset-not-found',
                expected: 'an asset in the Engine catalog',
                hint: 'Refresh assets.list.',
                detail: { guid: args.guid },
              },
            };
          }
          await engine.openPreview({ asset, project: engine.project.project });
          return { outcome: 'succeeded', result: { preview: engine.preview } };
        }
        return { outcome: 'succeeded', result: {} };
      })();
      return { terminal };
    },
  };
}

describe('workspace openRequest', () => {
  it('serializes a stable domain request without page presentation fields', () => {
    const request = serializeWorkspaceOpenRequest({
      requestId: 'req-open',
      sequence: 3,
      asset: { guid: 'mesh-guid', kind: 'mesh', name: 'Hero' },
      pageType: 'mesh',
      suggestedPageType: 'mesh',
    });
    assert.equal(request.requestId, 'req-open');
    assert.equal(request.sequence, 3);
    assert.equal(request.asset.guid, 'mesh-guid');
    assert.equal('pageType' in request, false);
    assert.equal('suggestedPageType' in request, false);
  });

  it('emits a distinct observable request for each successful asset.open, including repeats', async () => {
    const engine = engineWithAssets([
      { guid: 'scene-guid', kind: 'scene', name: 'Main scene' },
    ]);
    const broker = new ViewWorkspaceBroker({
      engine,
      toolApi: toolApi(engine),
      accessToken: 'open-request-token',
    });
    const seen = [];
    const stop = observeWorkspaceOpenRequests(
      {
        subscribe: (listener) => broker.subscribe(listener),
        getState: () => Promise.resolve(broker.snapshot()),
      },
      (request) => seen.push(request),
    );
    await broker.call(createWorkspaceRequest(
      'project.open',
      { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-project' },
    ));
    const first = await broker.call(createWorkspaceRequest(
      'asset.open',
      { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-open-1' },
    ));
    const second = await broker.call(createWorkspaceRequest(
      'asset.open',
      { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'scene-guid' },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-open-2' },
    ));
    assert.equal(first.openRequest.requestId, 'req-open-1');
    assert.equal(second.openRequest.requestId, 'req-open-2');
    assert.equal(second.openRequest.sequence, first.openRequest.sequence + 1);
    assert.equal(second.openRequest.asset.guid, 'scene-guid');
    assert.equal('preview' in first.openRequest, false);
    assert.equal('pageType' in first.openRequest, false);
    assert.equal('suggestedPageType' in second.openRequest, false);
    await Promise.resolve();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((request) => request.requestId), ['req-open-1', 'req-open-2']);
    stop();
    await broker.dispose();
  });

  it('does not record openRequest when asset.open fails', async () => {
    const engine = engineWithAssets([
      { guid: 'scene-guid', kind: 'scene', name: 'Main scene' },
    ]);
    const broker = new ViewWorkspaceBroker({
      engine,
      toolApi: toolApi(engine),
      accessToken: 'open-request-token',
    });
    await broker.call(createWorkspaceRequest(
      'project.open',
      { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-project' },
    ));
    await assert.rejects(
      broker.call(createWorkspaceRequest(
        'asset.open',
        { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'missing-guid' },
        { clientId: 'cli', token: broker.accessToken, requestId: 'req-fail' },
      )),
    );
    assert.equal(broker.snapshot().openRequest, null);
    await broker.dispose();
  });

  it('records openRequest kind from the catalog when Engine preview omits kind', async () => {
    const engine = engineWithAssets([
      { guid: 'mat-guid', kind: 'material', name: 'Sky' },
    ], { omitPreviewKind: true });
    const broker = new ViewWorkspaceBroker({
      engine,
      toolApi: toolApi(engine),
      accessToken: 'open-request-token',
    });
    await broker.call(createWorkspaceRequest(
      'project.open',
      { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-project' },
    ));
    await broker.call(createWorkspaceRequest(
      'assets.list',
      { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-list' },
    ));
    const opened = await broker.call(createWorkspaceRequest(
      'asset.open',
      { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'mat-guid' },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-open-mat' },
    ));
    assert.equal(opened.openRequest.asset.guid, 'mat-guid');
    assert.equal(opened.openRequest.asset.kind, 'material');
    await broker.dispose();
  });

  it('keeps earlier type-preview identity after opening a different kind', async () => {
    const assets = [
      { guid: 'scene-guid', kind: 'scene', name: 'Main scene' },
      { guid: 'mat-guid', kind: 'material', name: 'Sky' },
      { guid: 'mesh-guid', kind: 'mesh', name: 'Hero' },
    ];
    const previews = [previewFor(assets[0])];
    const engine = {
      project: null,
      get preview() { return previews.at(-1); },
      get previews() { return previews; },
      async openProject({ root }) {
        this.project = {
          project: { id: `project:${root}`, root, name: 'Fixture' },
          handle: { root },
        };
        return this.project;
      },
      async listAssets() { return assets; },
      async openPreview({ asset }) {
        const preview = previewFor(asset);
        previews.push(preview);
        return preview;
      },
    };
    const broker = new ViewWorkspaceBroker({
      engine,
      toolApi: toolApi(engine),
      accessToken: 'open-request-token',
    });
    await broker.call(createWorkspaceRequest(
      'project.open',
      { root: '/fixture', tabId: VIEW_WORKSPACE_TAB_ID },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-project' },
    ));
    await broker.call(createWorkspaceRequest(
      'asset.open',
      { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'mat-guid' },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-open-mat' },
    ));
    const openedMesh = await broker.call(createWorkspaceRequest(
      'asset.open',
      { projectId: 'project:/fixture', tabId: VIEW_WORKSPACE_TAB_ID, guid: 'mesh-guid' },
      { clientId: 'cli', token: broker.accessToken, requestId: 'req-open-mesh' },
    ));
    const snapshot = broker.snapshot();
    assert.equal(openedMesh.openRequest.asset.guid, 'mesh-guid');
    assert.equal(selectWorkspaceResourceSubject(snapshot, ['material']).guid, 'mat-guid');
    assert.equal(selectWorkspaceResourcePreview(snapshot, 'mat-guid').target.targetId, 'target:mat-guid');
    assert.equal(selectWorkspaceResourceSubject(snapshot, ['mesh']).guid, 'mesh-guid');
    assert.equal(snapshot.preview.target.targetId, 'target:scene-guid');
    assert.equal(snapshot.resourceOpens.material.asset.guid, 'mat-guid');
    await broker.dispose();
  });
});
