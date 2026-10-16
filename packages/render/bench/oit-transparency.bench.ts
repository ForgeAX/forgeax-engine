import { RenderQueue } from '@forgeax/engine-types';
import { bench, describe } from 'vitest';
import type { Transparency } from '../src/components/camera';
import { resolveTransparencyView } from '../src/oit/view';
import type { RenderResourceScope } from '../src/publication/resource-scope';
import type { CameraSnapshot } from '../src/render-contract';
import type { DispatchEntry, RenderableSnapshot } from '../src/render-system-extract';
import { TransparentSortCache } from '../src/systems/transparent-dispatch';

/**
 * CPU cost of the per-frame transparent work in both view modes: the existing
 * back-to-front dispatch sort (runs in both modes) plus view resolution and
 * per-draw OIT classification. GPU pass time is measured separately by
 * `oit/gpu-pass-timing-host.mjs`.
 */
export const OIT_BENCH_DRAW_COUNTS = [64, 1024, 4096] as const;

const STRAIGHT_OVER = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

/** Analytic added-target memory (bytes) of the WBOIT lane. */
export function oitTargetBytes(width: number, height: number, sampleCount: 1 | 4): number {
  const resolved = width * height * 10;
  return sampleCount === 1 ? resolved : resolved * 4 + resolved;
}

export function oitWorkload(count: number) {
  const rows: { renderableIndex: number; source: RenderableSnapshot }[] = [];
  const renderables: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  for (let i = 0; i < count; i++) {
    const world = new Float32Array(16);
    world[0] = 1;
    world[5] = 1;
    world[10] = 1;
    world[15] = 1;
    world[12] = ((i * 7919) % 97) / 10 - 5;
    world[14] = -((i * 104729) % 101) / 10;
    const material = { transparent: true, materialHandle: i + 1 };
    const source = {
      assetHandle: 1,
      transform: { world },
      material,
      materials: [material],
    } as unknown as RenderableSnapshot;
    renderables.push(source);
    rows.push({ renderableIndex: i, source });
    dispatch.push({
      entityIndex: i,
      materialHandle: i + 1,
      renderableIndex: i,
      passIndex: 0,
      queue: RenderQueue.Transparent,
      layer: 0,
      tags: { LightMode: 'Forward' },
      renderState: { blend: STRAIGHT_OVER },
      defines: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: i % 2 === 0 ? 'forgeax::default-unlit' : 'forgeax::default-standard-pbr',
      paramSnapshot: undefined,
    });
  }
  const cameras = [{ position: new Float32Array([0, 0, 5]) }] as unknown as CameraSnapshot[];
  const scope = { hasResource: () => false } as unknown as RenderResourceScope;
  return { rows, renderables, dispatch, cameras, scope };
}

export function transparentFrameWork(
  workload: ReturnType<typeof oitWorkload>,
  requested: Transparency,
): number {
  const ordered = new TransparentSortCache().sort(
    workload.dispatch,
    workload.scope,
    workload.cameras,
    workload.renderables,
  );
  const view = resolveTransparencyView({
    requested,
    rgba16floatRenderable: true,
    rows: workload.rows,
    dispatch: ordered,
  });
  return view.inspection.accumulatedDrawCount + view.inspection.sortedDrawCount;
}

describe('OIT transparent CPU record work (sort + view resolution)', () => {
  let sink = 0;
  for (const count of OIT_BENCH_DRAW_COUNTS) {
    const workload = oitWorkload(count);
    bench(`${count} transparent draws sorted`, () => {
      sink ^= transparentFrameWork(workload, 'sorted');
    });
    bench(`${count} transparent draws weighted-blended`, () => {
      sink ^= transparentFrameWork(workload, 'weighted-blended');
    });
    for (const requested of ['sorted', 'weighted-blended'] as const) {
      bench(`${count} view resolution only ${requested}`, () => {
        sink ^= resolveTransparencyView({
          requested,
          rgba16floatRenderable: true,
          rows: workload.rows,
          dispatch: workload.dispatch,
        }).inspection.sortedDrawCount;
      });
    }
  }
  bench.skip('__sink_keep_alive', () => {
    sink ^= oitTargetBytes(1920, 1080, 1);
  });
});
