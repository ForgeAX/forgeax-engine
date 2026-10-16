import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureGpuBufferRef } from '../features/prepared-gpu-work';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { validateRenderFeatureGraphicsPass } from '../features/prepared-graphics';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from '../features/prepared-graphics-store';

const attachments = [{ resource: 'color', format: 'rgba8unorm' as const }];
function resources(transaction: PreparedGraphicsTransaction, suffix = '') {
  return {
    pipeline: transaction.prepare('pipeline', `p${suffix}`, { signature: `p${suffix}` }).unwrap(),
    bindings: transaction.prepare('bindings', `b${suffix}`, { signature: `b${suffix}` }).unwrap(),
    vertex: transaction.prepare('vertex-data', `v${suffix}`, { signature: `v${suffix}` }).unwrap(),
    index: transaction.prepare('index-data', `i${suffix}`, { signature: `i${suffix}` }).unwrap(),
  };
}
function pass(refs: ReturnType<typeof resources>): RenderFeatureGraphicsPassDescriptor {
  return {
    attachments: {
      colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
    },
    draws: [
      {
        kind: 'draw',
        pipeline: refs.pipeline,
        bindings: [refs.bindings],
        vertexData: [{ slot: 0, resource: refs.vertex }],
        command: { vertexCount: 3, instanceCount: 1 },
      },
    ],
  };
}
function failure(
  result:
    | ReturnType<typeof validateRenderFeatureGraphicsPass>
    | ReturnType<PreparedGraphicsTransaction['validateGraphicsPass']>,
) {
  if (result.ok) throw new Error('Expected admission failure');
  return {
    code: result.error.code,
    detail: 'detail' in result.error ? result.error.detail : undefined,
  };
}
function owner(
  transaction: PreparedGraphicsTransaction,
  descriptor: RenderFeatureGraphicsPassDescriptor,
) {
  return transaction.validateGraphicsPass(descriptor, true, attachments);
}

