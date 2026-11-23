import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { packInstanceStorageBuffer } from '../mesh-ssbo';
import { interleaveSpriteInstanceBuffer } from '../sprite-instance-buffer';

it('writes complete storage and sprite payloads into exact nonzero-offset arena views', () => {
  const world = new World();
  const transforms = new Float32Array(32);
  transforms[12] = 10;
  transforms[28] = 20;
  const previous = new Float32Array(transforms);
  previous[12] = 1;
  previous[28] = 2;
  const currentIds = new Uint32Array([2, 1]);
  const oldIds = new Uint32Array([1, 2]);
  const regions = new Float32Array([0, 0, 1, 1, 0.25, 0.5, 0.5, 0.5]);
  const expected = packInstanceStorageBuffer(
    new Float32Array(Math.floor(transforms.length / 16) * 32),
    transforms,
    previous,
    currentIds,
    oldIds,
  );
  const sprite = interleaveSpriteInstanceBuffer(
    new Float32Array((transforms.length / 16) * 36),
    transforms,
    regions,
    true,
  );
  world
    .withFrameArena(() => {
      world.frameArena.alloc(Float32Array, 5).unwrap().fill(Number.NaN);
      const out = world.frameArena.alloc(Float32Array, 64).unwrap();
      out.fill(Number.NaN);
      expect(out.byteOffset).toBeGreaterThan(0);
      expect(packInstanceStorageBuffer(out, transforms, previous, currentIds, oldIds)).toBe(out);
      expect(out).toEqual(expected);
      const interleaved = world.frameArena.alloc(Float32Array, 72).unwrap();
      interleaved.fill(Number.NaN);
      expect(interleaveSpriteInstanceBuffer(interleaved, transforms, regions, true)).toBe(
        interleaved,
      );
      expect(interleaved).toEqual(sprite);
      return ok(undefined);
    })
    .unwrap();
  expect(expected[28]).toBe(2);
  expect(expected[60]).toBe(1);
  expect(transforms[12]).toBe(10);
  expect(previous[12]).toBe(1);
});

it('reads borrowed generation bytes on every submission across sparse reorder, duplicate, zero and replacement', () => {
  const current = new Float32Array(4 * 16);
  const previous = new Float32Array(current.length);
  for (let i = 0; i < 4; i++) {
    current[i * 16 + 12] = 10 + i;
    previous[i * 16 + 12] = i;
  }
  const generations = new Uint32Array([0xfffffffe, 17, 0xf0000000, 1]);
  const oldIds = new Uint32Array(generations);
  const out = new Float32Array(4 * 32);
  const readPrevious = () => {
    packInstanceStorageBuffer(out, current, previous, generations, oldIds);
    return Array.from({ length: 4 }, (_, i) => out[i * 32 + 28]);
  };
  expect(readPrevious()).toEqual([0, 1, 2, 3]);
  oldIds.reverse();
  expect(readPrevious()).toEqual([3, 2, 1, 0]);
  generations[1] = generations[0] as number;
  expect(readPrevious()).toEqual([10, 11, 12, 13]);
  generations[1] = 19;
  expect(readPrevious()).toEqual([3, 11, 1, 0]);
  oldIds[0] = 0;
  expect(readPrevious()).toEqual([10, 11, 12, 13]);
});
