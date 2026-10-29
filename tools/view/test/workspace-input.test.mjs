import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isViewportWorkspaceInputEvent, ViewWorkspaceInputController } from '../packages/view-plugin-viewport/src/workspace-shell.ts';

it('limits material dolly steps without changing Scene defaults', async () => {
  const samples = [];
  const api = { async getCamera() { return { version: 1 }; }, async beginCamera() { return {}; },
    async updateCamera({ input }) { if (input) samples.push(input); }, async commitCamera() {}, async abortCamera() {} };
  for (const limit of [undefined, 0.25]) {
    const controller = new ViewWorkspaceInputController({ api, targetId: 'preview', bindings: 'orbit', dollyStepLimit: limit });
    await controller.begin();
    controller.queueInput({ type: 'wheel', mode: 'dolly', deltaY: -10000 });
    await controller.finish();
    assert.equal(samples.at(-1).amount, -(limit ?? 4));
  }
});

function camera(x = 0) {
  return { position: [x, 2, 6], target: [x, 1, 0], up: [0, 1, 0] };
}

describe('ViewWorkspaceInputController camera commit', () => {
  it('preserves the missing API client diagnostic', () => {
    assert.throws(() => new ViewWorkspaceInputController(), {
      name: 'TypeError', message: 'workspace input controller requires an API client',
    });
  });

  it('sends the begin-time version even when Engine omits baseVersion', async () => {
    const calls = [];
    const api = {
      async getCamera() {
        return { version: 4, camera: camera() };
      },
      async beginCamera(value) {
        calls.push(['begin', value.interactionId, value.baseVersion]);
        return { camera: camera(), version: 4 };
      },
      async updateCamera() {
        return {};
      },
      async commitCamera(value) {
        calls.push(['commit', value.interactionId, value.expectedVersion, value.operationId]);
      },
      async abortCamera() {
        calls.push('abort');
      },
    };
    let nextId = 0;
    const controller = new ViewWorkspaceInputController({
      api,
      targetId: 'target-1',
      interactionIdFactory: () => `id-${nextId++}`,
    });
    await controller.begin();
    await controller.finish();
    assert.deepEqual(calls, [
      ['begin', 'id-0', 4],
      ['commit', 'id-0', 4, 'id-1'],
    ]);
  });

  it('keeps commit expectedVersion when begin echoes interaction fields', async () => {
    const commits = [];
    const api = {
      async getCamera() {
        return { version: 0, camera: camera() };
      },
      async beginCamera(value) {
        return { interactionId: value.interactionId, baseVersion: 0, camera: camera() };
      },
      async updateCamera(value) {
        return { camera: camera(1), input: value.input };
      },
      async commitCamera(value) {
        commits.push(value);
      },
      async abortCamera() {},
    };
    const controller = new ViewWorkspaceInputController({
      api,
      targetId: 'target-1',
      interactionIdFactory: () => 'input-1',
    });
    await controller.begin();
    controller.queueInput({ type: 'pointer-move', movementX: 2, movementY: -1 });
    await controller.finish();
    assert.equal(commits.length, 1);
    assert.equal(commits[0].interactionId, 'input-1');
    assert.equal(commits[0].expectedVersion, 0);
    assert.equal(Object.hasOwn(commits[0], 'camera'), false, 'commit Engine draft, not a stale response pose');
  });
});

function eventTarget() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    getAttribute: key => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    fire(name, fields = {}) { listeners.get(name)?.({ preventDefault() {}, ...fields }); },
    focus() {},
  };
}

