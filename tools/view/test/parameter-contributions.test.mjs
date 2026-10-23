import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import { createContentBrowserDetailTabs } from '../packages/view-workspace-core/src/content-browser-detail-tabs.ts';
import { viewWorkspaceCoreFrontendPlugin } from '../packages/view-workspace-core/src/frontend-plugin.ts';
import { mountDetailTabContribution } from '../packages/view-plugin-content-browser/src/detail-tab-mount.ts';
import { createViewPanelHost } from '../packages/viewer/src/host/panel-bridge.ts';
import { createViewProductPlan, VIEW_WORKSPACE_CORE } from '../packages/viewer/src/catalog-shared.ts';
import * as contentBrowserIdentity from '../packages/view-plugin-content-browser/src/identity.ts';
import contentBrowserFrontendPlugin from '../packages/view-plugin-content-browser/src/frontend.ts';
import { PARAMETERS_FRONTEND_MODULE } from '../packages/view-plugin-parameters/src/identity.ts';
import parametersFrontendPlugin from '../packages/view-plugin-parameters/src/frontend.ts';
import { generationPreviewTargetId, partitionPackFields, resolveAssetPageBinding } from '../packages/view-plugin-parameters/src/field-partition.ts';
import { VIEW_PAGE_TYPES } from '../packages/view-workspace-core/src/contract.ts';

function pageRegistry() {
  const types = new Map();
  const listeners = new Set();
  const snapshot = () => [...types.values()];
  return {
    getTypes: snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    register(type) { types.set(type.typeId, type); for (const listener of listeners) listener(snapshot()); return () => { types.delete(type.typeId); for (const listener of listeners) listener(snapshot()); }; },
  };
}

function slots() {
  const claims = new Map();
  return {
    claims,
    claim(claim) { claims.set(claim.id, claim); return () => { if (claims.get(claim.id) === claim) claims.delete(claim.id); }; },
    resolveWhenReady(id) { return Promise.resolve({ id }); },
    resolve(id) { return { id }; },
  };
}

const contribution = typeId => ({
  typeId,
  context: 'project', title: typeId, order: 1, closable: true, singleton: false,
  initial: false, openable: true, layout: 'dock', showPanelRail: true,
  hideWhenInactive: false, resourceSelector: { kinds: ['mesh'] },
  controller: { getResource: () => undefined },
});

test('Content Browser detail tabs register and retire without Pack knowledge in the browser', () => {
  const registry = createContentBrowserDetailTabs();
  const updates = [];
  registry.subscribe(() => updates.push(registry.getSnapshot().map(item => item.id)));
  const release = registry.register({ id: 'pack-parameters', titleKey: 'parameters', matches: input => input.kind === 'file' && input.path.endsWith('.pack.ts'), mount() {} });
  assert.equal(registry.getSnapshot().length, 1);
  assert.equal(registry.getSnapshot()[0].matches({ kind: 'file', path: 'a.pack.ts' }), true);
  release();
  assert.equal(registry.getSnapshot().length, 0);
  assert.deepEqual(updates, [[], ['pack-parameters'], []]);
});

test('workspace-core owns the registry while Content Browser and Parameters activate independently', async () => {
  const ctx = new Context();
  assert.ok(viewWorkspaceCoreFrontendPlugin.provide.includes('contentBrowserDetailTabs'));
  const browserLoads = [];
  const browserFiber = ctx.plugin({
    name: 'content-browser-test', inject: ['contentBrowserDetailTabs'],
    apply(owner) { browserLoads.push(owner.get('contentBrowserDetailTabs')); },
  });
  await browserFiber;
  assert.equal(browserFiber.store, undefined);
  const workspaceFiber = ctx.plugin(viewWorkspaceCoreFrontendPlugin);
  await workspaceFiber.await();
  const registry = ctx.get('contentBrowserDetailTabs');
  await browserFiber.await();
  assert.deepEqual(browserLoads, [registry]);
  assert.equal(registry.getSnapshot().length, 0);
  assert.ok(browserFiber.store);
  let releaseContribution;
  const parametersFiber = ctx.plugin({
    name: 'parameters-test', inject: ['contentBrowserDetailTabs'],
    apply(owner) {
      releaseContribution = owner.get('contentBrowserDetailTabs').register({
        id: 'pack-parameters', titleKey: 'parameters', matches: () => true, mount() {},
      });
      owner.effect(() => releaseContribution);
    },
  });
  await parametersFiber.await();
  assert.deepEqual(registry.getSnapshot().map(item => item.id), ['pack-parameters']);
  await parametersFiber.dispose();
  await parametersFiber.await();
  assert.equal(registry.getSnapshot().length, 0);
  assert.ok(browserFiber.store);
  await ctx.fiber.dispose();
});

