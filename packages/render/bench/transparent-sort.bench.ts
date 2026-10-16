import { RenderQueue } from '@forgeax/engine-types';
import { bench, describe } from 'vitest';
import type { RenderResourceScope } from '../src/publication/resource-scope';
import type { CameraSnapshot } from '../src/render-contract';
import type { DispatchEntry, RenderableSnapshot } from '../src/render-system-extract';
import { TransparentSortCache } from '../src/systems/transparent-dispatch';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../src/systems/transparent-sort-config';

/**
 * Fresh (cache-miss) transparent sort over 10k sprite-shaped slots per mode:
 * the worst per-frame cost of `TransparentSortCache`, which the verified
 * reuse path only ever undercuts.
 */
const N_ENTITIES = 10_000;
const OPTS = { iterations: 100 } as const;

function workload() {
  let seed = 0xcafe2026;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    return seed / 2 ** 32;
  };
  const renderables: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  for (let i = 0; i < N_ENTITIES; i++) {
    const world = new Float32Array(16);
    world[0] = world[10] = world[15] = 1;
    world[5] = 0.5 + random() * 1.5;
    world[12] = random() * 100;
    world[13] = random() * 100;
    world[14] = random() * 100;
    renderables.push({
      transform: { world },
      material: { paramSnapshot: { pivotAndSize: [0.5, random(), 1, 1] } },
    } as unknown as RenderableSnapshot);
    dispatch.push({
      entityIndex: i,
      materialHandle: 1024 + (i % 256),
      renderableIndex: i,
      passIndex: 0,
      queue: RenderQueue.Transparent,
      layer: Math.floor(random() * 2001) - 1000,
      tags: {},
    } as unknown as DispatchEntry);
  }
  return { renderables, dispatch };
}

function scope(mode: number): RenderResourceScope {
  return {
    hasResource: () => true,
    getResource: () => ({ mode, yzAlpha: 1 }),
  } as unknown as RenderResourceScope;
}

describe('transparent-sort 10k entities', () => {
  const { renderables, dispatch } = workload();
  const camera = { position: new Float32Array([50, 50, -50]) } as unknown as CameraSnapshot;
  let sink = 0;
  for (const [name, mode] of [
    ['mode=0 layer-z (horizontal)', TRANSPARENT_SORT_MODE_LAYER_Z],
    ['mode=1 layer-y (JRPG)', TRANSPARENT_SORT_MODE_LAYER_Y],
    ["mode=2 layer-yz (isometric / Don't-Starve)", TRANSPARENT_SORT_MODE_LAYER_YZ],
    ['mode=3 distance (back-to-front squared-distance)', TRANSPARENT_SORT_MODE_DISTANCE],
  ] as const) {
    const world = scope(mode);
    bench(
      name,
      () => {
        const out = new TransparentSortCache().sort(dispatch, world, [camera], renderables);
        sink ^= (out[0]?.entityIndex ?? 0) | 0;
      },
      OPTS,
    );
  }
  void [() => sink];
});
