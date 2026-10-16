import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createToolRuntime } from '@forgeax/engine-tool-runtime';

import { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import { createWorkspaceToolContributions, defineWorkspaceOperations } from '@forgeax/view-workspace-core/tool-runtime';
import { workspaceCoreCliContributions } from '@forgeax/view-workspace-core/cli';
import {
  VIEW_WORKSPACE_OPERATIONS,
  createWorkspaceRequest,
  workspaceUiFingerprint,
} from '@forgeax/view-workspace-core/contract';

describe('workspace asset inspection contract', () => {
  it('keeps a Pack reveal receipt serializable through the ToolApi boundary', async () => {
    const receipt = { ok: true, code: 'shown', requestId: 'reveal-1' };
    const [contribution] = createWorkspaceToolContributions(
      { call: async () => receipt },
      defineWorkspaceOperations([{ id: 'view.workspace.pack.reveal', operation: 'pack.reveal' }]),
    );
    const terminal = await createToolRuntime([contribution]).run(contribution, {
      operation: 'pack.reveal', clientId: 'cli', args: {},
    }).terminal;
    assert.equal(terminal.outcome, 'succeeded');
    assert.deepEqual(terminal.result, receipt);
  });
  it('admits flat operation arguments only from the authenticated Engine backend CLI', async () => {
    const workspace = new ViewWorkspaceBroker({ accessToken: 'owner-secret' });
    const [tool] = createWorkspaceToolContributions(workspace,
      defineWorkspaceOperations([{ id: 'view.workspace.summary.get', operation: 'summary.get' }]));
    const runtime = createToolRuntime([tool]);
    const good = await runtime.run(tool, {}, { caller: { kind: 'cli', sourceId: 'devkit-backend-client', connectionId: 'backend-cli' } }).terminal;
    assert.equal(good.outcome, 'succeeded');
    assert.equal(good.result.project, null);
    for (const caller of [undefined, { kind: 'frontend', sourceId: 'devkit-backend-client', connectionId: 'frontend' },
      { kind: 'cli', sourceId: 'other-client', connectionId: 'other-cli' }]) {
      const denied = await runtime.run(tool, {}, { caller }).terminal;
      assert.equal(denied.outcome, 'failed');
      assert.ok(denied.failure.detail.code.startsWith('view-workspace-'));
    }
    const envelope = await runtime.run(tool, createWorkspaceRequest('summary.get', {}, {
      clientId: 'ordinary-client', token: workspace.accessToken,
    })).terminal;
    assert.equal(envelope.outcome, 'succeeded');
  });
  it('exposes page inventory and Pack reveal through the same public API and CLI operation names', () => {
    for (const operation of ['pages.list', 'pack.reveal']) {
      assert.equal(VIEW_WORKSPACE_OPERATIONS.includes(operation), true);
      assert.equal(workspaceCoreCliContributions.some(item => item.operation === operation), true);
    }
  });
  it('sends page inventory and Pack reveal through the public workspace client', async () => {
    const sent = [];
    const client = new ViewWorkspaceClient({ clientId: 'cli', transport: {
      async request(_service, request) { sent.push(request); return {}; },
    } });
    await client.listPages();
    await client.revealPack({ projectId: 'game', sourcePath: 'assets/scene.pack.json', revision: 'sha256:abc' });
    assert.deepEqual(sent.map(request => request.operation), ['pages.list', 'pack.reveal']);
  });
  it('preserves the explicit project target for independent asset operations', async () => {
    const sent = [];
    const controller = new AbortController();
    const client = new ViewWorkspaceClient({ clientId: 'asset-cli', transport: {
      async request(_service, request, options) {
        sent.push({ request, options });
        return {};
      },
    } });
    const options = { projectId: 'second-game', targetId: 'second-page-target',
      targetGeneration: 7, signal: controller.signal };
    await client.inspectAsset('mesh', options);
    await client.openAsset('mesh', options);
    await client.rebuildAssetSource('mesh', { ...options, expectedRevision: 'r1', requestId: 'rebuild' });
    await client.coldCookAssetSource('mesh', { ...options, expectedRevision: 'r1', requestId: 'cold' });
    assert.deepEqual(sent.map(({ request }) => request.operation),
      ['asset.inspect', 'asset.open', 'asset.source.rebuild', 'asset.source.cold-cook']);
    for (const { request, options: transportOptions } of sent) {
      assert.equal(request.args.projectId, options.projectId);
      assert.equal(request.args.targetId, options.targetId);
      assert.equal(request.args.targetGeneration, options.targetGeneration);
      assert.equal(transportOptions.signal, controller.signal);
    }
  });

  it('routes independent catalog reads to the requested Engine target', async () => {
    let sent;
    const controller = new AbortController();
    const client = new ViewWorkspaceClient({ clientId: 'catalog-cli', transport: {
      async request(service, request, options) {
        sent = { service, request, options };
        return { assets: [{ guid: 'target-owned-asset' }] };
      },
    } });
    const result = await client.listAssets('game', {
      targetId: 'second-page-target', targetGeneration: 7, signal: controller.signal,
    });
    assert.equal(sent.request.operation, 'assets.list');
    assert.equal(sent.request.args.projectId, 'game');
    assert.equal(sent.request.args.targetId, 'second-page-target');
    assert.equal(sent.request.args.targetGeneration, 7);
    assert.equal(sent.options.signal.aborted, false);
    assert.deepEqual(result.assets, [{ guid: 'target-owned-asset' }]);
  });

  it('inspects authored assets through asset.inspect only', () => {
    assert.equal(VIEW_WORKSPACE_OPERATIONS.includes('asset.inspect'), true);
    assert.equal(VIEW_WORKSPACE_OPERATIONS.includes('material.inspect'), false);
    assert.equal(typeof ViewWorkspaceClient.prototype.inspectAsset, 'function');
    assert.equal('inspectMaterial' in ViewWorkspaceClient.prototype, false);
    assert.throws(
      () => createWorkspaceRequest('material.inspect', { guid: 'mat-guid' }, { clientId: 'cli' }),
      (error) => {
        assert.equal(error.code, 'view-workspace-operation-unknown');
        return true;
      },
    );
  });
});

it('summary.get projects bounded identities without catalog or UI selections', async () => {
  const previews = Array.from({ length: 20 }, (_, index) => ({ target: { targetId: `preview-${index}`, generation: index } }));
  const broker = new ViewWorkspaceBroker({ engine: {
    project: { project: { id: 'project', root: '/project', name: 'Game', secret: 'not-summary' },
      target: { targetId: 'project-target', generation: 4 }, phase: 'running', browserGeneration: 7 },
    previews,
  }, accessToken: 'token' });
  broker.assets = [{ guid: 'private-catalog-item' }];
  broker.selectedTabId = 'forgeax-cli-display';
  const result = await broker.call(createWorkspaceRequest('summary.get', {}, { clientId: 'test', token: 'token' }));
  assert.deepEqual(result.project, { id: 'project', root: '/project', name: 'Game' });
  assert.equal(result.projectPhase, 'running');
  assert.equal(result.browserGeneration, 7);
  assert.equal(result.targets.length, 16);
  assert.equal(result.targets[0].role, 'project');
  assert.equal(result.hasMoreTargets, true);
  assert.equal('assets' in result, false);
  assert.equal('selectedTabId' in result, false);
  await broker.dispose();
});

it('summary.get derives the project generation from its exact live root preview', async () => {
  const engine = {
    project: { project: { id: 'project', root: '/project' },
      target: { targetId: 'project-target' }, phase: 'running', browserGeneration: 99 },
    previews: [],
    preview: { target: { targetId: 'project-target', generation: 7 } },
  };
  const broker = new ViewWorkspaceBroker({ engine });
  assert.deepEqual(broker.summary().targets, [
    { targetId: 'project-target', generation: 7, role: 'project' },
  ]);
  engine.preview = { target: { targetId: 'other-target', generation: 8 } };
  assert.deepEqual(broker.summary().targets, [
    { targetId: 'project-target', role: 'project' },
  ]);
  await broker.dispose();
});

it('type declarations preserve constructor-owned instance fields', () => {
  const client = new ViewWorkspaceClient({ transport: { request: async () => undefined }, clientId: 'instance-fields' });
  assert.equal('projectSession' in client, false);
  assert.deepEqual(Object.keys(client), ['transport', 'clientId', 'token']);
  const broker = new ViewWorkspaceBroker();
  assert.equal('previewTargetId' in broker, false);
  assert.equal('selectionAbort' in broker, false);
  assert.equal(Object.hasOwn(broker, 'editorTargetId'), true);
});

describe('workspace UI fingerprints', () => {
  it('ignores revision, submitted frame id, and camera pose', () => {
    const base = {
      selectedTabId: 'workspace',
      project: { id: 'p', root: '/p' },
      preview: {
        target: { targetId: 't', headed: true, width: 1280, height: 720 },
        camera: { position: [0, 1, 2], control: 'player' },
      },
    };
    assert.equal(
      workspaceUiFingerprint({ ...base, revision: 1 }),
      workspaceUiFingerprint({
        ...base,
        revision: 99,
        preview: {
          target: { ...base.preview.target, frameId: 16637 },
          camera: { position: [9, 9, 9], control: 'player' },
          cameraVersion: 12,
        },
      }),
    );
    assert.notEqual(
      workspaceUiFingerprint(base),
      workspaceUiFingerprint({
        ...base,
        preview: { ...base.preview, camera: { control: 'observer' } },
      }),
    );
    assert.equal(
      workspaceUiFingerprint({
        ...base,
        tabs: [{ tabId: 'workspace', target: { targetId: 't', frameId: 1 } }],
        play: { phase: 'running', inputVersion: 'v1', target: { targetId: 'play', frameId: 8 } },
      }),
      workspaceUiFingerprint({
        ...base,
        tabs: [{ tabId: 'workspace', target: { targetId: 't', frameId: 99 } }],
        play: { phase: 'running', inputVersion: 'v9', target: { targetId: 'play', frameId: 80 } },
      }),
    );
  });
});
