import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { POINTS_LINES_VIEW_SLOT_STRIDE, writePointsLinesViewUbo } from '../../record/view-ubo';
import type { CameraSnapshot } from '../../render-contract';

function camera(): CameraSnapshot {
  return {
    position: vec3.create(0, 0, 3),
    world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1]),
    fov: Math.PI / 4,
    aspect: 16 / 9,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSoftKnee: 0.5,
    bloomScatter: 0.7,
    clearColor: [0, 0, 0, 1],
  };
}

describe('Points/Lines per-draw view slots', () => {
  it('writes distinct transforms and styles at distinct dynamic offsets', () => {
    const writes: Array<{ offset: number; payload: Float32Array }> = [];
    const queue = {
      writeBuffer: (_buffer: Buffer, offset: number, payload: Float32Array) => {
        writes.push({ offset, payload: new Float32Array(payload) });
        return ok(undefined);
      },
    } as unknown as RhiQueue;
    const buffer = {} as Buffer;
    const firstModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
    const secondModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1]);

    writePointsLinesViewUbo(
      queue,
      buffer,
      camera(),
      640,
      360,
      firstModel,
      { kind: 'points', sizePx: 16, shape: 'circle' },
      0,
    );
    writePointsLinesViewUbo(
      queue,
      buffer,
      camera(),
      640,
      360,
      secondModel,
      { kind: 'lines', width: 4, dashSize: 3, gapSize: 2, dashOffset: -1 },
      POINTS_LINES_VIEW_SLOT_STRIDE,
    );

    expect(writes.map(({ offset }) => offset)).toEqual([0, POINTS_LINES_VIEW_SLOT_STRIDE]);
    expect(writes[0]?.payload[28]).toBe(2);
    expect(writes[1]?.payload[28]).toBe(-2);
    expect(writes[0]?.payload.slice(36, 40)).toEqual(new Float32Array([16, 0, 1, 0]));
    expect(writes[1]?.payload.slice(40, 44)).toEqual(new Float32Array([3, 2, -1, 0]));
    expect(writes[1]?.payload.slice(36, 40)).toEqual(new Float32Array([4, 1, 0, 0]));

    writePointsLinesViewUbo(
      queue,
      buffer,
      camera(),
      640,
      360,
      undefined,
      { kind: 'lines', width: 0.25, widthUnits: 1, cap: 1 },
      POINTS_LINES_VIEW_SLOT_STRIDE * 2,
    );
    const world = writes[2]?.payload;
    // World width scale: the vertical focal factor 1 / tan(fov / 2) times half the height.
    expect(world?.[39]).toBeCloseTo(180 / Math.tan(Math.PI / 8), 3);
    expect(world?.[43]).toBe(1);
  });
});