it('navigates with bare WASD, Shift boost, RMB combinations, and ends on focus loss', async () => {
  const samples = [];
  const commits = [];
  const element = eventTarget();
  const window = eventTarget();
  const document = eventTarget();
  const controller = new ViewWorkspaceInputController({
    targetId: 'target', window, document,
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera({ input }) { samples.push(input); },
      async commitCamera(value) { commits.push(value); },
      async abortCamera() { assert.fail('normal focus loss must not roll back camera'); },
    },
  });
  const detach = controller.attach(element);
  assert.equal(element.getAttribute('tabindex'), '0', 'Viewport must receive keyboard focus');

  // Bare WASD starts a camera transaction and commits once every key releases.
  element.fire('keydown', { key: 'w', code: 'KeyW' });
  assert.ok(controller.beginPromise, 'bare WASD starts a camera transaction');
  await controller.beginPromise;
  window.fire('keyup', { key: 'w', code: 'KeyW' });
  await controller.finishPromise;
  assert.equal(commits.length, 1, 'bare WASD commits once every navigation key releases');
  assert.deepEqual(samples.map(value => value.type), ['move', 'move']);
  assert.deepEqual(samples[0].velocity, [0, 0, -4]);
  assert.deepEqual(samples[1].velocity, [0, 0, 0], 'releasing W stops the motion');

  // Shift boosts while a navigation key is held, and releasing it restores speed.
  samples.length = 0;
  element.fire('keydown', { key: 'w', code: 'KeyW' });
  element.fire('keydown', { key: 'Shift', code: 'ShiftLeft' });
  await controller.beginPromise;
  await controller.pending;
  assert.deepEqual(samples.at(-1).velocity, [0, 0, -12], 'Shift triples navigation speed');
  window.fire('keyup', { key: 'Shift', code: 'ShiftLeft' });
  await controller.pending;
  assert.deepEqual(samples.at(-1).velocity, [0, 0, -4], 'releasing Shift restores base speed');
  window.fire('keyup', { key: 'w', code: 'KeyW' });
  await controller.finishPromise;

  // The RMB look gesture still flies with held combinations.
  samples.length = 0;
  const commitsBefore = commits.length;
  element.fire('pointerdown', { button: 2 });
  element.fire('keydown', { key: 'w', code: 'KeyW' });
  element.fire('keydown', { key: 'd', code: 'KeyD' });
  await controller.beginPromise;
  window.fire('keyup', { key: 'd', code: 'KeyD' });
  await controller.pending;
  assert.ok(controller.interaction);
  assert.equal(commits.length, commitsBefore);
  assert.deepEqual(samples.map(value => value.type), ['move', 'move', 'move']);
  assert.deepEqual(samples[0].velocity, [0, 0, -4]);
  assert.ok(samples[1].velocity[0] > 0 && samples[1].velocity[2] < 0);
  assert.deepEqual(samples[2].velocity, [0, 0, -4]);
  window.fire('blur');
  await controller.finishPromise;
  assert.equal(commits.length, commitsBefore + 1);
  assert.equal(controller.interaction, null);
  detach();
  assert.equal(element.getAttribute('tabindex'), null, 'Release the borrowed element attribute');
});

it('coalesces pointer samples behind one in-flight update without dropping displacement', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const samples = [];
  const controller = new ViewWorkspaceInputController({
    targetId: 'target',
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera({ input }) { samples.push(input); await barrier; },
      async commitCamera() {},
      async abortCamera() {},
    },
  });
  await controller.begin();
  controller.queueInput({ type: 'pointer-move', movementX: 1, movementY: 2 });
  await Promise.resolve();
  for (let index = 0; index < 1000; index++)
    controller.queueInput({ type: 'pointer-move', movementX: 1, movementY: 2 });
  assert.equal(controller.inputQueue.length, 1);
  release();
  await controller.finish();
  assert.equal(samples.length, 2);
  assert.ok(Math.abs(samples.reduce((sum, value) => sum + value.yaw, 0) + 1001 * 0.003) < 1e-10);
});

it('drains a cancelled update before admitting another gesture', async () => {
  let release;
  const samples = [];
  let count = 0;
  const controller = new ViewWorkspaceInputController({
    targetId: 'target', interactionIdFactory: () => `i-${++count}`,
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera({ input }) {
        samples.push(input.yaw);
        if (input.yaw === -0.003) await new Promise(done => { release = done; });
      },
      async commitCamera() {}, async abortCamera() {},
    },
  });
  await controller.begin();
  controller.queueInput({ type: 'pointer-move', movementX: 1 });
  await Promise.resolve();
  const cancelled = controller.abort();
  const begun = controller.begin();
  release();
  await cancelled;
  await begun;
  controller.queueInput({ type: 'pointer-move', movementX: 2 });
  await controller.finish();
  assert.deepEqual(samples, [-0.003, -0.006]);
});

