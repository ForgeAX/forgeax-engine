import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { gpuDrivenDrawKey } from '../extract/gpu-driven';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { createDynamicGeometryFrameBindings } from '../record/dynamic-geometry-consumption';
import { worldEntityKey } from '../record/frame-snapshot';
import { emitGpuDrivenDrawReceipts } from '../record/gpu-draw-receipts';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';

async function fixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const material = defaultMaterialSnapshot(17);
  const source: RenderableSnapshot = {
    worldId: 0,
    entityKey: 42,
    assetHandle: 9,
    transform: { world: new Float32Array(16) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    gpuDrivenDraws: [2, 7].map((drawItemIndex) => ({
      drawItemIndex,
      kind: 'indexed',
      first: drawItemIndex * 3,
      count: 3,
      baseVertex: 0,
      topology: 'triangle-list',
      materialSlot: 0,
      pipelineClass: 'standard',
      materialResourceClass: '',
    })),
  };
  return { owner, source };
}

describe('validated GPU draw receipts', () => {
  it('uses one ownership lookup per draw and publishes the exact accepted submesh after submission', async () => {
    const { owner, source } = await fixture();
    try {
      const rows = [{ source }];
      const keys = new Set([gpuDrivenDrawKey(worldEntityKey(101, 42), 17, 7)]);
      const has = vi.spyOn(keys, 'has');
      const receipts = owner.recordCpuValidation(rows, keys, 'frame', [101]);
      expect(receipts).toBeDefined();
      expect(has).toHaveBeenCalledTimes(2);
      const draw = vi.fn();
      emitGpuDrivenDrawReceipts(rows, receipts, draw);
      expect(has).toHaveBeenCalledTimes(2);
      expect(draw).toHaveBeenCalledExactlyOnceWith(rows[0], 7, { lane: 'gpu', ready: true });
      expect(owner.inspect()).toMatchObject({ cpuFallbackDrawItems: 1, validatedGpuOwnedRows: 1 });
    } finally {
      owner.dispose();
    }
  });

  it('keeps raw per-draw reads while the immutable token uses one numeric entity projection', async () => {
    const { owner, source } = await fixture();
    try {
      let reads = 0;
      const observed = {
        ...source,
        get entityKey() {
          reads++;
          return 42;
        },
      };
      const keys = new Set([gpuDrivenDrawKey(worldEntityKey(0, 42), 17, 7)]);
      const raw = owner.recordCpuValidation([{ source: observed }], keys);
      expect(reads).toBe(2);
      reads = 0;
      const captured = owner.recordCpuValidation([{ source: observed }], keys, 'captured');
      expect(reads).toBe(1);
      expect(captured.submeshIndices).toEqual(raw.submeshIndices);
      expect(captured.ownedDraws.get(observed)).toEqual(raw.ownedDraws.get(observed));
    } finally {
      owner.dispose();
    }
  });

  it('preserves raw custom entry iteration and tuple destructuring order', async () => {
    const { owner, source } = await fixture();
    try {
      const draws = [...(source.gpuDrivenDraws ?? [])];
      const trace: string[] = [];
      const entries = function* () {
        for (let index = 0; index < draws.length; index++) {
          const pair = {
            *[Symbol.iterator]() {
              trace.push('index');
              yield index;
              trace.push('draw');
              yield draws[index];
            },
          };
          yield pair as unknown as [number, (typeof draws)[number]];
        }
        return undefined;
      };
      draws.entries = entries;
      owner.recordCpuValidation([{ source: { ...source, gpuDrivenDraws: draws } }], new Set());
      expect(trace).toEqual(['index', 'draw', 'index', 'draw']);
    } finally {
      owner.dispose();
    }
  });

  it('captures the raw next method once and closes it when a material read throws', async () => {
    const { owner, source } = await fixture();
    try {
      const draws = [...(source.gpuDrivenDraws ?? [])];
      const failure = new Error('raw material read');
      let nextReads = 0;
      let closed = 0;
      draws.entries = () => {
        let index = 0;
        const iterator = {
          get next() {
            nextReads++;
            return () =>
              index < draws.length
                ? { done: false, value: [index, draws[index++]] }
                : { done: true, value: undefined };
          },
          return() {
            closed++;
            return { done: true, value: undefined };
          },
          [Symbol.iterator]() {
            return this;
          },
        };
        return iterator as unknown as ReturnType<typeof draws.entries>;
      };
      const observed = {
        ...source,
        gpuDrivenDraws: draws,
        get materials(): typeof source.materials {
          throw failure;
        },
      };
      expect(() => owner.recordCpuValidation([{ source: observed }], new Set())).toThrow(failure);
      expect(nextReads).toBe(1);
      expect(closed).toBe(1);
      closed = 0;
      nextReads = 0;
      owner.recordCpuValidation([{ source: { ...source, gpuDrivenDraws: draws } }], new Set());
      expect(nextReads).toBe(1);
      expect(closed).toBe(0);
    } finally {
      owner.dispose();
    }
  });

  it('reuses accepted indices with current row wrappers and invalidates changed source, world and ownership identities', async () => {
    const { owner, source } = await fixture();
    try {
      const worlds = [101];
      const keys = new Set([gpuDrivenDrawKey(worldEntityKey(101, 42), 17, 7)]);
      const has = vi.spyOn(keys, 'has');
      const first = owner.recordCpuValidation([{ source }], keys, 'frame', worlds);
      const rows = [{ source, currentMesh: true }];
      const retained = owner.recordCpuValidation(rows, keys, 'frame', worlds);
      expect(retained).toBe(first);
      expect(has).toHaveBeenCalledTimes(2);
      const draw = vi.fn();
      emitGpuDrivenDrawReceipts(rows, retained, draw);
      expect(draw).toHaveBeenCalledExactlyOnceWith(rows[0], 7, { lane: 'gpu', ready: true });
      expect(owner.inspect()).toMatchObject({ cpuValidationScans: 1, cpuValidationCacheHits: 1 });

      const replaced = [
        { source: { ...source, gpuDrivenDraws: source.gpuDrivenDraws?.slice(0, 1) ?? [] } },
      ];
      const changed = owner.recordCpuValidation(replaced, keys, 'frame', worlds);
      draw.mockClear();
      emitGpuDrivenDrawReceipts(replaced, changed, draw);
      expect(draw).not.toHaveBeenCalled();
      const reordered = owner.recordCpuValidation(rows, keys, 'frame', [202]);
      emitGpuDrivenDrawReceipts(rows, reordered, draw);
      expect(draw).not.toHaveBeenCalled();
      const newClaims = new Set([gpuDrivenDrawKey(worldEntityKey(202, 42), 17, 2)]);
      const admitted = owner.recordCpuValidation(rows, newClaims, 'frame', [202]);
      emitGpuDrivenDrawReceipts(rows, admitted, draw);
      expect(draw).toHaveBeenCalledExactlyOnceWith(rows[0], 2, { lane: 'gpu', ready: true });
    } finally {
      owner.dispose();
    }
  });

  it('keeps pre-submit validation failure and callback failure separate from accepted statistics', async () => {
    const { owner, source } = await fixture();
    try {
      const rows = [{ source }];
      const keys = new Set(
        [2, 7].map((index) => gpuDrivenDrawKey(worldEntityKey(0, 42), 17, index)),
      );
      const receipts = owner.recordCpuValidation(rows, keys);
      const baseline = owner.inspect();
      const failure = new Error('receipt consumer failed');
      const draw = vi.fn(() => {
        throw failure;
      });
      expect(() => emitGpuDrivenDrawReceipts(rows, receipts, draw)).toThrow(failure);
      expect(draw).toHaveBeenCalledTimes(1);
      expect(owner.inspect()).toEqual(baseline);
      const readFailure = new Error('source unavailable before submission');
      const failedSource = {
        ...source,
        get materials(): typeof source.materials {
          throw readFailure;
        },
      };
      expect(() => owner.recordCpuValidation([{ source: failedSource }], keys)).toThrow(
        readFailure,
      );
      expect(draw).toHaveBeenCalledTimes(1);
    } finally {
      owner.dispose();
    }
  });

  it('observes mutable raw aliases on every call without a reuse token', async () => {
    const { owner, source } = await fixture();
    try {
      const rows = [{ source }];
      const worlds = [101];
      const keys = new Set([gpuDrivenDrawKey(worldEntityKey(101, 42), 17, 7)]);
      const first = owner.recordCpuValidation(rows, keys, undefined, worlds);
      Object.assign(source.material, { materialHandle: 18 });
      const replaced = owner.recordCpuValidation(rows, keys, undefined, worlds);
      expect(replaced.submeshIndices).toHaveLength(0);
      worlds[0] = 202;
      keys.clear();
      keys.add(gpuDrivenDrawKey(worldEntityKey(202, 42), 18, 2));
      const latest = owner.recordCpuValidation(rows, keys, undefined, worlds);
      expect(latest.submeshIndices).toEqual([2]);
      // The already validated frame keeps its accepted result across later inputs.
      expect(first.submeshIndices).toEqual([7]);
    } finally {
      owner.dispose();
    }
  });

  it('keeps rejected submissions unconsumed and successful retry receipts usable after a newer validation', async () => {
    const { owner, source } = await fixture();
    try {
      const world = new World();
      const bindings = createDynamicGeometryFrameBindings();
      const rows = [{ source }];
      const keys = new Set([gpuDrivenDrawKey(worldEntityKey(0, 42), 17, 7)]);
      const receipts = owner.recordCpuValidation(rows, keys, 'frame');
      bindings.begin();
      bindings.commit(false);
      expect(bindings.isConsumed(world, 42, 9)).toBe(false);
      expect(owner.inspect().cpuFallbackDrawItems).toBe(1);
      owner.recordCpuValidation([], new Set(), 'replacement');
      bindings.begin();
      const consume = bindings.onRenderableDraw([world]);
      emitGpuDrivenDrawReceipts(rows, receipts, (entry, _submesh, receipt) =>
        consume(entry, receipt.lane),
      );
      bindings.commit(true);
      expect(bindings.isConsumed(world, 42, 9)).toBe(true);
      expect(bindings.recordStageLane(world, 42, 9)).toBe('gpu');
    } finally {
      owner.dispose();
    }
  });
});
