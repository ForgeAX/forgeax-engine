import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '@forgeax/engine-plugin';
import { applyResourcePagePlugin } from '../packages/view-workspace-core/src/resource-page.ts';
import * as mesh from '../packages/view-plugin-mesh/src/identity.ts';

it('resource actions observe live workspace state, reject stale actions and release the subscription on removal', async () => {
  const ctx = new Context();
  const listeners = new Set(), claims = [], calls = [];
  let state = { revision: 1, project: { id: 'project', root: '/project' }, projectTarget: { targetId: 'project-target', generation: 1 },
    assets: [{ guid: 'material', kind: 'material' }] };
  ctx.provide('viewOperationClient', {
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async getState() { return state; },
    async call(operation, args) { calls.push({ operation, args }); },
  });
  const plugin = { name: 'test-resource-actions', inject: ['viewOperationClient'],
    apply(inner) { return applyResourcePagePlugin(inner, {
      pageHost: { registerType() { return () => {}; } },
      panelHost: { async mountPanel(claim) { claims.push(claim); return () => {}; } },
    }, mesh); } };
  try {
    let fiber = ctx.plugin(plugin); await fiber.await();
    assert.equal(listeners.size, 1);
    const resolve = claims.find(claim => claim.props.assetActions).props.assetActions;
    const actions = resolve({ guid: 'material' });
    assert(actions?.onOpen);
    actions.onOpen(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[0].args.guid, 'material');
    assert.equal(calls[0].args.targetId, 'project-target');
    state = { ...state, revision: 2, projectTarget: { targetId: 'replacement', generation: 2 } };
    for (const listener of listeners) listener(state);
    actions.onOpen(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    await fiber.dispose(); assert.equal(listeners.size, 0);
    claims.length = 0;
    fiber = ctx.plugin(plugin); await fiber.await();
    const restored = claims.find(claim => claim.props.assetActions).props.assetActions({ guid: 'material' });
    restored.onOpen(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1).args.targetId, 'replacement');
    await fiber.dispose(); assert.equal(listeners.size, 0);
  } finally { await ctx.fiber.dispose(); }
});
