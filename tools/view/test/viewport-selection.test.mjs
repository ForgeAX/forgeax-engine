import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import { isViewportWorkspaceInputEvent, ViewWorkspaceInputController } from '../packages/view-plugin-viewport/src/workspace-shell.ts';

const identity = { targetId: 'editor', targetGeneration: 1 };
function fixture(query) {
  const calls = [];
  const engine = { preview: { asset: { guid: 'scene', kind: 'scene' }, target: { targetId: 'editor', generation: 1 } } };
  const toolApi = {
    describe: () => [{ callable: true, owner: { providerId: 'engine', generation: 1 } }],
    run(id, args) {
      calls.push([id, args]);
      return { terminal: Promise.resolve().then(() => query(id, args)).then(
        result => ({ outcome: 'succeeded', result }),
        failure => ({ outcome: 'failed', failure }),
      ) };
    },
  };
  return { broker: new ViewWorkspaceBroker({ engine, toolApi }), engine, calls };
}

it('selects and clears through the same request path with exact target identity', async () => {
  let entityId = 'cube';
  const { broker, calls } = fixture((id, args) => id === 'engine.target.pick' ? { entityId } : { entityId: args.entityId });
  await broker.pickSceneEntity({ ...identity, x: 32, y: 64 });
  assert.equal(broker.snapshot().sceneSelection.primary.entityId, 'cube');
  assert.deepEqual(calls.map(([id]) => id), ['engine.target.pick', 'engine.entity.inspect', 'engine.entity.highlight']);
  entityId = null;
  await broker.pickSceneEntity({ ...identity, x: 0, y: 0 });
  assert.equal(broker.snapshot().sceneSelection, null);
  assert.equal(calls.at(-1)[0], 'engine.entity.highlight');
  assert.equal(calls.at(-1)[1].entityId, undefined);
});

it('keeps selection and target health on a pick error, and reports clear failures', async () => {
  let failure;
  const { broker } = fixture((_id, args) => {
    if (failure) throw failure;
    return { entityId: args.entityId };
  });
  await broker.selectSceneEntity({ ...identity, entityId: 'cube' });
  failure = { code: 'engine-workspace-frame-unavailable', expected: 'A submitted frame', hint: 'Wait for a frame' };
  await assert.rejects(broker.pickSceneEntity({ ...identity, x: 1, y: 1 }), /frame-unavailable/);
  assert.equal(broker.snapshot().sceneSelection.primary.entityId, 'cube');
  assert.equal(broker.snapshot().workspaceTargetLost, false);
  await assert.rejects(broker.clearSceneSelection(identity), /frame-unavailable/);
  assert.equal(broker.snapshot().sceneSelection.primary.entityId, 'cube');
});

it('rejects late picks after a tree selection, clear, cancellation or target replacement', async () => {
  for (const transition of ['select', 'clear', 'abort', 'replace']) {
    let resolve;
    const { broker, engine, calls } = fixture((id, args) => id === 'engine.target.pick'
      ? new Promise(done => { resolve = done; }) : { entityId: args.entityId });
    const controller = new AbortController();
    const picking = broker.pickSceneEntity({ ...identity, x: 1, y: 1 }, { signal: controller.signal });
    await new Promise(done => setImmediate(done));
    if (transition === 'select') await broker.selectSceneEntity({ ...identity, entityId: 'tree-choice' });
    if (transition === 'clear') await broker.clearSceneSelection(identity);
    if (transition === 'abort') controller.abort();
    if (transition === 'replace') engine.preview = { ...engine.preview, target: { targetId: 'replacement', generation: 2 } };
    resolve({ entityId: 'late-pick' });
    await assert.rejects(picking);
    assert.equal(broker.snapshot().sceneSelection?.primary.entityId ?? null, transition === 'select' ? 'tree-choice' : null);
    assert.equal(calls.some(([id, args]) => id === 'engine.entity.highlight' && args.entityId === 'late-pick'), false);
  }
});

