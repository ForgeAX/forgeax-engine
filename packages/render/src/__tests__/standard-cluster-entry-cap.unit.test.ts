import { mat4, vec3 } from '@forgeax/engine-math';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bin, clusterEntryCapK, createClusterBinScratch } from '../cluster-binner';
import {
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
} from '../pipeline/standard-lighting/layout';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { warnStandardClusterEntryCap } from '../record/cluster-local-lights';

/**
 * Index-list overflow keeps the first K entries of every cluster, K the
 * largest value whose sum of min(count, K) fits the list (water-filling).
 */

const near = 0.1;
const far = 100;
const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
const projection = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, near, far);
const grid = DEFAULT_CLUSTER_GRID;
const clusterCount = grid.x * grid.y * grid.z;

function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Half the lights cover the whole view; the rest are small and scattered. */
function mixedLights(count: number) {
  const next = sequence(count);
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? { position: vec3.create(0, 0, -5), range: Number.POSITIVE_INFINITY }
      : {
          position: vec3.create(next() * 40 - 20, next() * 20 - 10, -next() * 60),
          range: 2 + next() * 6,
        },
  );
}

function run(lights: ReturnType<typeof mixedLights>, capacity: number) {
  const clusterGrid = new Uint32Array(clusterCount * 2);
  const lightIndexList = new Uint32Array(capacity);
  const scratch = createClusterBinScratch();
  const written = bin(
    lights,
    view,
    projection,
    grid,
    near,
    far,
    clusterGrid,
    lightIndexList,
    capacity,
    scratch,
  ).unwrap();
  return {
    written,
    clusterGrid,
    lightIndexList,
    capK: scratch.clusterEntryCapK,
    dropped: scratch.droppedClusterEntries,
  };
}

function cell(output: ReturnType<typeof run>, cluster: number): number[] {
  const offset = output.clusterGrid[cluster * 2] ?? 0;
  const count = output.clusterGrid[cluster * 2 + 1] ?? 0;
  return Array.from(output.lightIndexList.subarray(offset, offset + count));
}

describe('Standard Cluster entry cap K', () => {
  it('solves the water-filling cap on uneven counts', () => {
    expect(clusterEntryCapK([1, 5, 10, 100], 4, 50)).toBe(34);
    expect(clusterEntryCapK([1, 5, 10, 100], 4, 49)).toBe(33);
    expect(clusterEntryCapK([7, 7, 7], 3, 20)).toBe(6);
    expect(clusterEntryCapK([7, 7, 7], 3, 0)).toBe(0);
  });

  it.each([
    256, 257, 1024, 1500,
  ])('keeps each cluster a prefix of its uncapped list for %i lights', (count) => {
    const lights = mixedLights(count);
    const capped = run(lights, LIGHT_INDEX_LIST_CAPACITY);
    const full = run(lights, count * clusterCount);
    expect(full.capK).toBeUndefined();
    expect(capped.written).toBeLessThanOrEqual(LIGHT_INDEX_LIST_CAPACITY);
    expect(capped.written + capped.dropped).toBe(full.written);
    if (full.written <= LIGHT_INDEX_LIST_CAPACITY) {
      // Within the list nothing changes.
      expect(capped.capK).toBeUndefined();
      expect(capped.dropped).toBe(0);
      expect(capped.clusterGrid).toEqual(full.clusterGrid);
      expect(capped.lightIndexList.subarray(0, capped.written)).toEqual(
        full.lightIndexList.subarray(0, full.written),
      );
      return;
    }
    const k = capped.capK as number;
    let atK = 0;
    let atNextK = 0;
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const uncapped = cell(full, cluster);
      expect(cell(capped, cluster)).toEqual(uncapped.slice(0, k));
      atK += Math.min(uncapped.length, k);
      atNextK += Math.min(uncapped.length, k + 1);
    }
    // K is the largest cap that fits.
    expect(atK).toBe(capped.written);
    expect(atNextK).toBeGreaterThan(LIGHT_INDEX_LIST_CAPACITY);
  });

  it('reports the expected caps for 256, 257, 1024 and 1500 mixed lights', () => {
    const caps = [256, 257, 1024, 1500].map(
      (count) => run(mixedLights(count), LIGHT_INDEX_LIST_CAPACITY).capK,
    );
    expect(caps[0]).toBeUndefined();
    expect(caps[1]).toBeUndefined();
    expect(caps[2]).toBeTypeOf('number');
    expect(caps[3]).toBeTypeOf('number');
    expect(caps[3] as number).toBeLessThanOrEqual(caps[2] as number);
  });

  it('caps 1024 view-covering lights at floor(capacity / clusters) = 303', () => {
    const lights = Array.from({ length: 1024 }, () => ({
      position: vec3.create(0, 0, -5),
      range: Number.POSITIVE_INFINITY,
    }));
    const output = run(lights, LIGHT_INDEX_LIST_CAPACITY);
    expect(output.capK).toBe(303);
    expect(output.written).toBe(303 * clusterCount);
    expect(output.dropped).toBe((1024 - 303) * clusterCount);
    expect(cell(output, clusterCount - 1)).toEqual(Array.from({ length: 303 }, (_, i) => i));
  });
});

describe('Standard Cluster entry cap warning', () => {
  afterEach(() => vi.restoreAllMocks());

  function overflowingFrame(count: number) {
    return {
      directional: undefined,
      local: Array.from({ length: count }, () => ({
        kind: 'point' as const,
        position: vec3.create(0, 0, -4),
        range: 1000,
        shadowed: false,
      })),
      view,
      projection,
      near,
      far,
      grid: { x: 32, y: 32, z: 33 },
      lightCount: 32 as const,
      renderPath: 'forward' as const,
    };
  }

  it('warns once per renderer and reports K and the dropped entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const frameState = { warnedStandardClusterEntryCap: false };
    const prepared = prepareStandardLighting(overflowingFrame(32)).unwrap();
    expect(prepared.clusterEntryCapK).toBe(31);
    warnStandardClusterEntryCap(frameState, prepared, LIGHT_INDEX_LIST_CAPACITY);
    warnStandardClusterEntryCap(frameState, prepared, LIGHT_INDEX_LIST_CAPACITY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('first 31 lights');
    expect(String(warn.mock.calls[0]?.[0])).toContain(`${prepared.droppedClusterEntries} entries`);
  });

  it('stays silent while the index list fits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const frameState = { warnedStandardClusterEntryCap: false };
    const prepared = prepareStandardLighting(overflowingFrame(30)).unwrap();
    expect(prepared.clusterEntryCapK).toBeUndefined();
    warnStandardClusterEntryCap(frameState, prepared, LIGHT_INDEX_LIST_CAPACITY);
    expect(warn).not.toHaveBeenCalled();
    expect(frameState.warnedStandardClusterEntryCap).toBe(false);
  });
});
