import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceRoamCamera, commandForKey, consumeNativePointerEvents, createRoamCamera,
  exposureForControls, roamCameraPose } from '../native-sponza-controls.mjs';

function harness() {
  const calls = [];
  const state = {};
  const input = { pointer: event => calls.push(event), cancel: () => calls.push('cancel') };
  return { state, calls, run: (events, scale = 1) => consumeNativePointerEvents(state, events, input, scale) };
}

test('RMB drag rotates toward the cursor, even with zero elapsed simulation time', () => {
  const h = harness();
  const look = h.run([{ kind: 'pointer-down', button: 'right', x: 40, y: 40 },
    { kind: 'pointer-move', x: 80, y: 20 },
    { kind: 'pointer-up', button: 'right', x: 100, y: 10 }], 2);
  assert.deepEqual(look, { x: 30, y: -15 });
  const camera = createRoamCamera({ origin: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], verticalFov: 1 });
  const turned = advanceRoamCamera(camera, new Set(), 0, look);
  assert.ok(roamCameraPose(turned).target[0] > 0, 'cursor right must look camera-right while facing -Z');
  assert.ok(turned.pitch > 0, 'cursor up must look up');
  assert.deepEqual(turned.origin, camera.origin);
  assert.equal(h.state.anchor, undefined);
  assert.deepEqual(h.calls, ['cancel']);
});

test('left click reaches UI in logical pixels and unheld motion never rotates', () => {
  const h = harness();
  const look = h.run([{ kind: 'pointer-down', button: 'left', x: 80, y: 120 },
    { kind: 'pointer-up', button: 'left', x: 80, y: 120 },
    { kind: 'pointer-move', x: 120, y: 160 }], 2);
  assert.deepEqual(look, { x: 0, y: 0 });
  assert.deepEqual(h.calls.map(x => [x.phase, x.x, x.y]), [['down', 40, 60], ['up', 40, 60], ['move', 60, 80]]);
});

for (const cancel of [{ kind: 'focus', focused: false }, { kind: 'pointer-leave' },
  { kind: 'display' }, { kind: 'visibility', visible: false }, { kind: 'surface-lost' }]) {
  test(`${cancel.kind} cancels look and UI contacts; re-entry has no jump`, () => {
    const h = harness();
    h.run([{ kind: 'pointer-down', button: 'right', x: 0, y: 0 }, cancel]);
    assert.deepEqual(h.run([{ kind: 'pointer-move', x: 2000, y: 2000 }]), { x: 0, y: 0 });
    assert.equal(h.state.anchor, undefined);
    assert.ok(h.calls.includes('cancel'));
  });
}

test('invalid motion cannot poison the camera; pitch stays below the pole', () => {
  const h = harness();
  const look = h.run([{ kind: 'pointer-down', button: 'right', x: 0, y: 0 },
    { kind: 'pointer-move', x: NaN, y: Infinity }, { kind: 'pointer-move', x: 10, y: -10000 }]);
  assert.deepEqual(look, { x: 10, y: -10000 });
  const camera = createRoamCamera({ origin: [0, 0, 0], target: [0, 0, 1], up: [0, 1, 0], verticalFov: 1 });
  assert.equal(advanceRoamCamera(camera, new Set(), 1, look).pitch, 1.35);
});

test('GI keys select explicit modes; exposure uses bounded public Camera authoring', () => {
  assert.deepEqual(['Digit1', 'Digit2', 'Digit3'].map(commandForKey), ['off', 'irradiance-field', 'screen-probe']);
  assert.equal(commandForKey('KeyW'), undefined);
  assert.equal(commandForKey('KeyF'), 'toggle-exposure');
  assert.equal(commandForKey('KeyH'), 'toggle-hardware');
  assert.deepEqual(exposureForControls(true, 0), { kind: 'auto', fallback: 1, compensationEv: 0, rangeEv: [-4, 8], rates: [2, 1] });
  assert.deepEqual(exposureForControls(true, 0, true), {
    kind: 'auto', adaptation: 'ue-eye-adaptation', fallback: 1,
    compensationEv: 1, rangeEv: [-20, 10], rates: [3, 1],
  });
  assert.deepEqual(exposureForControls(false, 1), { kind: 'manual', multiplier: 2 });
  assert.equal(exposureForControls(true, 99).compensationEv, 8);
  assert.equal(exposureForControls(false, -99).multiplier, 1 / 256);
  assert.throws(() => exposureForControls(true, NaN), TypeError);
});
