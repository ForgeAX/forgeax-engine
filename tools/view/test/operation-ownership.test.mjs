import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startView } from '../src/bootstrap.ts';
import { createViewProductPlan } from '@forgeax/view-viewer/catalog/shared';
import { VIEW_PRODUCT_BACKEND_CATALOG } from '@forgeax/view-viewer/catalog/backend';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { ViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function provider() {
  return {
    openProject: ({ root }) => ({ project: { id: root, root } }),
    closeProject() {}, listAssets: () => [{ guid: 'asset', kind: 'mesh' }],
    openPreview() { throw new Error('unused'); },
    inspectAsset: ({ guid }) => ({ guid, kind: 'mesh' }),
  };
}

describe('Engine operation ownership and optional View plugins', () => {
  it('assembles only the native endpoints a plugin implements', () => {
    const plan = createViewProductPlan();
    for (const id of ['viewport', 'content-browser', 'inspector', 'scene-tree', 'material', 'mesh', 'texture', 'asset']) {
      assert.ok(plan.frontend.some(value => value.module.includes(`view-plugin-${id}`) || value.module.includes(`/plugins/${id}/`)));
    }
    assert.equal(plan.backend.length, 3);
    assert.equal(VIEW_PRODUCT_BACKEND_CATALOG.size, plan.backend.length);
  });
  it('removes View Fibers without disposing a borrowed Engine Host', async () => {
    const host = await createBackendHost();
    const engine = provider();
    const engineFiber = await host.context.plugin({
      name: 'fixture.engine', provide: ['engineWorkspace'],
      apply(ctx) { ctx.provide('engineWorkspace', engine); },
    });
    await engineFiber.await();
    const view = await startView({ backendHost: host, workspaceServer: false });
    try {
      assert.equal(view.frontendHost, undefined);
      assert.equal(host.context.get('engineWorkspace'), engine);
      assert.ok(host.context.get('viewWorkspaceCore'));
      const api = host.context.get('toolApi');
      assert.equal(api.describe('view.workspace.tabs.get', 'view-workspace').filter(record => record.callable).length, 1);
      const opened = await api.run('view.workspace.call', { operation: 'tabs.get', args: {} }, {
        sourceId: 'view-workspace',
      }).terminal;
      assert.equal(opened.outcome, 'succeeded');
      assert.equal(opened.result.selectedTabId, 'forgeax-user-workspace');
      const rejected = await api.run('view.workspace.tabs.get', {
        clientId: 'untrusted', token: 'wrong-token', args: {},
      }, { sourceId: 'view-workspace' }).terminal;
      assert.equal(rejected.outcome, 'failed');
      const transport = host.transport.connect();
      try {
        const client = new ViewWorkspaceClient({
          transport, clientId: 'view-frontend-test',
          token: host.context.get('viewWorkspaceCore').accessToken,
        });
        assert.equal((await client.getState()).selectedTabId, opened.result.selectedTabId);
        const selected = await api.run('view.workspace.call', {
          operation: 'tabs.select', args: { tabId: 'forgeax-cli-display' },
        }, { sourceId: 'view-workspace' }).terminal;
        assert.equal(selected.outcome, 'succeeded');
        assert.equal((await client.getState()).selectedTabId, 'forgeax-cli-display');
      } finally { transport.close(); }
      await view.dispose();
      assert.equal(host.context.get('viewWorkspaceCore', false), undefined);
      assert.equal(api.describe('view.workspace.tabs.get', 'view-workspace').filter(record => record.callable).length, 0);
      assert.equal(host.context.get('engineWorkspace'), engine);
    } finally { await engineFiber.dispose(); await host.dispose(); }
  });
  it('keeps product plugins independent and foundation dependencies acyclic', async () => {
    const packageRoot = path.join(root, 'packages');
    const productDirectories = (await readdir(packageRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('view-plugin-'))
      .map((entry) => path.join(packageRoot, entry.name));
    const siblingPackagePattern = /^@forgeax\/view-plugin-/;
    const siblingImportPattern = /(?:from\s+|import\s*\()['"](@forgeax\/view-plugin-[^'"]+)['"]/g;
    const rootTraversalPattern =
      /(?:from\s+|import\s*\()['"](?:\.\.\/){2,}src\/workspace\//;
    for (const directory of productDirectories) {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      const dependencies = Object.keys(manifest.dependencies ?? {});
      assert.deepEqual(
        dependencies.filter((dependency) => siblingPackagePattern.test(dependency)),
        [],
        `${directory} declares a sibling product dependency`,
      );
      const files = await readdir(path.join(directory, 'src'), { recursive: true });
      for (const relative of files.filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file))) {
        const source = await readFile(path.join(directory, 'src', relative), 'utf8');
        const siblingImports = [...source.matchAll(siblingImportPattern)].map(match => match[1]);
        assert.deepEqual(siblingImports, [], `${path.join(directory, 'src', relative)} imports a sibling implementation`);
        assert.equal(rootTraversalPattern.test(source), false, `${path.join(directory, 'src', relative)} traverses into root workspace source`);
      }
    }

    const workspaceCore = path.join(packageRoot, 'view-workspace-core');
    const workspaceManifest = JSON.parse(
      await readFile(path.join(workspaceCore, 'package.json'), 'utf8'),
    );
    assert.equal(workspaceManifest.exports['./ui'], undefined);
    assert.equal(workspaceManifest.exports['./frontend'], undefined);
    assert.equal(workspaceManifest.dependencies?.['@forgeax/view-components'], undefined);
    for (const relative of (await readdir(path.join(workspaceCore, 'src'), { recursive: true }))
      .filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file))) {
      const source = await readFile(path.join(workspaceCore, 'src', relative), 'utf8');
      assert.doesNotMatch(source, /from\s+['"](?:react|react-dom|@forgeax\/view-components)/);
      assert.doesNotMatch(source, /document\.createElement/);
    }

    const components = path.join(packageRoot, 'view-components');
    const componentsManifest = JSON.parse(
      await readFile(path.join(components, 'package.json'), 'utf8'),
    );
    assert.equal(componentsManifest.dependencies?.['@forgeax/view-workspace-core'], undefined);
    for (const relative of (await readdir(path.join(components, 'src'), { recursive: true }))
      .filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file))) {
      const source = await readFile(path.join(components, 'src', relative), 'utf8');
      assert.doesNotMatch(source, /@forgeax\/view-workspace-core/);
    }
  });

});