function node(markers) {
  return {
    closest(selector) {
      return markers[selector] ?? selector.split(',').map(part => markers[part]).find(Boolean) ?? null;
    },
  };
}

describe('isViewportWorkspaceInputEvent', () => {
  it('preserves consumed input, editable fields and the Engine fatal banner', () => {
    const viewport = {
      '[data-forgeax-view-mount-host="viewport"]': {},
      '[data-forgeax-view-workspace="preview"]': {},
    };
    assert.equal(isViewportWorkspaceInputEvent({ target: node(viewport), defaultPrevented: true }), false);
    for (const selector of ['button', 'input', 'a', 'select', 'textarea', '[contenteditable="true"]', '.fx-engine-fatal-banner']) {
      assert.equal(isViewportWorkspaceInputEvent({ target: node({ ...viewport, [selector]: {} }) }), false, selector);
    }
  });

  it('accepts pointer events on the active Scene viewport canvas', () => {
    const preview = {};
    const viewport = {};
    const page = { getAttribute: () => 'false' };
    const target = node({
      'button,input,a,select,textarea,[contenteditable="true"]': null,
      '[data-forgeax-view-dock-page]': page,
      '[data-forgeax-view-mount-host="viewport"]': viewport,
      '[data-forgeax-view-workspace="preview"]': preview,
    });
    assert.equal(isViewportWorkspaceInputEvent({ target }), true);
  });

  it('rejects events from an inactive page or a sibling preview canvas', () => {
    const hiddenPage = { getAttribute: (name) => (name === 'aria-hidden' ? 'true' : null) };
    const hiddenTarget = node({
      'button,input,a,select,textarea,[contenteditable="true"]': null,
      '[data-forgeax-view-dock-page]': hiddenPage,
      '[data-forgeax-view-mount-host="viewport"]': {},
      '[data-forgeax-view-workspace="preview"]': {},
    });
    assert.equal(isViewportWorkspaceInputEvent({ target: hiddenTarget }), false);

    const previewTarget = node({
      'button,input,a,select,textarea,[contenteditable="true"]': null,
      '[data-forgeax-view-dock-page]': { getAttribute: () => 'false' },
      '[data-forgeax-view-mount-host="viewport"]': null,
      '[data-forgeax-view-workspace="preview"]': {},
    });
    assert.equal(isViewportWorkspaceInputEvent({ target: previewTarget }), false);
  });
});

it('suppresses only viewport context menus and retains wheel navigation until detached', async () => {
  const samples = [];
  const element = eventTarget();
  const target = node({
    '[data-forgeax-view-mount-host="viewport"]': {},
    '[data-forgeax-view-workspace="preview"]': {},
  });
  const controller = new ViewWorkspaceInputController({
    targetId: 'target', window: eventTarget(), document: eventTarget(),
    shouldCapture: isViewportWorkspaceInputEvent,
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera({ input }) { samples.push(input); },
      async commitCamera() {},
      async abortCamera() {},
    },
  });
  const detach = controller.attach(element);
  let prevented = 0;
  const preventDefault = () => { prevented++; };
  element.fire('contextmenu', { target, preventDefault });
  assert.equal(prevented, 1);
  element.fire('contextmenu', { target: node({}), preventDefault });
  assert.equal(prevented, 1, 'Sibling panels retain their context menus');
  element.fire('wheel', { target, deltaY: 100, preventDefault });
  await controller.finishPromise;
  assert.equal(prevented, 2);
  assert.ok(samples.some(input => input.type === 'dolly'));
  detach();
  element.fire('contextmenu', { target, preventDefault });
  element.fire('wheel', { target, deltaY: 100, preventDefault });
  assert.equal(prevented, 2, 'Detachment removes both listeners');
});

