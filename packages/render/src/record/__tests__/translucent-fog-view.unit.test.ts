import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import {
  PLANAR_REFLECTION_UNIFORM_OFFSET,
  REFLECTION_PROBE_VIEW_SLOT_BASE,
  REFLECTION_PROBE_VIEW_SLOT_COUNT,
  translucentFogComposition,
  translucentViewOffset,
  VIEW_UNIFORM_BUFFER_SIZE,
  VIEW_UNIFORM_BYTES,
  VIEW_UNIFORM_SLOT_STRIDE,
  writeViewUbo,
} from '../view-ubo';

const add = (srcFactor: GPUBlendFactor, dstFactor: GPUBlendFactor): GPUBlendComponent => ({
  srcFactor,
  dstFactor,
  operation: 'add',
});
const blend = (color: GPUBlendComponent): GPUBlendState => ({ color, alpha: color });

function camera(): CameraSnapshot {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 0, 5),
    world,
    fov: Math.PI / 3,
    aspect: 1,
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

describe('translucent fog composition', () => {
  it('keeps local lights in the Cluster transport without changing the shared View payload', () => {
    const uploads: Float32Array[] = [];
    const queue = {
      writeBuffer: (_buffer: Buffer, _offset: number, data: Float32Array) => {
        uploads.push(data.slice());
        return { ok: true, value: undefined } as const;
      },
    } as unknown as RhiQueue;
    for (const count of [0, 1, 5]) {
      writeViewUbo(
        queue,
        {} as Buffer,
        camera(),
        {
          kind: 'directional',
          direction: vec3.create(0, -1, 0),
          color: vec3.create(1, 1, 1),
          intensity: 1,
          contactShadowLength: 0,
        } as never,
        {
          point: Array.from({ length: count }, () => ({
            position: vec3.create(1, 2, 3),
            color: vec3.create(4, 5, 6),
            invRangeSquared: 0.25,
            lightingChannels: 0x80000001,
          })),
          spot: [],
          rect: [],
        } as never,
        [],
        VIEW_UNIFORM_SLOT_STRIDE * 25,
      );
    }
    expect(uploads).toHaveLength(3);
    expect(uploads[0]?.byteLength).toBe(VIEW_UNIFORM_BYTES);
    expect(uploads[1]).toEqual(uploads[0]);
    expect(uploads[2]).toEqual(uploads[0]);
  });

  it('classifies the blend state a writer composes through', () => {
    expect(translucentFogComposition(undefined)).toBeUndefined();
    expect(translucentFogComposition(blend(add('src-alpha', 'one-minus-src-alpha')))).toBe(
      'straight',
    );
    expect(translucentFogComposition(blend(add('one', 'one-minus-src-alpha')))).toBe(
      'premultiplied',
    );
    expect(translucentFogComposition(blend(add('one', 'one')))).toBe('additive');
    expect(translucentFogComposition(blend(add('src-alpha', 'one')))).toBe('additive');
    // Modulate and min/max blends have no fog composition; they keep the unfogged slot.
    expect(translucentFogComposition(blend(add('dst', 'zero')))).toBeUndefined();
    expect(
      translucentFogComposition(blend({ srcFactor: 'one', dstFactor: 'one', operation: 'max' })),
    ).toBeUndefined();
  });

  it('places one aligned View copy per composition after the reflection probes', () => {
    const offsets = (['straight', 'premultiplied', 'additive'] as const).map(translucentViewOffset);
    expect(offsets[0]).toBe(
      VIEW_UNIFORM_SLOT_STRIDE *
        (REFLECTION_PROBE_VIEW_SLOT_BASE + REFLECTION_PROBE_VIEW_SLOT_COUNT),
    );
    expect(offsets.map((offset) => offset % 256)).toEqual([0, 0, 0]);
    expect(new Set(offsets).size).toBe(3);
    expect(Math.max(...offsets) + VIEW_UNIFORM_BYTES).toBeLessThanOrEqual(
      PLANAR_REFLECTION_UNIFORM_OFFSET,
    );
    expect(PLANAR_REFLECTION_UNIFORM_OFFSET + VIEW_UNIFORM_BYTES).toBeLessThanOrEqual(
      VIEW_UNIFORM_BUFFER_SIZE,
    );
  });

  it('writes the display View once per composition with only the slot lane changed', () => {
    const writes: { offset: number; floats: Float32Array }[] = [];
    const queue = {
      writeBuffer: (_buffer: Buffer, offset: number, data: Float32Array) => {
        writes.push({ offset, floats: data.slice() });
        return { ok: true, value: undefined } as const;
      },
    } as unknown as RhiQueue;
    const light = {
      kind: 'directional' as const,
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    } as never;
    const fog = {
      color: [0.5, 0.6, 0.7] as const,
      density: 0.2,
      heightFalloff: 0.1,
      maxOpacity: 0.9,
    };
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      light,
      { point: [], spot: [] } as never,
      [],
      undefined,
      undefined,
      undefined,
      fog,
    );
    const main = writes[0]?.floats ?? new Float32Array();
    expect(writes[0]?.offset).toBe(0);
    expect(Array.from(main.slice(284, 292))).toEqual(
      Array.from(new Float32Array([0.5, 0.6, 0.7, 0.2, 0.1, 0.9, 0, 0])),
    );
    for (const [index, composition] of (
      ['straight', 'premultiplied', 'additive'] as const
    ).entries()) {
      const copy = writes[index + 1];
      expect(copy?.offset).toBe(translucentViewOffset(composition));
      expect(copy?.floats[290]).toBe(index + 1);
      const expected = main.slice();
      expected[290] = index + 1;
      expect(copy?.floats).toEqual(expected);
    }

    writes.length = 0;
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      light,
      { point: [], spot: [] } as never,
      [],
      VIEW_UNIFORM_SLOT_STRIDE * 25,
    );
    // Auxiliary captures keep their own unfogged slot and never rewrite the display copies.
    expect(writes.map((write) => write.offset)).toEqual([VIEW_UNIFORM_SLOT_STRIDE * 25]);
  });
});