test('the Parameters capability and Content Browser stay active when a page is disabled', () => {
  const plan = createViewProductPlan({ disabledPages: [VIEW_PAGE_TYPES.scene] });
  assert.equal(plan.frontend.some(plugin => plugin.module === contentBrowserIdentity.FRONTEND_MODULE), true);
  assert.equal(plan.frontend.some(plugin => plugin.module === PARAMETERS_FRONTEND_MODULE), true);
  assert.equal(plan.frontend.some(plugin => plugin.module === VIEW_WORKSPACE_CORE.FRONTEND_MODULE), true);
});

test('Content Browser claims a Shell-bottom home', async () => {
  const claims = [];
  const cleanup = [];
  const context = {
    get: name => name === 'contentBrowserDetailTabs' ? createContentBrowserDetailTabs() : {},
    provide() {},
    effect(factory) { cleanup.push(factory()); },
  };
  const document = {
    createElement() { return { dataset: {}, append() {} }; },
  };
  const panelHost = {
    claim(claim) { claims.push(claim); return () => {}; },
    waitForSlot: async () => {},
    mount: () => () => {},
    mountPanelInto: async () => () => {},
  };
  await contentBrowserFrontendPlugin.apply(context, { document, panelHost });
  assert.deepEqual(claims.map(({ id, home, layout }) => [id, home, layout]), [
    [contentBrowserIdentity.SLOT, { kind: 'shell-bottom' }, { order: 0 }],
  ]);
  for (const dispose of cleanup) await dispose();
});

test('Parameters registers its detail tab without a panel host', async () => {
  const ctx = new Context();
  const details = createContentBrowserDetailTabs();
  ctx.provide('viewOperationClient', {});
  ctx.provide('contentBrowserDetailTabs', details);
  try {
    const fiber = ctx.plugin(parametersFrontendPlugin);
    await fiber.await();
    assert.deepEqual(details.getSnapshot().map(item => item.id), ['pack-parameters']);
  } finally { await ctx.fiber.dispose(); }
  assert.deepEqual(details.getSnapshot(), []);
});

