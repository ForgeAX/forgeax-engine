import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { screenProbeReceiverWgsl } from '../../raytracing/screen-probe-receiver';
import {
  handoffReceiverDirection,
  handoffReceiverView,
  handoffWallInput,
} from './screen-probe-handoff-receiver.fixture';

it('keeps the original near wall first while leaving the separate receiver plane', () => {
  for (const side of [-1, 1]) {
    const direction = handoffReceiverDirection(side, false);
    const dx = direction[0] ?? NaN;
    const dz = direction[2] ?? NaN;
    const distance = (side * 0.02 - side * 0.5) / dx;
    expect(Math.hypot(...direction)).toBeCloseTo(1, 6);
    expect(distance).toBeGreaterThan(0.48);
    expect(distance).toBeLessThan(1);
    expect(0.5 + distance * dz).toBeCloseTo(0.56, 6);
    // All receiver vertices lie at z=.5: positive dz leaves it at t=0 only.
    expect(dz).toBeGreaterThan(0);
    expect(handoffReceiverDirection(side, true)).toEqual([-side, 0, 0]);
  }
});

it('projects each receiver onto its actual pixel center while the thin wall misses centers', () => {
  for (const side of [-1, 1]) {
    const vp = handoffReceiverView(side);
    const receiverX = (vp[0] ?? NaN) * side * 0.5 + (vp[12] ?? NaN);
    expect((receiverX + 1) * 4 - 0.5).toBe(side < 0 ? 0 : 7);
    expect((1 - (vp[13] ?? NaN)) * 2 - 0.5).toBe(0);
    const wallCenter = ((vp[12] ?? NaN) + 1) * 4;
    expect(wallCenter % 1).toBe(0);
    expect(0.04 * (vp[0] ?? NaN) * 4).toBeLessThan(1);
  }
});

it('publishes both canonical primitives and masks only the original wall in the no-wall control', async () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const input = await handoffWallInput(identity);
  expect(input.receiverField.policy.kind).toBe('sampled-visibility');
  expect(Array.from(input.receiverField.surface.positions)).toEqual([
    -4, -3, 0.5, 4, -3, 0.5, 0, 5, 0.5,
  ]);
  for (const scene of Object.values(input.scenes)) {
    expect(scene.expected.slice(0, 3)).toEqual([
      scene.instances.byteLength / 4,
      scene.fields.byteLength / 4,
      2,
    ]);
    const words = new Uint32Array(
      scene.instances.buffer,
      scene.instances.byteOffset,
      scene.instances.byteLength / 4,
    );
    expect(words[36 + 19]).toBe(255);
  }
  const wall = new Uint32Array(input.scenes.wall.instances.buffer);
  const empty = new Uint32Array(input.scenes['no-wall'].instances.buffer);
  expect(wall[19]).toBe(255);
  expect(empty[19]).toBe(0);
});

it('reflects the real receiver producer and the complete World consumer with canonical inputs', async () => {
  const prepare = (
    await compileShader(screenProbeReceiverWgsl(), {
      id: 'handoff-actual-receiver',
      computeEntry: 'prepareScreenReceivers',
    })
  ).unwrap();
  const active = (program: typeof prepare) =>
    program.reflection.boundGlobals
      .filter((row) => row.group === 0 && (row.visibility & 4) !== 0)
      .map((row) => row.binding)
      .sort((a, b) => a - b);
  expect(active(prepare)).toEqual([1, 2, 3, 6, 9, 17, 18, 19]);
  const world = (
    await compileShader(screenProbeWorldWgsl('global-sdf'), {
      id: 'handoff-actual-world',
      computeEntry: 'traceWorldProbes',
    })
  ).unwrap();
  // World consumes the already prepared canonical enclosure. Only the producer
  // reads View; selected-entry reflection must not bind that unused uniform.
  expect(active(world)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18]);
});