describe('prepared graphics transaction admission', () => {
  it('reuses only kind projections while keeping each view attachment state separate', () => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
    const refs = resources(tx);
    const first = tx.graphicsState(true, attachments);
    const otherAttachments = [{ resource: 'other', format: 'rgba16float' as const }];
    const second = tx.graphicsState(false, otherAttachments);
    expect(second).not.toBe(first);
    for (const kind of ['pipelines', 'bindings', 'vertexData', 'indexData'] as const)
      expect(second[kind]).toBe(first[kind]);
    expect(second.attachments).toBe(otherAttachments);
    expect(second.capabilityAvailable).toBe(false);
    expect(first.pipeline).toBe(refs.pipeline);
    expect(owner(tx, pass(refs)).ok).toBe(true);
    expect(tx.validateGraphicsPass(pass(refs), true, otherAttachments).ok).toBe(false);
  });

  it('invalidates for new resources, first committed touches, retain closure and abort, without rewriting prior states', () => {
    const store = createPreparedGraphicsStore();
    const seed = store.beginFrame('feature', 1);
    const old = resources(seed);
    seed.commit().unwrap();
    const tx = store.beginFrame('feature', 1);
    const empty = tx.graphicsState(true, attachments);
    tx.retainResources((name) => name === 'p');
    const touched = tx.graphicsState(true, attachments);
    expect(touched.pipelines).toEqual([old.pipeline]);
    expect(empty.pipelines).toEqual([]);
    const overlay = resources(tx, 'new');
    const expanded = tx.graphicsState(true, attachments);
    expect(expanded.pipelines).toEqual([old.pipeline, overlay.pipeline]);
    expect(touched.pipelines).toEqual([old.pipeline]);
    expect(tx.prepare('pipeline', 'pnew', { signature: 'pnew' }).unwrap()).toBe(overlay.pipeline);
    expect(tx.graphicsState(true, attachments).pipelines).toBe(expanded.pipelines);
    tx.abort();
    expect(Reflect.get(tx, 'projection')).toBeUndefined();
    const aborted = tx.graphicsState(true, attachments);
    expect(aborted.pipelines).toEqual([old.pipeline]);
    expect(expanded.pipelines).toEqual([old.pipeline, overlay.pipeline]);
    expect(tx.graphicsState(true, attachments).pipelines).toBe(aborted.pipelines);
  });

  it('keeps touched order, same-name old/overlay references and held owners through later publication/generation', () => {
    const store = createPreparedGraphicsStore();
    const seed = store.beginFrame('feature', 1);
    const first = resources(seed);
    const last = resources(seed, 'last');
    seed.commit().unwrap();
    const tx = store.beginFrame('feature', 1);
    tx.prepare('pipeline', 'plast', { signature: 'plast' }).unwrap();
    const replacement = tx.prepare('pipeline', 'p', { signature: 'changed' }).unwrap();
    tx.prepare('pipeline', 'p', { signature: 'p' }).unwrap();
    const state = tx.graphicsState(true, attachments);
    expect(state.pipelines).toEqual([last.pipeline, first.pipeline, replacement]);
    expect(state.pipeline).toBe(last.pipeline);
    tx.commit().unwrap();
    expect(tx.graphicsState(true, attachments).pipelines).toBe(state.pipelines);
    store.beginFrame('feature', 1).commit().unwrap();
    store.invalidate('feature', 2);
    expect(tx.graphicsState(true, attachments).pipelines).toBe(state.pipelines);
    const next = store.beginFrame('feature', 2);
    expect(next.graphicsState(true, attachments).pipelines).toEqual([]);
    expect(next.lookup(first.pipeline)).toBeUndefined();
  });

  it.each([
    'draw',
    'draw-indexed',
    'draw-indirect',
    'draw-indexed-indirect',
  ] as const)('preserves %s descriptor validation and independent stale/foreign refs', (kind) => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 2);
    const refs = resources(tx);
    const original = pass(refs);
    const base = original.draws[0];
    if (!base) throw new Error('Missing draw');
    const indexed = kind.includes('indexed');
    const indirect = kind.includes('indirect');
    const descriptor = {
      ...original,
      draws: [
        {
          ...base,
          kind,
          ...(indexed ? { indexData: { resource: refs.index, format: 'uint16' as const } } : {}),
          command: indirect
            ? { buffer: { name: 'args', generation: 2 }, byteOffset: 0 }
            : indexed
              ? { indexCount: 3, instanceCount: 1 }
              : base.command,
        },
      ],
    } as RenderFeatureGraphicsPassDescriptor;
    const legacy = validateRenderFeatureGraphicsPass(
      'feature',
      descriptor,
      tx.graphicsState(true, attachments),
    );
    expect(legacy.ok).toBe(true);
    expect(owner(tx, descriptor).ok).toBe(true);
    const bad = {
      ...descriptor,
      draws: descriptor.draws.map((draw) => ({ ...draw, pipeline: { ...refs.pipeline } })),
    };
    expect(failure(owner(tx, bad))).toEqual(
      failure(
        validateRenderFeatureGraphicsPass('feature', bad, tx.graphicsState(true, attachments)),
      ),
    );
    expect(failure(owner(tx, bad)).code).toBe('render-feature-prepared-state-mismatch');
  });

  it.each([
    'new-overlay',
    'new-touched',
    'abort',
    'abort-and-retain',
  ] as const)('preserves captured membership when a descriptor getter changes %s during validation', (action) => {
    const run = (optimized: boolean) => {
      const store = createPreparedGraphicsStore();
      const seed = store.beginFrame('feature', 1);
      const committed = resources(seed, 'committed');
      seed.commit().unwrap();
      const tx = store.beginFrame('feature', 1);
      const refs = resources(tx);
      const descriptor = pass(refs);
      const draw = descriptor.draws[0];
      if (!draw) throw new Error('Missing draw');
      let reads = 0;
      const draws = [] as (typeof descriptor.draws)[number][];
      Object.defineProperty(draws, 0, {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1;
          if (reads === 1) {
            if (action === 'new-overlay') {
              const newBinding = tx.prepare('bindings', 'late', { signature: 'late' }).unwrap();
              return { ...draw, bindings: [newBinding] };
            }
            if (action === 'new-touched') {
              tx.retainResources((name) => name === 'bcommitted');
              return { ...draw, bindings: [committed.bindings] };
            }
            tx.abort();
            if (action === 'abort-and-retain') tx.retainResources(() => true);
          }
          if (action === 'new-overlay')
            return {
              ...draw,
              bindings: [
                tx.overlayItems().find((item) => item.name === 'late')
                  ?.reference as RenderFeaturePreparedRef<'bindings'>,
              ],
            };
          if (action === 'new-touched') return { ...draw, bindings: [committed.bindings] };
          return draw;
        },
      });
      const changed = { ...descriptor, draws };
      const state = tx.graphicsState(true, attachments);
      const result = optimized
        ? owner(tx, changed)
        : validateRenderFeatureGraphicsPass('feature', changed, state);
      return { ok: result.ok, failure: result.ok ? undefined : failure(result), reads };
    };
    const expected = run(false);
    const actual = run(true);
    expect(actual).toEqual(expected);
    expect(actual.ok).toBe(action === 'abort' || action === 'abort-and-retain');
  });

  it.each([
    16, 128, 512,
  ])('eliminates repeated full reference-list admission scans for %i prepared sets', (width) => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
    let last: ReturnType<typeof resources> | undefined;
    for (let i = 0; i < width; i += 1) last = resources(tx, String(i));
    if (!last) throw new Error('Missing refs');
    const descriptor = pass(last);
    const state = tx.graphicsState(true, attachments);
    const arrays = [state.pipelines, state.bindings, state.vertexData, state.indexData];
    const some = Array.prototype.some;
    let visits = 0;
    const spy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg,
    ) {
      return some.call(this, (value, index, array) => {
        if (arrays.includes(this as readonly RenderFeaturePreparedRef[])) visits += 1;
        return callback.call(thisArg, value, index, array);
      });
    });
    try {
      for (let i = 0; i < 8; i += 1)
        expect(validateRenderFeatureGraphicsPass('feature', descriptor, state).ok).toBe(true);
      const legacyVisits = visits;
      visits = 0;
      for (let i = 0; i < 8; i += 1) expect(owner(tx, descriptor).ok).toBe(true);
      expect(legacyVisits).toBeGreaterThanOrEqual(width * 8);
      expect(visits).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it.each([
    'pipeline',
    'bindings',
    'vertex-data',
    'index-data',
  ] as const)('preserves indirect-command ordering when rejecting a cloned %s', (kind) => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
    const refs = resources(tx);
    const original = pass(refs);
    const base = original.draws[0];
    if (!base) throw new Error('Missing draw');
    const draw = {
      ...base,
      kind: 'draw-indexed-indirect' as const,
      indexData: { resource: refs.index, format: 'uint16' as const },
      command: {
        buffer: Object.freeze({ name: 'args', generation: 1 }) as RenderFeatureGpuBufferRef,
        byteOffset: 0,
      },
    };
    if (kind === 'pipeline') draw.pipeline = { ...refs.pipeline };
    if (kind === 'bindings') draw.bindings = [{ ...refs.bindings }];
    if (kind === 'vertex-data') draw.vertexData = [{ slot: 0, resource: { ...refs.vertex } }];
    if (kind === 'index-data') draw.indexData = { resource: { ...refs.index }, format: 'uint16' };
    let commandReads = 0;
    const command = draw.command;
    Object.defineProperty(draw, 'command', {
      get: () => {
        commandReads += 1;
        return command;
      },
    });
    expect(failure(owner(tx, { ...original, draws: [draw] })).code).toBe(
      'render-feature-prepared-state-mismatch',
    );
    // Original indirect generation is checked before index-data membership.
    expect(commandReads).toBe(kind === 'index-data' ? 1 : 0);
  });

  it.each([
    false,
    true,
  ])('rejects missing prepared bindings before attachments (capability: %s)', (capability) => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
    const pipeline = tx.prepare('pipeline', 'p', { signature: 'p' }).unwrap();
    let reads = 0;
    const descriptor = {
      draws: [
        {
          kind: 'draw' as const,
          vertexLayout: 'none' as const,
          vertexData: [],
          pipeline,
          bindings: [],
          command: { vertexCount: 3, instanceCount: 1 },
        },
      ],
      get attachments(): RenderFeatureGraphicsPassDescriptor['attachments'] {
        reads += 1;
        throw new Error('Attachments must not be read');
      },
    };
    expect(failure(tx.validateGraphicsPass(descriptor, capability, attachments)).code).toBe(
      'render-feature-preparation-failed',
    );
    expect(reads).toBe(0);
  });

  it('falls back to the original generation getter read order for an adapted state', () => {
    const tx = createPreparedGraphicsStore().beginFrame('feature', 1);
    const refs = resources(tx);
    const descriptor = pass(refs);
    const state = tx.graphicsState(true, attachments);
    let reads = 0;
    Object.defineProperty(state, 'generation', {
      get: () => {
        reads += 1;
        return 1;
      },
    });
    tx.graphicsState = () => state;
    expect(owner(tx, descriptor).ok).toBe(true);
    expect(reads).toBe(7);
    reads = 0;
    expect(validateRenderFeatureGraphicsPass('feature', descriptor, state).ok).toBe(true);
    expect(reads).toBe(7);
  });

  it('rebuilds only after retained bindings touch their committed pipeline closure', () => {
    const store = createPreparedGraphicsStore();
    const seed = store.beginFrame('feature', 1);
    const pipeline = seed
      .prepare('pipeline', 'p', {
        shader: 'synthetic',
        vertexLayout: 'none',
        colorFormats: ['rgba8unorm'],
      })
      .unwrap();
    const binding = seed.prepare('bindings', 'b', { pipeline, values: {} }).unwrap();
    seed.commit().unwrap();
    const tx = store.beginFrame('feature', 1);
    const before = tx.graphicsState(true, attachments);
    tx.retainResources((name) => name === 'b');
    const after = tx.graphicsState(true, attachments);
    expect(before.pipelines).toEqual([]);
    expect(before.bindings).toEqual([]);
    expect(after.pipelines).toEqual([pipeline]);
    expect(after.bindings).toEqual([binding]);
    tx.retainResources((name) => name === 'b');
    expect(tx.graphicsState(true, attachments).pipelines).toBe(after.pipelines);
  });
});
