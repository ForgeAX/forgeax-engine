import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import scenePage from '../packages/view-plugin-scene/src/frontend.ts';
import playPresentation from '../packages/view-plugin-viewport/src/presentation.ts';
import { createViewProductPlan } from '../packages/viewer/src/catalog-shared.ts';
import { VIEW_PRODUCT_FRONTEND_CATALOG } from '../packages/viewer/src/frontend-catalog.ts';
import { VIEW_PRODUCT_BACKEND_CATALOG } from '../packages/viewer/src/backend-catalog.ts';
import { loadPluginEntries } from '../packages/view-plugin-plugins/src/ui/plugin-entries.ts';

it('waits for browser retirement before creating Play and retains an existing frame until cleanup', async () => {
  const context = new Context();
  const frames = new Set();
  let publish;
  let revision = 0;
  const document = {
    body: { append(frame) { frames.add(frame); } },
    createElement(tag) {
      assert.equal(tag, 'iframe');
      return { style: {}, dataset: {}, remove() { frames.delete(this); } };
    },
  };
  context.provide('viewOperationClient', {
    subscribe(listener) { publish = listener; return () => { publish = undefined; }; },
  });
  const target = { targetId: 'old-play', url: 'http://play.invalid/', width: 640, height: 480 };
  const update = (projectPhase, play) => publish({ revision: ++revision, projectPhase, play, targetBinding: 'scene' });
  try {
    const fiber = context.plugin(playPresentation, { document });
    await fiber.await();
    update('starting', { target });
    assert.equal(frames.size, 0, 'A refreshed page must not resurrect the retiring Play owner');
    update('running', undefined);
    assert.equal(frames.size, 0);
    update('running', { target: { ...target, targetId: 'explicit-new-play' } });
    assert.equal(frames.size, 1);
    const frame = [...frames][0];
    update('starting', { target: { ...target, targetId: 'explicit-new-play' } });
    assert.equal([...frames][0], frame, 'The cleanup command still needs the existing browser');
    update('starting', undefined);
    assert.equal(frames.size, 0);
    update('starting', { target });
    assert.equal(frames.size, 0);
    update('running', { target });
    assert.equal(frames.size, 1, 'A phase-only publication must admit the new browser');
  } finally { await context.fiber.dispose(); }
  assert.equal(frames.size, 0);
});

it('keeps connection-owned Play alive when the Scene Fiber and its dependent panel are removed', async () => {
  const context = new Context();
  const client = {};
  const types = new Set();
  let panels = 0;
  context.provide('viewOperationClient', client);
  const pageHost = { registerType({ typeId }) {
    types.add(typeId);
    return () => types.delete(typeId);
  } };
  try {
    const play = await context.plugin(playPresentation, { document: {} });
    await play.await();
    const service = context.get('viewPlayPresentation');
    const scene = await context.plugin(scenePage, { pageHost });
    await scene.await();
    const panel = await context.plugin({
      name: 'test.scene-panel', inject: ['viewScenePage'],
      apply(ctx) { ctx.effect(() => { panels += 1; return () => { panels -= 1; }; }); },
    });
    await panel.await();
    assert.equal(panels, 1);
    await scene.dispose();
    assert.equal(panels, 0);
    assert.deepEqual([...types], []);
    assert.equal(context.get('viewPlayPresentation'), service);
    assert.equal(context.get('viewOperationClient'), client);
    const restored = await context.plugin(scenePage, { pageHost });
    await restored.await();
    await panel.await();
    assert.equal(panels, 1);
    assert.deepEqual([...types], ['scene']);
  } finally { await context.fiber.dispose(); }
  assert.equal(panels, 0);
  assert.deepEqual([...types], []);
});

it('gives every installed View role a distinct native Plugin name', async () => {
  const ids = new Set();
  const plan = createViewProductPlan();
  for (const [side, catalog] of [['backend', VIEW_PRODUCT_BACKEND_CATALOG], ['frontend', VIEW_PRODUCT_FRONTEND_CATALOG]]) {
    for (const component of plan[side]) {
      assert.equal(ids.has(component.id), false, component.id);
      ids.add(component.id);
      assert.match(component.id, /^forgeax\.view\.(page|panel|service|shell)\.[a-z-]+\.(backend|frontend)$/);
      const module = await catalog.get(component.module).load();
      assert.equal(module.default.name, component.id);
    }
  }
  assert.equal([...ids].filter((id) => id.startsWith('forgeax.view.page.')).length, 9);
});

it('shows observed backend Fibers and keeps missing frontend activation unknown', async () => {
  const hostAssembly = {
    current: { schemaVersion: 2, root: { program: 'fixture-root', codeRevision: '1' } },
    status: { state: 'unknown' },
    inspection: [{ uid: 1, name: 'scene-module', state: 'active' }],
  };
  const calls = [];
  const client = {
    sources: async () => ({ sources: [{ sourceId: 'backend', generation: 7, kind: 'backend' }] }),
    inspect: async (request) => {
      calls.push(request);
      return {
        sourceId: 'backend', kind: 'backend',
        assembly: hostAssembly.current,
        plugins: [{ entryId: 'fiber:2', module: 'service-module', fiberState: 'active' }],
        actual: { entries: [] },
      };
    },
  };
  const entries = await loadPluginEntries({ client, hostAssembly });
  assert.deepEqual(entries.map(({ entryId, state }) => [entryId, state]), [
    ['fiber:2', 'active'], ['fiber:1', 'active'],
  ]);
  assert.deepEqual(calls, [{ sourceId: 'backend', generation: 7 }]);
});

it('reports unavailable inspection instead of substituting sample plugins', async () => {
  await assert.rejects(loadPluginEntries(), /unavailable/);
  await assert.rejects(loadPluginEntries({
    client: { sources: async () => { throw new Error('disconnected'); }, inspect() {} },
  }), /disconnected/);
});

it('omits whole page contributions without disabling backend services or unrelated pages', () => {
  const plan = createViewProductPlan({ disabledPages: ['scene', 'plugins'] });
  const defaultPlan = createViewProductPlan();
  assert.deepEqual(defaultPlan.frontend.filter(item => !plan.frontend.some(active => active.id === item.id))
    .map(item => item.id).sort(), [
    'forgeax.view.page.scene.frontend',
    'forgeax.view.panel.scene-viewport.frontend',
    'forgeax.view.panel.asset-browser.frontend',
    'forgeax.view.panel.object-inspector.frontend',
    'forgeax.view.panel.scene-hierarchy.frontend',
    'forgeax.view.page.plugin-browser.frontend',
  ].sort());
  assert.equal(plan.backend.length, defaultPlan.backend.length);
  assert.throws(() => createViewProductPlan({ disabledPages: ['missing'] }), /Unknown View page/);
});
