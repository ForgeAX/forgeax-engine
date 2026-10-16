import { transactionPreview, assetOperationsFixture } from './support/workspace-owner.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createBrowserPagePlatform, startView, VIEW_WORKSPACE_TAB_ID } from '../src/index.ts';

const exec = promisify(execFile);
const cleanup = [];
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const worktreeRoot = fileURLToPath(new URL('..', import.meta.url));

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function workspaceEngine() {
  return assetOperationsFixture({
    async openProject({ root }) {
      return { project: { id: `project:${root}`, root, name: 'CLI fixture' }, handle: { root } };
    },
    async closeProject() {},
    async listAssets() {
      return [{
        guid: 'scene-guid',
        kind: 'scene',
        name: 'Main scene',
        previewable: true,
        sourcePath: 'assets/scene.pack.ts',
        sourceKind: 'pack.ts',
        revision: '1',
      }];
    },
    async openPreview({ asset, width, height }) {
      return transactionPreview({ asset, camera: {},
        target: { targetId: `target:${asset.guid}`, sessionId: 'session', worldId: 'world', headed: true, width, height },
        capture() { return { targetId: `target:${asset.guid}` }; },
      });
    },
    async assetInspect({ subject }) {
      return {
        guid: subject,
        kind: 'scene',
        name: 'Main scene',
        sourcePath: 'assets/scene.pack.ts',
      };
    },
    pack: {
      async inspect(sourcePath) {
        return {
          revision: '1',
          meta: {
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            packageId: '11111111-1111-4111-8111-111111111111',
            importer: 'pack-ts',
            source: sourcePath,
            importSettings: { contractVersion: '1.0.0', externalAssets: [] },
            subAssets: [{ guid: 'scene-guid', sourceIndex: 0, sourceKey: 'scene', kind: 'scene' }],
          },
        };
      },
      async rebuild(sourcePath, mode) {
        return { revision: '2', meta: { importer: 'pack-ts', source: sourcePath, subAssets: [] } };
      },
    },
  });
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

async function callCli(view, operation, args = {}) {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [cliPath, 'workspace', '--operation', operation, '--args', JSON.stringify(args)],
      {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          FORGEAX_VIEW_WORKSPACE_ENDPOINT: view.workspaceEndpoint,
          FORGEAX_VIEW_WORKSPACE_TOKEN: view.workspaceAccessToken,
          FORGEAX_VIEW_CLIENT_ID: 'spawned-cli',
        },
      },
    );
    assert.equal(stderr, '');
    return JSON.parse(stdout);
  } catch (error) {
    assert.equal(error.stderr, '');
    return JSON.parse(error.stdout);
  }
}

async function callCliBatch(view, batch) {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [cliPath, 'workspace', '--batch', JSON.stringify(batch)],
      {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          FORGEAX_VIEW_WORKSPACE_ENDPOINT: view.workspaceEndpoint,
          FORGEAX_VIEW_WORKSPACE_TOKEN: view.workspaceAccessToken,
          FORGEAX_VIEW_CLIENT_ID: 'spawned-cli-batch',
        },
      },
    );
    assert.equal(stderr, '');
    return JSON.parse(stdout);
  } catch (error) {
    assert.equal(error.stderr, '');
    return JSON.parse(error.stdout);
  }
}

