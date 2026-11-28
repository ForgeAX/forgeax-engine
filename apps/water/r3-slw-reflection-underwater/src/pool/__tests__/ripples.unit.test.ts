import type { InputSnapshot } from '@forgeax/engine/input';
import { describe, expect, it } from 'vitest';
import { PoolControls } from '../controls';
import { PoolRipples } from '../ripples';

describe('pool heightfield', () => {
  it('starts and resets to still water, without injecting preset ripples', () => {
    const field = new PoolRipples(64);
    const controls = new PoolControls(field);
    controls.reset();
    for (let i = 0; i < 120; i++) {
      controls.step(1 / 120);
      field.step();
    }
    expect(field.height.every((height) => height === 0)).toBe(true);
    field.disturb(0, 0, 0.1, 0.01);
    expect(field.height.some((height) => height !== 0)).toBe(true);
    controls.gravity = true;
    controls.reset();
    for (let i = 0; i < 120; i++) {
      controls.step(1 / 120);
      field.step();
    }
    expect(field.height.every((height) => height === 0)).toBe(true);
    expect(controls.gravity).toBe(false);
  });
  it('admits a complete press/release click captured in one frozen input frame', () => {
    const field = new PoolRipples(64);
    const controls = new PoolControls(field);
    const input = {
      keyboard: { justPressedCode: () => false },
      pointerEvents: [],
      mouse: {
        position: { x: 500, y: 350 },
        wheelDelta: 0,
        justPressed: (button: number) => button === 0,
        button: () => false,
      },
    } as unknown as InputSnapshot;
    controls.update(input, 1000, 900);
    expect(field.height.some((height) => Math.abs(height) > 0.001)).toBe(true);
  });
  it('propagates a localized disturbance beyond its source footprint', () => {
    const field = new PoolRipples(64);
    field.disturb(0, 0, 0.1, 0.02);
    const outside = 32 * 64 + 40;
    expect(field.height[outside]).toBe(0);
    for (let step = 0; step < 25; step++) field.step();
    expect(Math.abs(field.height[outside] ?? 0)).toBeGreaterThan(0.00001);
  });

  it('keeps the reflecting solver finite and conserves mean water level', () => {
    const field = new PoolRipples(64);
    field.disturb(0.2, -0.3, 0.14, 0.02);
    field.disturb(-0.4, 0.1, 0.1, -0.01);
    const total = () => field.height.reduce((sum, height) => sum + height, 0);
    const initial = total();
    for (let step = 0; step < 1200; step++) field.step();
    expect(field.height.every(Number.isFinite)).toBe(true);
    expect(total()).toBeCloseTo(initial, 4);
    expect(field.height.reduce((m, h) => Math.max(m, Math.abs(h)), 0)).toBeLessThan(0.002);
  });

  it('publishes signed sub-micrometre heights and exact zero without quantization', () => {
    const field = new PoolRipples(16);
    field.height[10] = 0.0000001;
    field.height[11] = -0.0000001;
    const published = new DataView(
      field.bytes.buffer,
      field.bytes.byteOffset,
      field.bytes.byteLength,
    );
    expect(published.getFloat32(10 * 4, true)).toBe(field.height[10]);
    expect(published.getFloat32(11 * 4, true)).toBe(field.height[11]);
    field.reset();
    expect(field.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('resets both wave history and velocity without retaining old motion', () => {
    const field = new PoolRipples(32);
    field.disturb(0, 0, 0.2, 0.02);
    for (let step = 0; step < 10; step++) field.step();
    field.reset();
    for (let step = 0; step < 10; step++) field.step();
    expect(field.height.every((height) => height === 0)).toBe(true);
  });

  it('freezes gravity while paused and keeps the sphere inside the pool floor', () => {
    const controls = new PoolControls(new PoolRipples(32));
    controls.gravity = true;
    controls.paused = true;
    const original = [...controls.sphere];
    controls.step(1 / 120);
    expect(controls.sphere).toEqual(original);
    controls.paused = false;
    for (let step = 0; step < 600; step++) controls.step(1 / 120);
    expect(controls.sphere[1]).toBeGreaterThanOrEqual(-1 + controls.radius);
    expect(controls.sphere.every(Number.isFinite)).toBe(true);
  });
});