it('rejects a stale clear without clearing or highlighting the replacement target', async () => {
  const { broker, calls } = fixture((_id, args) => ({ entityId: args.entityId }));
  await broker.selectSceneEntity({ ...identity, entityId: 'cube' });
  const count = calls.length;
  await assert.rejects(broker.clearSceneSelection({ ...identity, targetGeneration: 0 }), /selection-stale/);
  assert.equal(calls.length, count);
  assert.equal(broker.snapshot().sceneSelection.primary.entityId, 'cube');
});

it('accepts the exact owner canvas outside the Dock but rejects hidden and sibling pages', () => {
  const canvas = { closest: () => null };
  const sibling = { closest: () => null };
  const surface = { contains: target => target === canvas };
  let hidden = 'false';
  const host = { closest: () => ({ getAttribute: () => hidden }) };
  assert.equal(isViewportWorkspaceInputEvent({ target: canvas }, { surface, host }), true);
  assert.equal(isViewportWorkspaceInputEvent({ target: sibling }, { surface, host }), false);
  hidden = 'true';
  assert.equal(isViewportWorkspaceInputEvent({ target: canvas }, { surface, host }), false);
});

it('owns canvas clicks, maps physical pixels, and cancels picks on detach', async () => {
  const listeners = new Map();
  const canvas = { width: 200, height: 100, closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }) };
  const surface = { contains: target => target === canvas, querySelector: () => canvas,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name) };
  const calls = [];
  const controller = new ViewWorkspaceInputController({ ...identity,
    api: { call: (...args) => { calls.push(args); return Promise.resolve(); },
      async getCamera() { return { version: 0 }; }, async beginCamera() { return {}; },
      async updateCamera() {}, async commitCamera() {}, async abortCamera() {} },
    shouldCapture: event => isViewportWorkspaceInputEvent(event, { surface }),
  });
  const detach = controller.attach(surface);
  const click = { target: canvas, button: 0, clientX: 35, clientY: 30 };
  listeners.get('click')({ ...click, altKey: true });
  listeners.get('click')({ ...click, defaultPrevented: true });
  listeners.get('click')({ ...click, button: 2 });
  listeners.get('pointerdown')({ ...click, altKey: true });
  listeners.get('pointerup')(click);
  await controller.finishPromise;
  listeners.get('click')(click);
  assert.equal(calls.length, 0, 'Releasing Alt before mouse-up must not turn navigation into a pick');
  listeners.get('pointerdown')(click);
  listeners.get('click')({ ...click, clientX: 55 });
  assert.equal(calls.length, 0, 'Dragging does not select');
  listeners.get('pointerdown')(click);
  listeners.get('pointermove')({ ...click, clientX: 55 });
  listeners.get('click')(click);
  assert.equal(calls.length, 0, 'Dragging back to the starting point does not select');
  listeners.get('pointerdown')({ ...click, defaultPrevented: true });
  listeners.get('click')(click);
  assert.equal(calls.length, 0);
  listeners.get('click')(click);
  assert.equal(calls[0][0], 'scene.pick');
  assert.equal(calls[0][1].x, 50);
  assert.equal(calls[0][1].y, 20);
  assert.equal(calls[0][1].targetId, identity.targetId);
  assert.equal(calls[0][1].targetGeneration, identity.targetGeneration);
  listeners.get('click')(click);
  assert.equal(calls[0][2].signal.aborted, true);
  listeners.get('wheel')({ ...click, deltaY: 1 });
  assert.equal(calls[1][2].signal.aborted, true, 'Wheel navigation cancels an outstanding pick');
  await controller.finishPromise;
  listeners.get('click')(click);
  detach();
  assert.equal(calls[2][2].signal.aborted, true);
  assert.equal(listeners.has('click'), false);
});