for (const earlyRelease of [false, true]) it(`keeps new input with its owner while the previous camera commits (early release=${earlyRelease})`, async () => {
  let releaseCommit;
  let commitStarted;
  const started = new Promise(resolve => { commitStarted = resolve; });
  const barrier = new Promise(resolve => { releaseCommit = resolve; });
  const samples = [];
  const commits = [];
  const errors = [];
  let nextId = 0;
  const element = eventTarget();
  const window = eventTarget();
  const controller = new ViewWorkspaceInputController({
    targetId: 'target', window, document: eventTarget(), onError: error => errors.push(error),
    interactionIdFactory: () => `id-${nextId++}`,
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera({ interactionId, input }) { samples.push({ interactionId, input }); },
      async commitCamera({ interactionId }) {
        commits.push(interactionId);
        if (commits.length === 1) { commitStarted(); await barrier; }
      },
      async abortCamera() { assert.fail('ordinary gesture retirement must commit'); },
    },
  });
  const detach = controller.attach(element);
  element.fire('keydown', { key: 'w', code: 'KeyW' });
  await controller.beginPromise;
  window.fire('keyup', { key: 'w', code: 'KeyW' });
  await started;
  const oldOwner = commits[0];
  const previousSamples = samples.length;
  element.fire('pointerdown', { button: 2 });
  element.fire('keydown', { key: 'w', code: 'KeyW' });
  element.fire('keydown', { key: 'd', code: 'KeyD' });
  window.fire('keyup', { key: 'd', code: 'KeyD' });
  if (earlyRelease) {
    window.fire('keyup', { key: 'w', code: 'KeyW' });
    window.fire('pointerup', { button: 2 });
  }
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(samples.length, previousSamples, 'new input cannot drain into a committing owner');
  releaseCommit();
  await controller.beginPromise;
  await controller.pending;
  if (!earlyRelease) {
    assert.deepEqual([...controller.held], ['KeyW']);
    assert.deepEqual(samples.at(-1).input.velocity, [0, 0, -4]);
    window.fire('keyup', { key: 'w', code: 'KeyW' });
    window.fire('pointerup', { button: 2 });
  }
  await controller.finishPromise;
  assert.equal(commits.length, 2);
  assert.ok(samples.slice(previousSamples).every(sample => sample.interactionId !== oldOwner));
  assert.deepEqual(samples.at(-1).input.velocity, [0, 0, 0]);
  assert.deepEqual([...controller.held], []);
  assert.deepEqual(controller.inputQueue, []);
  assert.equal(controller.interaction, null);
  assert.deepEqual(errors, []);
  detach();
});

it('retires unadmitted input when the preceding commit fails before a fresh gesture', async () => {
  let releaseCommit;
  let commitStarted;
  const started = new Promise(resolve => { commitStarted = resolve; });
  const barrier = new Promise(resolve => { releaseCommit = resolve; });
  const failure = new Error('commit failed');
  const samples = [];
  let nextId = 0;
  const controller = new ViewWorkspaceInputController({
    targetId: 'target', interactionIdFactory: () => `id-${nextId++}`,
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera(value) { samples.push(value); },
      async commitCamera() { commitStarted(); await barrier; throw failure; },
      async abortCamera() {},
    },
  });
  await controller.begin();
  const finishing = controller.finish();
  const observedFailure = assert.rejects(finishing, error => error === failure);
  await started;
  const waiting = controller.begin();
  const rejectedAdmission = assert.rejects(waiting, error => error === failure);
  controller.queueInput({ type: 'key-down', key: 'w', code: 'KeyW' });
  releaseCommit();
  await Promise.all([observedFailure, rejectedAdmission]);
  assert.deepEqual([...controller.held], []);
  assert.deepEqual(controller.inputQueue, []);
  assert.equal(controller.interaction, null);
  await controller.begin();
  await controller.pending;
  assert.deepEqual(samples, [], 'a fresh owner cannot replay the failed gesture');
  await controller.abort();
});

