import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Context } from '@forgeax/engine-plugin';

import viewPlugin, { FORGEAX_VIEW_PLUGIN_ID, FORGEAX_VIEW_PLUGIN_MODULE } from '../src/plugin.ts';
import {
  createViewCliContributions,
  createViewHostCliContributions,
} from '../src/cli-contributions.ts';
import { createViewProductPlan } from '@forgeax/view-viewer/catalog/shared';
import scenePagePlugin from '../packages/view-plugin-scene/src/frontend.ts';
import workspaceFrontendPlugin from '../packages/view-workspace-core/src/frontend-plugin.ts';
import pluginsFrontendPlugin from '../packages/view-plugin-plugins/src/frontend.ts';
import materialFrontendPlugin from '../packages/view-plugin-material/src/frontend.ts';
import meshFrontendPlugin from '../packages/view-plugin-mesh/src/frontend.ts';
import textureFrontendPlugin from '../packages/view-plugin-texture/src/frontend.ts';
import assetFrontendPlugin from '../packages/view-plugin-asset/src/frontend.ts';
import { PAGE_TYPE as DISPLAY_PAGE_TYPE } from '../packages/view-plugin-display/src/identity.ts';
import { PAGE_TYPE as SCENE_TREE_PAGE_TYPE } from '../packages/view-plugin-scene-tree/src/identity.ts';
import { PAGE_TYPE as INSPECTOR_PAGE_TYPE } from '../packages/view-plugin-inspector/src/identity.ts';
import { PAGE_TYPE as CONTENT_BROWSER_PAGE_TYPE } from '../packages/view-plugin-content-browser/src/identity.ts';
import { PAGE_TYPE as VIEWPORT_PAGE_TYPE } from '../packages/view-plugin-viewport/src/identity.ts';
import { VIEW_PAGE_TYPES } from '../packages/view-workspace-core/src/contract.ts';
import { resolveResourcePageType } from '../packages/viewer/src/host/page-registry.ts';

