import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attachMaterialRotation } from '../packages/view-plugin-material/src/preview-navigation.ts';
import { VIEW_WORKSPACE_OPERATION_EFFECTS } from '../packages/view-workspace-core/src/contract.ts';

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    fire(name, event = {}) { for (const listener of listeners.get(name) ?? []) listener(event); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  });
}

it('classifies material reads separately from ordered writes', () => {
  assert.equal(VIEW_WORKSPACE_OPERATION_EFFECTS['preview.material.get'], 'query');
  for (const action of ['set', 'rotate', 'reset']) assert.equal(VIEW_WORKSPACE_OPERATION_EFFECTS[`preview.material.${action}`], 'command');
});

it('coalesces left drag into exact-target object rotations, retires pending input and removes listeners', async () => {
  const frames = new Map();
  let id = 0, finish;
  const window = events({ requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(key) { frames.delete(key); } });
  const document = events({ defaultView: window });
  const element = events({ ownerDocument: document, focus() {}, contains: () => false, setPointerCapture() {}, hasPointerCapture: () => false });
  const signal = new AbortController();
  const calls = [], errors = [];
  const rotation = attachMaterialRotation({ element, target: { targetId: 'material-1', generation: 7 }, signal: signal.signal,
    client: { call(...args) { calls.push(args); return new Promise(resolve => { finish = resolve; }); } },
    shouldCapture: () => true, onError: error => errors.push(error) });
  const pointer = (x, y, button = 0) => ({ pointerId: 1, button, clientX: x, clientY: y, preventDefault() {} });
  element.fire('pointerdown', pointer(10, 20));
  element.fire('pointermove', pointer(13, 22));
  element.fire('pointermove', pointer(18, 24));
  assert.equal(frames.size, 1);
  for (const fn of frames.values()) fn(); frames.clear();
  assert.deepEqual(calls[0].slice(0, 2), ['preview.material.rotate', { targetId: 'material-1', targetGeneration: 7, yaw: -0.08, pitch: -0.04 }]);
  element.fire('pointermove', pointer(22, 30));
  assert.equal(frames.size, 0, 'only one rotation may be in flight');
  window.fire('blur');
  finish({}); await rotation.settle();
  assert.equal(calls.length, 1, 'blur drops unsubmitted displacement');
  element.fire('pointerdown', pointer(10, 20, 2));
  element.fire('pointermove', pointer(30, 40, 2));
  assert.equal(frames.size, 0, 'right drag belongs to the camera controller');
  element.fire('pointerdown', pointer(10, 20));
  element.fire('pointermove', pointer(30, 40));
  signal.abort();
  assert.equal(frames.size, 0);
  rotation.dispose();
  assert.equal(element.count() + window.count() + document.count(), 0);
  assert.deepEqual(errors, []);
});