it('orbits a mesh preview with the left button and does not fly or pick', async () => {
  const samples = [];
  const calls = [];
  let locked = false;
  const element = eventTarget();
  element.dataset = {};
  element.requestPointerLock = () => {
    locked = true;
    return Promise.resolve();
  };
  const canvas = {
    width: 200,
    height: 100,
    tagName: 'CANVAS',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }),
  };
  element.tagName = 'DIV';
  element.querySelector = () => canvas;
  const focused = [];
  const controller = new ViewWorkspaceInputController({
    bindings: 'orbit',
    targetId: 'mesh-target',
    targetGeneration: 2,
    tabId: 'tab',
    onFocusSelection: () => focused.push('f'),
    api: {
      async getCamera() { return { version: 0 }; },
      async beginCamera() { return {}; },
      async updateCamera({ input }) { samples.push(input); },
      async commitCamera() {},
      async abortCamera() {},
      call(...args) { calls.push(args); return Promise.resolve(); },
    },
  });
  const detach = controller.attach(element);

  element.fire('pointerdown', { button: 0, clientX: 10, clientY: 20 });
  await controller.beginPromise;
  element.fire('pointermove', { movementX: 4, movementY: -2, clientX: 14, clientY: 18 });
  await controller.pending;
  assert.equal(samples.at(-1).type, 'orbit');
  assert.equal(samples.at(-1).yaw, -0.04);
  assert.equal(samples.at(-1).pitch, 0.02);
  assert.equal(samples.at(-1).pitchLimit, 1.35);
  assert.equal(locked, false);
  assert.equal(element.dataset.dragging, 'true');
  element.fire('pointerup', { button: 0 });
  await controller.finishPromise;
  assert.equal(element.dataset.dragging, undefined);

  element.fire('pointerdown', { button: 0, clientX: 8, clientY: 8 });
  await controller.beginPromise;
  element.fire('pointermove', { clientX: 11, clientY: 6 });
  await controller.pending;
  assert.equal(samples.at(-1).type, 'orbit');
  assert.equal(samples.at(-1).yaw, -0.03);
  assert.equal(samples.at(-1).pitch, 0.02);
  element.fire('pointerup', { button: 0 });
  await controller.finishPromise;

  element.fire('wheel', { deltaY: 100, deltaMode: 0 });
  await controller.finishPromise;
  assert.equal(samples.at(-1).type, 'dolly');

  element.fire('pointerdown', { button: 1, clientX: 0, clientY: 0 });
  await controller.beginPromise;
  element.fire('pointermove', { movementX: 3, movementY: 1, clientX: 3, clientY: 1 });
  await controller.pending;
  assert.equal(samples.at(-1).type, 'pan');
  element.fire('pointerup', { button: 1 });
  await controller.finishPromise;

  element.fire('pointerdown', { button: 2, clientX: 0, clientY: 0 });
  await controller.beginPromise;
  element.fire('pointermove', { movementY: 4, clientX: 0, clientY: 4 });
  await controller.pending;
  assert.equal(samples.at(-1).type, 'dolly');
  element.fire('pointerup', { button: 2 });
  await controller.finishPromise;

  element.fire('keydown', { key: 'w', code: 'KeyW' });
  assert.equal(controller.beginPromise, null);
  element.fire('keydown', { key: 'f', code: 'KeyF' });
  await Promise.resolve();
  assert.deepEqual(focused, ['f']);

  element.fire('click', { button: 0, target: canvas, clientX: 10, clientY: 10 });
  assert.equal(calls.length, 0);
  detach();
});

it('pulls a large near plane in after a dolly without changing the motion sample', async () => {
  const updates = [];
  const controller = new ViewWorkspaceInputController({
    targetId: 'mesh',
    api: {
      async getCamera() {
        return {
          version: 1,
          camera: {
            pivot: [0, 0, 0],
            transform: { pos: [0, 20, 60] },
            lens: { projection: 'perspective', near: 40, far: 400 },
          },
        };
      },
      async beginCamera() { return {}; },
      async updateCamera(value) { updates.push(value); },
      async commitCamera() {},
      async abortCamera() {},
    },
  });
  await controller.begin();
  controller.queueInput({ type: 'wheel', mode: 'dolly', deltaY: -100 });
  await controller.pending;
  const lensUpdate = updates.find((value) => value.camera?.lens);
  assert.ok(lensUpdate, 'navigation submits a closer near plane');
  assert.ok(lensUpdate.camera.lens.near < 1);
  assert.ok(lensUpdate.camera.lens.far >= 400);
  assert.equal(updates[0].input.type, 'dolly');
});
