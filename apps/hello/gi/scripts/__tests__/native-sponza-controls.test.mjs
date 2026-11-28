import assert from 'node:assert/strict';
import test from 'node:test';
import { quat, vec3 } from '@forgeax/engine-math';
import {
  advanceRoamCamera,
  consumeNativeWindowEvents,
  createRoamCamera,
  initialHardwareRayTracing,
  initialReflections,
  initialSkyEnvironment,
  roamCameraPose,
} from '../native-sponza-controls.mjs';

test('initial native hardware RT defaults on and accepts only the closed CLI request', () => {
  assert.equal(initialHardwareRayTracing(), true);
  assert.equal(initialHardwareRayTracing('on'), true);
  assert.equal(initialHardwareRayTracing('off'), false);
  for (const value of ['', 'false', 'true', 'OFF', '0', 'auto', null, 0])
    assert.throws(() => initialHardwareRayTracing(value), /must be on or off/);
});

test('initial reflections and sky environment accept only closed CLI values', () => {
  assert.equal(initialReflections(), true);
  assert.equal(initialReflections('on'), true);
  assert.equal(initialReflections('off'), false);
  assert.throws(() => initialReflections('yes'), /must be on or off/);
  assert.equal(initialSkyEnvironment(), 'legacy');
  assert.equal(initialSkyEnvironment('sun'), 'sun');
  assert.equal(initialSkyEnvironment('legacy'), 'legacy');
  assert.throws(() => initialSkyEnvironment('auto'), /must be sun or legacy/);
});

test('native key edges remain visible and focus loss clears held movement', () => {
  const held = new Set();
  const first = consumeNativeWindowEvents(held, [
    { kind: 'key-down', code: 'KeyW', repeat: false },
    { kind: 'key-down', code: 'Digit2', repeat: true },
  ]);
  assert.deepEqual(first.pressed, ['KeyW']);
  assert.deepEqual([...held], ['KeyW', 'Digit2']);

  const resumed = consumeNativeWindowEvents(held, [
    { kind: 'focus', focused: false },
    { kind: 'focus', focused: true },
  ]);
  assert.equal(resumed.focused, true);
  assert.equal(held.size, 0);
});

test('UI dispatch sees key, pointer and focus transitions in native order with current modifiers', () => {
  const held = new Set();
  const seen = [];
  consumeNativeWindowEvents(held, [
    { kind: 'key-down', code: 'ShiftLeft', repeat: false },
    { kind: 'key-down', code: 'Tab', repeat: false },
    { kind: 'pointer-down', button: 'left', x: 4, y: 5 },
    { kind: 'focus', focused: false },
    { kind: 'key-up', code: 'Tab', repeat: false },
  ], event => seen.push([event.kind, held.has('ShiftLeft')]));
  assert.deepEqual(seen, [['key-down', true], ['key-down', true], ['pointer-down', true],
    ['focus', false], ['key-up', false]]);
});

test('roaming follows camera heading, normalizes diagonals, and bounds stalled time', () => {
  const camera = createRoamCamera({
    origin: [0, 0, 0],
    target: [0, 0, 1],
    up: [0, 1, 0],
    verticalFov: 1,
  });
  const forward = advanceRoamCamera(camera, new Set(['KeyW']), 0.25);
  assert.ok(Math.abs(forward.origin[2] - 0.15) < 1e-12);

  const diagonal = advanceRoamCamera(camera, new Set(['KeyW', 'KeyD']), 1 / 60);
  assert.ok(Math.abs(Math.hypot(...diagonal.origin) - 0.05) < 1e-12);

  const turned = advanceRoamCamera(camera, new Set(['ArrowRight']), 1 / 60);
  assert.notEqual(turned.yaw, camera.yaw);
  const pose = roamCameraPose(turned);
  assert.ok(Math.abs(Math.hypot(
    pose.target[0] - pose.origin[0],
    pose.target[1] - pose.origin[1],
    pose.target[2] - pose.origin[2],
  ) - 1) < 1e-12);
});

test('strafe and arrow turns follow the Engine camera right basis', () => {
  const cameraFor = (target) => createRoamCamera({
    origin: [0, 0, 0],
    target,
    up: [0, 1, 0],
    verticalFov: 1,
  });
  const axesFor = (camera) => {
    const pose = roamCameraPose(camera);
    const orientation = quat.fromLookAt(quat.create(), pose.origin, pose.target, pose.up);
    return {
      forward: Array.from(quat.forward(vec3.create(), orientation)),
      right: Array.from(quat.right(vec3.create(), orientation)),
    };
  };
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const forwardCamera = cameraFor([0, 0, 1]);
  const forwardAxes = axesFor(forwardCamera);
  const strafeRight = advanceRoamCamera(forwardCamera, new Set(['KeyD']), 1 / 60);
  const strafeDelta = strafeRight.origin.map((value, index) => value - forwardCamera.origin[index]);
  assert.ok(dot(strafeDelta, forwardAxes.right) > 0, 'D must move along camera local +X');

  const turnRight = advanceRoamCamera(forwardCamera, new Set(['ArrowRight']), 1 / 60);
  const turnedAxes = axesFor(turnRight);
  assert.ok(dot(turnedAxes.forward, forwardAxes.right) > 0, 'ArrowRight must turn toward camera right');
  const turnLeft = advanceRoamCamera(forwardCamera, new Set(['ArrowLeft']), 1 / 60);
  assert.ok(dot(axesFor(turnLeft).forward, forwardAxes.right) < 0, 'ArrowLeft must turn toward camera left');

  const negativeXCamera = cameraFor([-1, 0, 0]);
  const negativeXAxes = axesFor(negativeXCamera);
  const negativeXStrafe = advanceRoamCamera(negativeXCamera, new Set(['KeyD']), 1 / 60);
  const negativeXDelta = negativeXStrafe.origin.map((value, index) => value - negativeXCamera.origin[index]);
  assert.ok(dot(negativeXDelta, negativeXAxes.right) > 0, 'D must retain camera-right handedness when facing -X');
});