it('binds selection inside an isolated canvas realm and retires it on page changes', async () => {
  const { Context } = await import('@forgeax/engine-plugin');
  const { viewportInputPlugin } = await import('../packages/view-plugin-viewport/src/input.ts');
  const { VIEW_WORKSPACE_TAB_ID, VIEW_DISPLAY_TAB_ID } = await import('@forgeax/view-workspace-core/contract');
  const ctx = new Context();
  const listeners = new Map(); const calls = [];
  const canvas = { width: 200, height: 100, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }) };
  const surface = { contains: node => node === canvas, querySelector: () => canvas,
    addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  let publish;
  const state = { selectedTabId: VIEW_WORKSPACE_TAB_ID, preview: { target: identity } };
  ctx.provide('frontendPlatform', { window: {}, document: {} });
  ctx.provide('engineWorkspacePresentation', { createSurface: () => surface });
  ctx.provide('viewOperationClient', { subscribe: listener => { publish = listener; return () => { publish = undefined; }; }, getState: async () => state,
    call: (...args) => { calls.push(args); return Promise.resolve(); }, abortCamera: async () => {} });
  const fiber = ctx.plugin(viewportInputPlugin); await fiber.await(); await new Promise(resolve => setImmediate(resolve));
  listeners.get('click')({ target: canvas, button: 0, clientX: 25, clientY: 10 });
  assert.equal(calls[0][0], 'scene.pick'); assert.equal(calls[0][1].x, 50);
  publish({ ...state, selectedTabId: VIEW_DISPLAY_TAB_ID });
  assert.equal(listeners.has('click'), false); assert.equal(calls[0][2].signal.aborted, true);
  await fiber.dispose(); assert.equal(publish, undefined); await ctx.fiber.dispose();
});

it('samples mouse bursts once per render frame, preserving the complete delta', async () => {
  let frame; const updates = [];
  const controller = new ViewWorkspaceInputController({ ...identity,
    window: { requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame: () => { frame = undefined; } },
    api: { getCamera: async () => ({ version: 0 }), beginCamera: async () => ({}), updateCamera: async value => { updates.push(value.input); }, commitCamera: async () => ({}), abortCamera: async () => ({}) },
  });
  await controller.begin();
  for(let i=0;i<100;i++)controller.queueInput({ type:'pointer-move',mode:'look',movementX:1,movementY:2 });
  assert.equal(updates.length,0);assert.equal(controller.inputQueue.length,1);
  frame(); await controller.pending;
  assert.equal(updates.length,1);assert.ok(Math.abs(updates[0].yaw + .3)<1e-9);assert.ok(Math.abs(updates[0].pitch + .6)<1e-9);
  controller.queueInput({ type:'pointer-move',mode:'look',movementX:1,movementY:0 });
  await controller.finish();assert.equal(updates.length,2,'finish flushes the last unsent frame before commit');assert.equal(frame,undefined);
  await controller.dispose();
});

it('camera sampling borrows Engine target operations and leaves workspace selection on its API', async () => {
  const {createViewportInputApi}=await import('../packages/view-plugin-viewport/src/camera-client.ts');
  const {ViewWorkspaceClient}=await import('@forgeax/view-workspace-core/client');
  const remote=[],local=[];
  const api=new ViewWorkspaceClient({clientId:'input-test',transport:{request(_service,value){remote.push(value.operation);return Promise.resolve({});}}});
  const camera={target:identity,getCamera:()=>({version:0}),beginCameraInteraction:args=>{local.push(args);return {};},updateCameraDraft:args=>{local.push(args);return {};},commitCamera:args=>{local.push(args);return {};},abortCameraInteraction:()=>({})};
  const input=createViewportInputApi(api,{resolveTarget:()=>camera},identity);
  const controller=new ViewWorkspaceInputController({...identity,api:input});await controller.begin();
  controller.queueInput({type:'pointer-move',mode:'look',movementX:10,movementY:5});await controller.pending;await controller.finish();
  assert.equal(remote.length,0);assert.equal(local.length,3);assert.equal(local[1].input.type,'look');assert.ok(local.every(value=>value.clientId==='input-test:canvas'));
  await input.call('scene.pick',{...identity,x:10,y:20});assert.deepEqual(remote,['scene.pick']);await controller.dispose();
});