test('detail contribution cleanup owns only its mount node across tab switches', async () => {
  const children = [];
  const container = {
    ownerDocument: { createElement: () => ({ removed: false, remove() { this.removed = true; } }) },
    append(element) { children.push(element); },
  };
  let resolveFirst;
  const first = {
    id: 'first', titleKey: 'first', matches: () => true,
    mount() { return new Promise(resolve => { resolveFirst = resolve; }); },
  };
  const errors = [];
  const cleanupFirst = mountDetailTabContribution(container, first, {}, error => errors.push(error));
  const second = {
    id: 'second', titleKey: 'second', matches: () => true,
    mount() { return () => {}; },
  };
  const cleanupSecond = mountDetailTabContribution(container, second, {}, error => errors.push(error));
  await Promise.resolve();
  cleanupFirst();
  resolveFirst(() => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(children.length, 2);
  assert.equal(children[0].removed, true);
  assert.equal(children[1].removed, false);
  assert.deepEqual(errors, []);
  cleanupSecond();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(children[1].removed, true);
});

test('detail contribution mount reports synchronous throws through the error callback', async () => {
  const children = [];
  const container = {
    ownerDocument: { createElement: () => ({ removed: false, remove() { this.removed = true; } }) },
    append(element) { children.push(element); },
  };
  const error = new Error('mount failed');
  const errors = [];
  mountDetailTabContribution(container, {
    id: 'broken', titleKey: 'broken', matches: () => true,
    mount() { throw error; },
  }, {}, value => errors.push(value));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(errors, [error]);
  assert.equal(children[0].removed, true);
});

test('asset panel projection handles either registration order and retires every page slot', async () => {
  const previous = globalThis.__forgeaxViewPanelsPromise;
  const mounted = [];
  const disposed = [];
  globalThis.__forgeaxViewPanelsPromise = Promise.resolve({
    mountParametersPanel: async input => { mounted.push(input); return () => disposed.push(input.slot); },
  });
  try {
    const pages = pageRegistry();
    const registry = slots();
    const host = createViewPanelHost({ registry, pageRegistry: pages });
    const release = host.mountAssetPanel({ id: 'parameters', kinds: ['mesh'], panel: 'Parameters', titleKey: 'parameters', layout: { dock: 'right', stack: 'tabs', order: 1 }, props: {} });
    const removeFirst = pages.register(contribution('mesh-page'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual([...registry.claims.keys()], ['parameters:mesh-page']);
    assert.equal(mounted[0].assetPage.pageTypeId, 'mesh-page');
    let currentResource = { asset: { guid: 'first', kind: 'mesh' } };
    const dynamicType = pages.getTypes()[0];
    dynamicType.controller.getResource = () => currentResource;
    const getResource = mounted[0].assetPage.getResource;
    assert.equal(getResource().asset.guid, 'first');
    currentResource = { asset: { guid: 'second', kind: 'mesh' } };
    assert.equal(getResource().asset.guid, 'second');
    removeFirst();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual([...registry.claims.keys()], []);
    release();

    const pagesBefore = pageRegistry();
    const slotsBefore = slots();
    pagesBefore.register(contribution('mesh-existing'));
    const hostBefore = createViewPanelHost({ registry: slotsBefore, pageRegistry: pagesBefore });
    const releaseBefore = hostBefore.mountAssetPanel({ id: 'parameters', kinds: ['mesh'], panel: 'Parameters', titleKey: 'parameters', layout: { dock: 'right', stack: 'tabs', order: 1 }, props: {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual([...slotsBefore.claims.keys()], ['parameters:mesh-existing']);
    releaseBefore();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(disposed.includes('parameters:mesh-existing'));
  } finally {
    if (previous === undefined) delete globalThis.__forgeaxViewPanelsPromise;
    else globalThis.__forgeaxViewPanelsPromise = previous;
  }
});

test('parameter fields partition by exact output source key and page asset identity', () => {
  const fields = [
    { name: 'seed', apply: 'build' },
    { name: 'roughness', apply: { asset: 'mesh/a' } },
    { name: 'tint', apply: { asset: 'mesh/b' } },
    { name: 'ambiguous', apply: { asset: '' } },
  ];
  const a = partitionPackFields(fields, 'mesh/a');
  assert.deepEqual(a.generation.map(field => field.name), ['seed']);
  assert.deepEqual(a.runtime.map(field => field.name), ['roughness']);
  assert.deepEqual(partitionPackFields(fields, undefined).runtime, []);

  const assets = [
    { guid: 'a', kind: 'mesh', sourceKey: 'mesh/a', sourcePath: 'assets/a.pack.ts' },
    { guid: 'b', kind: 'mesh', sourceKey: 'mesh/b', sourcePath: 'assets/b.pack.ts' },
  ];
  const pageResource = { asset: { guid: 'a', kind: 'mesh' } };
  assert.equal(resolveAssetPageBinding(pageResource, assets).sourceKey, 'mesh/a');
  pageResource.asset = { guid: 'b', kind: 'mesh' };
  assert.equal(resolveAssetPageBinding(pageResource, assets).sourcePath, 'assets/b.pack.ts');
  assert.deepEqual(resolveAssetPageBinding({ asset: { guid: 'proof', kind: 'scene' } }, [
    { guid: 'proof', kind: 'scene', sourceKey: 'scene/proof', path: 'assets/proof.pack.ts' },
  ]), {
    asset: { guid: 'proof', kind: 'scene', sourceKey: 'scene/proof', path: 'assets/proof.pack.ts' },
    sourceKey: 'scene/proof',
    sourcePath: 'assets/proof.pack.ts',
  });
  assert.equal(resolveAssetPageBinding({ asset: { guid: 'missing', kind: 'mesh' } }, assets), undefined);
  assert.equal(resolveAssetPageBinding({ asset: { guid: 'a', kind: 'material' } }, assets), undefined);
  assert.equal(resolveAssetPageBinding({ asset: { guid: 'model', kind: 'model' } }, [
    { guid: 'model', kind: 'model', sourceKey: 'model/a.glb', sourcePath: 'assets/a.glb' },
  ]), undefined);
});

test('generation binds a live same-source scene preview when several outputs are open', () => {
  assert.equal(generationPreviewTargetId([
    { asset: { kind: 'material' }, target: { targetId: 'material' } },
    { asset: { kind: 'mesh' }, target: { targetId: 'mesh' } },
    { asset: { kind: 'scene' }, target: { targetId: 'scene' } },
  ]), 'scene');
  assert.equal(generationPreviewTargetId([{ asset: { kind: 'material' }, target: { targetId: 'material' } }]), 'material');
  assert.equal(generationPreviewTargetId([]), undefined);
});
