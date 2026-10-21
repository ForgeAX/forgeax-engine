import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import type { GpuDrivenCandidate } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_BATCH_STRIDE, GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { FrameListBase } from '../scene/frame-list';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';

it.each([
  { at: 2, thrown: false },
  { at: 7, thrown: false },
  { at: 8, thrown: false },
  { at: 2, thrown: true },
])('preserves held member roots and restores task bindings after write $at fails (thrown=$thrown)', async ({
  at,
  thrown,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const observed = observeGpuInputBytes(device);
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected write failure',
    hint: 'exercise shared-input and task partial writes',
  });
  try {
    f.update().unwrap();
    const root = observed.header().getUint32(48, true);
    const arena = observed.buffers().arena;
    const count = observed.header().getUint32(4, true);
    const before = observed.readMembers(root, arena, count);
    observed.injectFailure(at, thrown, failure);
    const result = f.update(f.changed);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the injected failure');
    expect(result.error).toBe(failure);
    expect(observed.readMembers(root, arena, count)).toEqual(before);
    observed.clearFailure();
    f.update(f.original).unwrap();
    expect(observed.members()).toEqual(before);
    expect(observed.header().getUint32(8, true)).toBe(f.original.batches.at(0)?.key.count);
    f.update(f.original).unwrap();
    expect(f.view.inspect().sharedInputUploadBytes).toBe(0);
  } finally {
    observed.close();
    f.close();
  }
});

it.each([
  'unchanged',
  'first',
  'middle',
  'last',
] as const)('bounds task-word comparisons and preserves actual member values for a %s raw edit', async (edit) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const observed = observeGpuInputBytes(device);
  const words = (f.original.batches.length * GPU_DRIVEN_BATCH_STRIDE) / 4;
  let reads = 0;
  try {
    f.update().unwrap();
    vi.stubGlobal(
      'Uint32Array',
      new Proxy(Uint32Array, {
        construct(target, args, newTarget) {
          const array = Reflect.construct(target, args, newTarget) as Uint32Array;
          if (args.length !== 3 || array.length !== words) return array;
          return new Proxy(array, {
            get(target, key) {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                reads++;
                if (Number(key) >= target.length)
                  throw new Error('Task comparison exceeds its word extent');
              }
              return Reflect.get(target, key, target);
            },
          });
        },
      }),
    );
    const changed = {
      ...f.original,
      batches: f.original.batches.map((batch) => ({
        ...batch,
        candidates: batch.candidates.map((candidate, index) => {
          const selected =
            edit === 'first'
              ? 0
              : edit === 'middle'
                ? Math.floor(batch.candidates.length / 2)
                : edit === 'last'
                  ? batch.candidates.length - 1
                  : -1;
          return {
            ...candidate,
            instanceOrdinal:
              index === selected ? 1 - candidate.instanceOrdinal : candidate.instanceOrdinal,
          };
        }),
      })),
    };
    f.update(changed).unwrap();
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(words * 4);
    vi.unstubAllGlobals();
    expect(observed.members().map((value) => value.instanceOrdinal)).toEqual(
      changed.batches[0]?.candidates.map((value) => value.instanceOrdinal),
    );
    f.update(f.original).unwrap();
    expect(observed.members().map((value) => value.instanceOrdinal)).toEqual(
      f.original.batches.at(0)?.candidates.map((value) => value.instanceOrdinal),
    );
    expect(f.view.inspect().sharedInputUploadBytes).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    observed.close();
    f.close();
  }
});

it('consumes native candidate numeric facts even when a frozen array has a custom iterator', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const first = f.original.batches.at(0);
  if (first === undefined) throw Error('Missing source batch');
  const candidates = first.candidates.map((candidate) => Object.freeze({ ...candidate }));
  Object.defineProperty(candidates, Symbol.iterator, {
    value: function* () {
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (candidate === undefined) throw Error('Missing numeric candidate');
        yield Object.freeze({ ...candidate, instanceOrdinal: 1 - candidate.instanceOrdinal });
      }
    },
  });
  Object.freeze(candidates);
  const plan = {
    ...f.original,
    revision: f.original.revision + 1,
    batches: f.original.batches.map((batch, index) =>
      index === 0 ? { ...batch, candidates } : batch,
    ),
  };
  const observed = observeGpuInputBytes(device);
  try {
    f.update(plan).unwrap();
    expect(observed.members().map((value) => value.instanceOrdinal)).toEqual(
      candidates.map((value) => value.instanceOrdinal),
    );
  } finally {
    observed.close();
    f.close();
  }
});

it('rejects a candidate stream ending before its declared candidate length', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const first = f.original.batches.at(0);
  if (first === undefined) throw Error('Missing source batch');
  const rows = [...first.candidates];
  const candidates = new (class extends FrameListBase<GpuDrivenCandidate> {
    readonly length = rows.length;
    at(index: number): GpuDrivenCandidate | undefined {
      return rows.at(index);
    }
    *[Symbol.iterator](): Generator<GpuDrivenCandidate> {
      if (rows[0] !== undefined) yield rows[0];
    }
  })();
  const plan = {
    ...f.original,
    revision: f.original.revision + 1,
    batches: f.original.batches.map((batch, index) =>
      index === 0 ? { ...batch, candidates } : batch,
    ),
  };
  try {
    expect(() => f.update(plan).unwrap()).toThrowError(/complete candidate stream/);
  } finally {
    f.close();
  }
});