describe('View workspace CLI client', () => {
  it('uses a separate process and the same resident Engine Host API as the frontend', async () => {
    const view = await startView({
      frontend: true,
      platform: createBrowserPagePlatform({
        page: decorateBrowserPage({
          goto: async () => undefined,
          evaluate: async () => undefined,
          on() {},
          off() {},
          isClosed: () => false,
        }),
      }),
      workspaceEngine: workspaceEngine(),
    });
    cleanup.push(() => view.dispose());

    const opened = await callCli(view, 'project.open', {
      root: '/spawned-cli',
      tabId: VIEW_WORKSPACE_TAB_ID,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.value.project.root, '/spawned-cli');

    const frontend = view.frontendHost.context.get('viewOperationClient');
    const intent = await frontend.getState();
    assert.equal(intent.project, null);
    assert.deepEqual(intent.projectIntent, { root: '/spawned-cli' });

    const listed = await callCli(view, 'assets.list', {
      projectId: 'project:/spawned-cli',
      tabId: VIEW_WORKSPACE_TAB_ID,
    });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.value.assets.map((asset) => asset.guid), ['scene-guid']);
    assert.equal(listed.value.assets[0].sourcePath, 'assets/scene.pack.ts');
    const inspected = await callCli(view, 'asset.inspect', {
      projectId: 'project:/spawned-cli',
      tabId: VIEW_WORKSPACE_TAB_ID,
      guid: 'scene-guid',
    });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.value.inspection.source.kind, 'pack.ts');
    assert.equal(inspected.value.inspection.meta.importer, 'pack-ts');
    await frontend.openProject('/spawned-cli', { tabId: VIEW_WORKSPACE_TAB_ID });
    assert.deepEqual(
      (await frontend.listAssets('project:/spawned-cli', { tabId: VIEW_WORKSPACE_TAB_ID })).assets.map(
        (asset) => asset.guid,
      ),
      ['scene-guid'],
    );
  });

  it('returns the API business error unchanged to the process caller', async () => {
    const view = await startView({
      platform: createBrowserPagePlatform({
        page: decorateBrowserPage({
          goto: async () => undefined,
          evaluate: async () => undefined,
          on() {},
          off() {},
          isClosed: () => false,
        }),
      }),
      workspaceEngine: workspaceEngine(),
      frontend: false,
    });
    cleanup.push(() => view.dispose());
    const result = await callCli(view, 'project.open', {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'view-workspace-invalid-args');
  });

  it('keeps a camera transaction on one authenticated connection in batch mode', async () => {
    const view = await startView({
      platform: createBrowserPagePlatform({
        page: decorateBrowserPage({
          goto: async () => undefined,
          evaluate: async () => undefined,
          on() {},
          off() {},
          isClosed: () => false,
        }),
      }),
      workspaceEngine: workspaceEngine(),
      frontend: false,
    });
    cleanup.push(() => view.dispose());

    const result = await callCliBatch(view, [
      {
        operation: 'project.open',
        args: { root: '/batch', tabId: VIEW_WORKSPACE_TAB_ID },
      },
      {
        operation: 'asset.open',
        args: { projectId: 'project:/batch', guid: 'scene-guid', tabId: VIEW_WORKSPACE_TAB_ID },
      },
      {
        operation: 'camera.get',
        args: { targetId: 'target:scene-guid', targetGeneration: 1, tabId: VIEW_WORKSPACE_TAB_ID },
      },
      {
        operation: 'camera.begin',
        args: {
          targetId: 'target:scene-guid', targetGeneration: 1,
          tabId: VIEW_WORKSPACE_TAB_ID,
          baseVersion: 0,
          interactionId: 'batch-interaction',
        },
      },
      {
        operation: 'camera.update',
        args: {
          targetId: 'target:scene-guid', targetGeneration: 1,
          tabId: VIEW_WORKSPACE_TAB_ID,
          interactionId: 'batch-interaction',
          input: { type: 'look', yaw: -0.003, pitch: 0 },
        },
      },
      {
        operation: 'camera.commit',
        args: {
          targetId: 'target:scene-guid', targetGeneration: 1,
          tabId: VIEW_WORKSPACE_TAB_ID,
          interactionId: 'batch-interaction',
          operationId: 'batch-operation',
          expectedVersion: 0,
          camera: {},
        },
      },
      {
        operation: 'tabs.get',
        args: {},
      },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.length, 7);
    assert.equal(result.value[3].interactionId, 'batch-interaction');
    assert.equal(result.value[5].committed, true);
    assert.equal(result.value[6].preview.interaction, null);
  });
});