describe('forgeax-view package contribution', () => {
  it('assigns page types through frontend plugin lifecycles', async () => {
    const pageTypes = new Map();
    const claims = [];
    const effects = [];
    const reporterClient = { sources() {}, inspect() {} };
    const pageHost = {
      registerType(pageType) {
        assert.equal(pageTypes.has(pageType.typeId), false);
        pageTypes.set(pageType.typeId, pageType);
        return () => pageTypes.delete(pageType.typeId);
      },
    };
    const panelHost = {
      async mountPanel(claim) {
        claims.push(claim);
        return () => {};
      },
    };
    const ctx = {
      get(name) {
        if (name === 'viewInspectorClient') return reporterClient;
        return name === 'viewOperationClient' ? {} : undefined;
      },
      provide() {},
      effect(factory) {
        effects.push(factory());
      },
    };
    const nativeContext = new Context();
    const workspaceFiber = await nativeContext.plugin(workspaceFrontendPlugin, { pageHost });
    await workspaceFiber.await();
    assert.equal(pageTypes.size, 0, 'Workspace client does not own pages');
    const sceneFiber = await nativeContext.plugin(scenePagePlugin, { pageHost });
    await sceneFiber.await();
    await pluginsFrontendPlugin.apply(ctx, { pageHost, panelHost });
    assert.equal(claims.find(claim => claim.id === 'plugins').props.client, reporterClient,
      'plugin inspection must use the same Host connection as the frontend reporter');
    await materialFrontendPlugin.apply(ctx, { pageHost, panelHost });
    await meshFrontendPlugin.apply(ctx, { pageHost, panelHost });
    await textureFrontendPlugin.apply(ctx, { pageHost, panelHost });
    await assetFrontendPlugin.apply(ctx, { pageHost, panelHost });

    assert.deepEqual([...pageTypes.keys()], [
      VIEW_PAGE_TYPES.scene,
      VIEW_PAGE_TYPES.plugins,
      VIEW_PAGE_TYPES.material,
      VIEW_PAGE_TYPES.mesh,
      VIEW_PAGE_TYPES.texture,
      VIEW_PAGE_TYPES.asset,
    ]);
    assert.deepEqual(claims.map(({ pageType, id }) => `${pageType}:${id}`), [
      `${VIEW_PAGE_TYPES.plugins}:plugins`,
      `${VIEW_PAGE_TYPES.material}:material-preview`,
      `${VIEW_PAGE_TYPES.material}:material-properties`,
      `${VIEW_PAGE_TYPES.material}:material-stats`,
      `${VIEW_PAGE_TYPES.mesh}:mesh-preview`,
      `${VIEW_PAGE_TYPES.mesh}:mesh-properties`,
      `${VIEW_PAGE_TYPES.texture}:texture-preview`,
      `${VIEW_PAGE_TYPES.texture}:texture-properties`,
      `${VIEW_PAGE_TYPES.asset}:asset-properties`,
    ]);
    assert.deepEqual(pageTypes.get(VIEW_PAGE_TYPES.material).resourceSelector, { kinds: ['material'] });
    assert.deepEqual(pageTypes.get(VIEW_PAGE_TYPES.mesh).resourceSelector, { kinds: ['mesh'] });
    assert.deepEqual(pageTypes.get(VIEW_PAGE_TYPES.texture).resourceSelector, { kinds: ['texture', 'image', 'equirect'] });
    assert.deepEqual(pageTypes.get(VIEW_PAGE_TYPES.asset).resourceSelector, { fallback: true });
    assert.equal(resolveResourcePageType([...pageTypes.values()], { kind: 'scene' }).pageType.typeId, VIEW_PAGE_TYPES.scene);
    assert.deepEqual(pageTypes.get(VIEW_PAGE_TYPES.scene).resourceSelector, { kinds: ['scene'] });
    assert.equal(pageTypes.get(VIEW_PAGE_TYPES.material).priority, 20);
    assert.equal(pageTypes.get(VIEW_PAGE_TYPES.asset).priority, 0);
    assert.equal(pageTypes.get(VIEW_PAGE_TYPES.scene).priority, 10);
    const materialPreview = claims.find((claim) => claim.id === 'material-preview');
    const materialStats = claims.find((claim) => claim.id === 'material-stats');
    assert.equal(materialStats.closable, true);
    assert.deepEqual(materialStats.layout, { dock: 'right-bottom', stack: 'tabs', order: 2 });
    assert.deepEqual(materialPreview.props.owner, {
      panelId: 'material-preview',
      pageType: VIEW_PAGE_TYPES.material,
    });
    assert.equal(DISPLAY_PAGE_TYPE, VIEW_PAGE_TYPES.display);
    assert.equal(VIEWPORT_PAGE_TYPE, VIEW_PAGE_TYPES.scene);
    assert.equal(SCENE_TREE_PAGE_TYPE, VIEW_PAGE_TYPES.scene);
    assert.equal(INSPECTOR_PAGE_TYPE, VIEW_PAGE_TYPES.scene);
    assert.equal(CONTENT_BROWSER_PAGE_TYPE, VIEW_PAGE_TYPES.scene);
    const contentBrowser = await readFile(
      new URL('../packages/view-plugin-content-browser/src/ui/ContentBrowserPanel.tsx', import.meta.url),
      'utf8',
    );
    assert.match(contentBrowser, /client\.openAsset\(guid/);
    assert.doesNotMatch(contentBrowser, /suggestedPageType|kind switch/i);
    const [workspaceCore, viewportFrontend] = await Promise.all([
      readFile(new URL('../packages/view-workspace-core/src/frontend-plugin.ts', import.meta.url), 'utf8'),
      readFile(new URL('../packages/view-plugin-viewport/src/frontend.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(workspaceCore, /observeWorkspaceOpenRequests/);
    assert.match(workspaceCore, /pageHost\.openResource/);
    assert.doesNotMatch(viewportFrontend, /viewInlinePreviewsPlugin|inline-previews/);
    const previewPanels = await Promise.all([
      readFile(new URL('../packages/view-plugin-material/src/ui/MaterialPreviewPanel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../packages/view-plugin-mesh/src/ui/MeshPreviewPanel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../packages/view-plugin-texture/src/ui/TexturePreviewPanel.tsx', import.meta.url), 'utf8'),
    ]);
    for (const source of previewPanels) {
      assert.doesNotMatch(source, /<canvas/);
      assert.match(source, /bindWorkspacePreviewSurface/);
      assert.match(source, /containerRef/);
    }
    for (const dispose of effects.reverse()) await dispose();
    await nativeContext.fiber.dispose();
    assert.equal(pageTypes.size, 0);
  });

  it('exports one native host implementation for a project PluginAsset', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.equal(manifest.forgeax?.plugins, undefined);
    assert.equal(manifest.exports['./plugin'], './dist/modules/plugin.mjs');
    assert.equal(manifest.exports['./frontend-root'], './dist/modules/frontend-root.mjs');
    assert.equal(typeof viewPlugin.apply, 'function');
    assert.equal(viewPlugin.name, FORGEAX_VIEW_PLUGIN_ID);
    assert.equal(FORGEAX_VIEW_PLUGIN_MODULE, '@forgeax/view/plugin');
    assert.equal(createViewProductPlan().backend.length, 3);
  });

  it('contributes the owner lifecycle commands at the package level', () => {
    const root = createViewHostCliContributions();
    assert.deepEqual(
      root.map(({ id, path }) => ({ id, path })),
      [
        { id: 'view.start', path: ['view', 'start'] },
        { id: 'view.status', path: ['view', 'status'] },
        { id: 'view.stop', path: ['view', 'stop'] },
        { id: 'view.project.open', path: ['view', 'project', 'open'] },
        { id: 'view.workspace.call', path: ['view', 'workspace', 'call'] },
      ],
    );
    const lifecycle = createViewCliContributions();
    assert.deepEqual(lifecycle.map(({ id }) => id), [
      'view.start',
      'view.status',
      'view.stop',
      'view.project.open',
      'view.workspace.call',
    ]);
  });

  it('derives domain CLI contributions from Engine capabilities independently of UI pages', () => {
    const selected = createViewCliContributions({
      capabilities: { operations: ['tabs.get', 'plugins.sources', 'assets.list'], descriptions: [{ id: 'assets.list', summary: 'Engine catalog' }] },
    });
    assert.deepEqual(
      selected.map(({ id }) => id),
      [
        'view.start',
        'view.status',
        'view.stop',
        'view.project.open',
        'view.workspace.call',
        'view.workspace.tabs.get',
        'view.workspace.assets.list',
        'plugins.sources',
      ],
    );
    assert.equal(selected.some(({ operation }) => operation === 'assets.list'), true);
  });
});
