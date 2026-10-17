import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { describe, expect, it, vi } from 'vitest';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { validateRenderFeatureGraphicsPass } from '../features/prepared-graphics';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from '../features/prepared-graphics-store';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';

const attachments = [{ resource: 'color', format: 'rgba8unorm' as const }];

function resources(transaction: PreparedGraphicsTransaction, suffix = '') {
  return {
    pipeline: transaction.prepare('pipeline', `p${suffix}`, { signature: `p${suffix}` }).unwrap(),
    bindings: transaction.prepare('bindings', `b${suffix}`, { signature: `b${suffix}` }).unwrap(),
    vertex: transaction.prepare('vertex-data', `v${suffix}`, { signature: `v${suffix}` }).unwrap(),
    index: transaction.prepare('index-data', `i${suffix}`, { signature: `i${suffix}` }).unwrap(),
  };
}

function descriptor(refs: ReturnType<typeof resources>): RenderFeatureGraphicsPassDescriptor {
  return {
    attachments: {
      colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
    },
    draws: [
      {
        kind: 'draw',
        pipeline: refs.pipeline,
        bindings: [refs.bindings],
        vertexLayout: 'none',
        vertexData: [],
        command: { vertexCount: 3, instanceCount: 1 },
      },
    ],
  };
}

function graphAdmission(
  pass: RenderFeatureGraphicsPassDescriptor,
  state: RenderFeaturePreparedGraphicsState,
  shadow = false,
) {
  const graph = new RenderGraphBuilder();
  const texture = graph
    .createTexture('color', {
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: 0x0010,
    })
    .unwrap();
  const view = graph.view(texture).unwrap();
  const projection = new RenderFeatureRasterGraphProjection(graph, () => ({ texture, view }));
  const snapshot = { generation: 1, resolve: () => undefined };
  return shadow
    ? projection.prepareShadowDraws('draw', 'feature', 0, pass, state, snapshot)
    : projection.addPass('draw', 'feature', 0, pass, state, snapshot);
}

describe('prepared graphics graph snapshot authority', () => {
  it('reuses captured membership at ordinary and shadow graph admission without roster scans', () => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
    let last = resources(tx);
    for (let index = 1; index < 128; index += 1) last = resources(tx, String(index));
    const pass = descriptor(last);
    const state = tx.validateGraphicsPass(pass, true, attachments).unwrap();
    const columns = [state.pipelines, state.bindings, state.vertexData, state.indexData];
    const some = Array.prototype.some;
    let visits = 0;
    const spy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg,
    ) {
      return some.call(this, (value, index, array) => {
        if (columns.includes(this as readonly RenderFeaturePreparedRef[])) visits += 1;
        return callback.call(thisArg, value, index, array);
      });
    });
    try {
      expect(validateRenderFeatureGraphicsPass('feature', pass, state).ok).toBe(true);
      expect(visits).toBeGreaterThanOrEqual(128 * 4);
      visits = 0;
      expect(graphAdmission(pass, state).ok).toBe(true);
      expect(graphAdmission(pass, state, true).ok).toBe(true);
      expect(visits).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    'prepare',
    'abort-and-retain',
  ] as const)('keeps the captured roster when a draw getter changes the transaction through %s', (action) => {
    const run = (graph: boolean, useLate: boolean) => {
      const store = createPreparedGraphicsStore();
      const seed = store.beginFrame('feature', 1);
      const retained = resources(seed, 'retained');
      seed.commit().unwrap();
      const tx = store.beginFrame('feature', 1);
      const original = resources(tx);
      const pass = descriptor(original);
      const draw = pass.draws[0];
      if (!draw) throw new Error('Missing draw');
      const state = tx.graphicsState(true, attachments);
      let reads = 0;
      let late = retained.bindings;
      const draws: (typeof draw)[] = [];
      Object.defineProperty(draws, 0, {
        get: () => {
          reads += 1;
          if (reads === 1) {
            if (action === 'prepare')
              late = tx.prepare('bindings', 'late', { signature: 'late' }).unwrap();
            else {
              tx.abort();
              tx.retainResources(() => true);
            }
          }
          return useLate ? { ...draw, bindings: [late] } : draw;
        },
      });
      const changed = { ...pass, draws };
      const result = graph
        ? graphAdmission(changed, state)
        : validateRenderFeatureGraphicsPass('feature', changed, state);
      return { ok: result.ok, code: result.ok ? undefined : result.error.code };
    };
    for (const useLate of [false, true]) {
      expect(run(true, useLate)).toEqual(run(false, useLate));
      expect(run(true, useLate).ok).toBe(!useLate);
    }
  });

  it('does not authorize foreign, replaced-column or new-generation references', () => {
    const store = createPreparedGraphicsStore();
    const tx = store.beginFrame('feature', 1);
    const refs = resources(tx);
    const pass = descriptor(refs);
    const state = tx.graphicsState(true, attachments);
    const foreign = { ...refs.bindings };
    const draw = pass.draws[0];
    if (!draw) throw new Error('Missing draw');
    expect(graphAdmission({ ...pass, draws: [{ ...draw, bindings: [foreign] }] }, state).ok).toBe(
      false,
    );
    Object.defineProperty(state, 'bindings', { value: [] });
    expect(graphAdmission(pass, state).ok).toBe(false);
    tx.commit().unwrap();
    const recovered = store.beginFrame('feature', 2);
    const current = resources(recovered);
    const currentState = recovered.graphicsState(true, attachments);
    expect(graphAdmission(pass, currentState).ok).toBe(false);
    expect(graphAdmission(descriptor(current), currentState).ok).toBe(true);
  });

  it.each([
    'getter',
    'proxy',
    'throw',
  ] as const)('keeps raw state observation and errors for an adapted %s', (adaptation) => {
    const run = (graph: boolean) => {
      const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
      const pass = descriptor(resources(tx));
      const owned = tx.graphicsState(true, attachments);
      let reads = 0;
      const state =
        adaptation === 'proxy'
          ? new Proxy(owned, {
              get(target, key, receiver) {
                if (key === 'generation') reads += 1;
                return Reflect.get(target, key, receiver);
              },
            })
          : owned;
      if (adaptation !== 'proxy')
        Object.defineProperty(state, 'generation', {
          get: () => {
            reads += 1;
            if (adaptation === 'throw') throw new Error('generation failed');
            return 1;
          },
        });
      let ok = false;
      let thrown: unknown;
      try {
        const result = graph
          ? graphAdmission(pass, state)
          : validateRenderFeatureGraphicsPass('feature', pass, state);
        ok = result.ok;
      } catch (error) {
        thrown = error instanceof Error ? error.message : error;
      }
      return { ok, reads, thrown };
    };
    expect(run(true)).toEqual(run(false));
  });
});
