import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createDynamicGeometryLifecycle } from '../dynamic-geometry';
import type { DynamicGeometryLifecycleOptions } from '../index';

const MESH_BYTES = 36;
const DEFAULT_MESH_BYTES = 64 * 1024 * 1024;
const RETAINED_65: DynamicGeometryLifecycleOptions = { maxRetainedCandidates: 65 };

const mesh = (): MeshAsset => ({
  kind: 'mesh',
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  attributes: {},
  submeshes: [
    { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
  ],
  materialSlots: [{ slotName: 'default' }],
});

const prepare = (
  lifecycle: ReturnType<typeof createDynamicGeometryLifecycle>,
  world: object,
  entity: number,
  revision = 1,
) => lifecycle.prepare({ world, entity, mesh: mesh(), revision }, 1).unwrap();

const accept = (
  lifecycle: ReturnType<typeof createDynamicGeometryLifecycle>,
  world: object,
  entity: number,
  revision = 1,
) => lifecycle.accept(prepare(lifecycle, world, entity, revision)).unwrap();

describe('dynamic geometry retained capacity', () => {
  it('keeps the default 32 transient slots and the 64 MiB byte budget', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    try {
      expect(lifecycle.inspect().maxMeshBytes).toBe(DEFAULT_MESH_BYTES);
      for (let entity = 1; entity <= 32; entity += 1) prepare(lifecycle, world, entity);

      const beforeOverflow = lifecycle.inspect();
      expect(lifecycle.prepare({ world, entity: 33, mesh: mesh(), revision: 1 }, 1)).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: {
            reason: 'retained-count',
            requested: 1,
            used: 32,
            limit: 32,
            pendingFenceCandidates: 0,
            actual: 32,
          },
        },
      });
      expect(lifecycle.inspect()).toEqual(beforeOverflow);
    } finally {
      lifecycle.dispose();
    }
  });

  it('rejects invalid capacity configuration at construction', () => {
    const invalid = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5];
    for (const value of invalid) {
      expect(() => createDynamicGeometryLifecycle(value)).toThrow(RangeError);
      expect(() => createDynamicGeometryLifecycle(1, value)).toThrow(RangeError);
      expect(() => createDynamicGeometryLifecycle(1, 64, { maxRetainedCandidates: value })).toThrow(
        RangeError,
      );
    }
    expect(() => createDynamicGeometryLifecycle(4097)).toThrow(RangeError);
    expect(() => createDynamicGeometryLifecycle(1, 512 * 1024 * 1024 + 1)).toThrow(RangeError);
    expect(() => createDynamicGeometryLifecycle(32, 64, { maxRetainedCandidates: 31 })).toThrow(
      RangeError,
    );
    expect(() => createDynamicGeometryLifecycle(32, 64, { maxRetainedCandidates: 4097 })).toThrow(
      RangeError,
    );
    expect(() =>
      createDynamicGeometryLifecycle(4096, 512 * 1024 * 1024, { maxRetainedCandidates: 4096 }),
    ).not.toThrow();
  });

  it('keeps the 33-item batch gate independent from a 65-item retained budget', () => {
    const lifecycle = createDynamicGeometryLifecycle(32, DEFAULT_MESH_BYTES, RETAINED_65);
    const world = {};
    const prepared = Array.from({ length: 33 }, (_, index) => prepare(lifecycle, world, index + 1));
    try {
      const beforeReject = lifecycle.inspect();
      expect(lifecycle.acceptCandidates(prepared, { world, fixedStep: 0 })).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: {
            reason: 'batch-count',
            requested: 33,
            used: 33,
            limit: 32,
            pendingFenceCandidates: 0,
          },
        },
      });
      expect(lifecycle.inspect()).toEqual(beforeReject);
    } finally {
      for (const candidate of prepared) lifecycle.cancel(candidate);
      lifecycle.dispose();
    }
  });

  it('keeps all 32 preparation slots available alongside accepted World residents', () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const active = Array.from({ length: 33 }, (_, index) => accept(lifecycle, world, index + 1));
    const prepared = Array.from({ length: 32 }, (_, index) =>
      prepare(lifecycle, world, index + 1, 2),
    );
    try {
      const full = lifecycle.inspect();
      expect(full).toMatchObject({ accepted: 33, prepared: 32, meshBytes: 65 * MESH_BYTES });
      expect(lifecycle.prepare({ world, entity: 34, mesh: mesh(), revision: 1 }, 1)).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'retained-count', requested: 1, used: 32, limit: 32 },
        },
      });
      expect(lifecycle.inspect()).toEqual(full);

      const accepted = lifecycle.acceptCandidates(prepared, { world, fixedStep: 1 }).unwrap();
      expect(lifecycle.inspect()).toMatchObject({
        accepted: 65,
        prepared: 0,
        meshBytes: 65 * MESH_BYTES,
      });
      const next = prepare(lifecycle, world, 34);
      expect(lifecycle.inspect()).toMatchObject({ accepted: 65, prepared: 1 });
      lifecycle.cancel(next).unwrap();
      for (const candidate of active) lifecycle.cancel(candidate).unwrap();
      for (const candidate of accepted) lifecycle.cancel(candidate).unwrap();
      expect(lifecycle.inspect().meshBytes).toBe(0);
    } finally {
      lifecycle.dispose();
    }
  });

  it('allows every resident to enter cleanup even above the work limit, then blocks preparation until release', async () => {
    const lifecycle = createDynamicGeometryLifecycle();
    const world = {};
    const active = Array.from({ length: 33 }, (_, index) => accept(lifecycle, world, index + 1));
    const completions: (() => void)[] = [];
    const fences = active.map((candidate) => {
      const fence = new Promise<void>((resolve) => completions.push(resolve));
      lifecycle.cancel(candidate, fence).unwrap();
      return fence;
    });
    try {
      expect(lifecycle.inspect()).toMatchObject({ accepted: 0, meshBytes: 33 * MESH_BYTES });
      expect(lifecycle.prepare({ world, entity: 34, mesh: mesh(), revision: 1 }, 1)).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'retained-count', used: 33, limit: 32, pendingFenceCandidates: 33 },
        },
      });
      for (const complete of completions.slice(0, 2)) complete();
      await Promise.all(fences.slice(0, 2));
      expect(lifecycle.inspect().meshBytes).toBe(31 * MESH_BYTES);
      const next = prepare(lifecycle, world, 34);
      expect(lifecycle.prepare({ world, entity: 35, mesh: mesh(), revision: 1 }, 1)).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'retained-count', used: 32, limit: 32, pendingFenceCandidates: 31 },
        },
      });
      lifecycle.cancel(next).unwrap();
      for (const complete of completions.slice(2)) complete();
      await Promise.all(fences);
      expect(lifecycle.inspect().meshBytes).toBe(0);
      const afterCleanup = prepare(lifecycle, world, 35);
      lifecycle.cancel(afterCleanup).unwrap();
    } finally {
      lifecycle.dispose();
    }
  });

  it('keeps candidate count and mesh byte limits independent', () => {
    const countLifecycle = createDynamicGeometryLifecycle(1, 1024);
    const countWorld = {};
    const countCandidate = prepare(countLifecycle, countWorld, 1);
    try {
      const beforeCountReject = countLifecycle.inspect();
      expect(
        countLifecycle.prepare({ world: countWorld, entity: 2, mesh: mesh(), revision: 1 }, 1),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'retained-count', used: 1, limit: 1 },
        },
      });
      expect(countLifecycle.inspect()).toEqual(beforeCountReject);
    } finally {
      countLifecycle.cancel(countCandidate);
      countLifecycle.dispose();
    }

    const byteLifecycle = createDynamicGeometryLifecycle(65, MESH_BYTES, {
      maxRetainedCandidates: 65,
    });
    const byteWorld = {};
    const byteCandidate = accept(byteLifecycle, byteWorld, 1);
    try {
      const beforeByteReject = byteLifecycle.inspect();
      expect(
        byteLifecycle.prepare({ world: byteWorld, entity: 2, mesh: mesh(), revision: 1 }, 1),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: {
            reason: 'mesh-bytes',
            requested: MESH_BYTES,
            used: MESH_BYTES,
            limit: MESH_BYTES,
          },
        },
      });
      expect(byteLifecycle.inspect()).toEqual(beforeByteReject);
    } finally {
      byteLifecycle.cancel(byteCandidate);
      byteLifecycle.dispose();
    }
  });

  it('releases a synchronous cancellation reservation once', () => {
    const lifecycle = createDynamicGeometryLifecycle(1, MESH_BYTES);
    const world = {};
    const candidate = prepare(lifecycle, world, 1);
    try {
      lifecycle.cancel(candidate).unwrap();
      expect(lifecycle.inspect().meshBytes).toBe(0);
      expect(prepare(lifecycle, world, 2).meshBytes).toBe(MESH_BYTES);
      expect(lifecycle.inspect().meshBytes).toBe(MESH_BYTES);
    } finally {
      lifecycle.dispose();
    }
  });

  it('holds a cancelled reservation through a pending fence and releases after resolution', async () => {
    const lifecycle = createDynamicGeometryLifecycle(1, 2 * MESH_BYTES);
    const world = {};
    let resolveFence!: () => void;
    let resolveLaterFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    const laterFence = new Promise<void>((resolve) => {
      resolveLaterFence = resolve;
    });
    const candidate = prepare(lifecycle, world, 1);
    try {
      lifecycle.cancel(candidate, fence).unwrap();
      const pending = lifecycle.inspect();
      expect(pending.meshBytes).toBe(MESH_BYTES);
      expect(lifecycle.prepare({ world, entity: 2, mesh: mesh(), revision: 1 }, 1)).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'retained-count', pendingFenceCandidates: 1 },
        },
      });
      lifecycle.invalidateWorld(world, laterFence);
      expect(lifecycle.inspect()).toEqual(pending);

      resolveFence();
      await fence;
      await Promise.resolve();
      expect(lifecycle.inspect().meshBytes).toBe(0);
      const next = prepare(lifecycle, world, 2);
      expect(lifecycle.inspect().meshBytes).toBe(MESH_BYTES);
      expect(lifecycle.cancel(candidate).ok).toBe(false);
      expect(lifecycle.inspect().meshBytes).toBe(MESH_BYTES);
      lifecycle.cancel(next).unwrap();

      resolveLaterFence();
      await laterFence;
      await Promise.resolve();
      expect(lifecycle.inspect().meshBytes).toBe(0);
    } finally {
      lifecycle.dispose();
    }
  });

  it('releases a rejected cancellation fence exactly once', async () => {
    const lifecycle = createDynamicGeometryLifecycle(1, 2 * MESH_BYTES);
    const world = {};
    let rejectFence!: (reason: Error) => void;
    const fence = new Promise<void>((_, reject) => {
      rejectFence = reject;
    });
    const candidate = prepare(lifecycle, world, 1);
    try {
      lifecycle.cancel(candidate, fence).unwrap();
      rejectFence(new Error('completion fence rejected'));
      await expect(fence).rejects.toThrow('completion fence rejected');
      await Promise.resolve();
      expect(lifecycle.inspect().meshBytes).toBe(0);
      const next = prepare(lifecycle, world, 2);
      expect(lifecycle.inspect().meshBytes).toBe(MESH_BYTES);
      lifecycle.cancel(next).unwrap();
      expect(lifecycle.inspect().meshBytes).toBe(0);
    } finally {
      lifecycle.dispose();
    }
  });

  it('keeps a disposed World reservation until its fence settles', async () => {
    const lifecycle = createDynamicGeometryLifecycle(1, 2 * MESH_BYTES);
    const world = {};
    const otherWorld = {};
    let resolveFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    const candidate = prepare(lifecycle, world, 1);
    try {
      lifecycle.invalidateWorld(world, fence);
      expect(lifecycle.inspect()).toMatchObject({
        prepared: 0,
        accepted: 0,
        invalidated: 1,
        meshBytes: MESH_BYTES,
      });
      expect(
        lifecycle.prepare({ world: otherWorld, entity: 2, mesh: mesh(), revision: 1 }, 1),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'retained-count', pendingFenceCandidates: 1 },
        },
      });

      resolveFence();
      await fence;
      await Promise.resolve();
      expect(lifecycle.inspect()).toMatchObject({ invalidated: 1, meshBytes: 0 });
      expect(lifecycle.cancel(candidate).ok).toBe(false);
      const next = prepare(lifecycle, otherWorld, 2);
      expect(lifecycle.inspect().meshBytes).toBe(MESH_BYTES);
      lifecycle.cancel(next).unwrap();
    } finally {
      lifecycle.dispose();
    }
  });

  it('preserves accepted history when a 33-item candidate batch is rejected', () => {
    const lifecycle = createDynamicGeometryLifecycle(32, DEFAULT_MESH_BYTES, RETAINED_65);
    const world = {};
    const active = accept(lifecycle, world, 100, 1);
    const successor = lifecycle
      .prepare({ world, entity: 100, mesh: mesh(), revision: 2, topologyRevision: 2 }, 1)
      .unwrap();
    const otherCandidates = Array.from({ length: 32 }, (_, index) =>
      prepare(lifecycle, world, index + 1),
    );
    try {
      const beforeReject = lifecycle.inspect();
      expect(
        lifecycle.acceptCandidates([successor, ...otherCandidates], { world, fixedStep: 0 }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'dynamic-geometry-budget-exceeded',
          detail: { reason: 'batch-count', requested: 33, limit: 32 },
        },
      });
      expect(lifecycle.inspect()).toEqual(beforeReject);
      expect(beforeReject).toMatchObject({
        accepted: 1,
        prepared: 33,
        historyInvalidations: 0,
        invalidated: 0,
      });

      const acceptedSuccessor = lifecycle.accept(successor, { world, fixedStep: 0 }).unwrap();
      expect(lifecycle.inspect()).toMatchObject({ historyInvalidations: 1, invalidated: 1 });
      lifecycle.cancel(active).unwrap();
      lifecycle.cancel(acceptedSuccessor).unwrap();
    } finally {
      for (const candidate of otherCandidates) lifecycle.cancel(candidate);
      lifecycle.dispose();
    }
  });
});
