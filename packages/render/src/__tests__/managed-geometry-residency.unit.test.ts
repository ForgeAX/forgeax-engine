import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatch, GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { gpuDrivenMeshesForFrame } from '../record/resident-meshes';
import type { PersistentGpuDrivenState } from '../scene/render-scene';

it('resolves shared mesh bindings without inspecting scene members', () => {
  const sourceScope = worldRenderResources(new World());
  const meshes = [{ contentEpoch: 1 }, { contentEpoch: 2 }] as MeshGpuHandles[];
  const getMeshGpuHandles = vi.fn((handle: number) => meshes[handle - 7]);
  const ensureResident = vi.fn(() => ok(meshes[0]));
  const internals = {
    gpuStore: { getMeshGpuHandles, ensureResident },
  } as unknown as RenderSystemInternals;
  const bindings = [7, 7, 8].map((assetHandle) => ({ assetHandle }) as GpuDrivenBatchBinding);
  const state = {
    plan: { batches: bindings.map((binding) => ({ binding }) as GpuDrivenBatch) },
    get slots() {
      throw new Error('shared residency must not visit scene members');
    },
  } as unknown as PersistentGpuDrivenState;
  const result = gpuDrivenMeshesForFrame(internals, sourceScope, state);
  expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
  const [first, shared, other] = bindings;
  assert(first && shared && other);
  expect(result.get(first)).toBe(meshes[0]);
  expect(result.get(shared)).toBe(meshes[0]);
  expect(result.get(other)).toBe(meshes[1]);
  expect(ensureResident).not.toHaveBeenCalled();
});

it('keeps one table for a fixed plan and never keeps an earlier plan reachable', async () => {
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const sourceScope = worldRenderResources(new World());
  let mesh = { contentEpoch: 1 } as MeshGpuHandles;
  const internals = {
    gpuStore: {
      getMeshGpuHandles: (id: number) => (id === 7 ? mesh : undefined),
      ensureResident: () => ok(mesh),
    },
  } as unknown as RenderSystemInternals;
  const binding = { assetHandle: 7 } as GpuDrivenBatchBinding;
  const state = (batches: readonly GpuDrivenBatch[]) =>
    ({ plan: { batches } }) as unknown as PersistentGpuDrivenState;
  const fixed = [{ binding } as GpuDrivenBatch];
  const first = gpuDrivenMeshesForFrame(internals, sourceScope, state(fixed));
  expect(gpuDrivenMeshesForFrame(internals, sourceScope, state(fixed))).toBe(first);
  mesh = { contentEpoch: 2 } as MeshGpuHandles;
  const replaced = gpuDrivenMeshesForFrame(internals, sourceScope, state(fixed));
  expect(replaced).not.toBe(first);
  expect(replaced.get(binding)).toBe(mesh);
  const released = (() => {
    const earlier = [{ binding } as GpuDrivenBatch];
    expect(gpuDrivenMeshesForFrame(internals, sourceScope, state(earlier))).toBe(replaced);
    return new WeakRef(earlier);
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(released.deref()).toBeUndefined();

  const partial = (() => {
    const absent = { assetHandle: 11 } as GpuDrivenBatchBinding;
    const table = gpuDrivenMeshesForFrame(
      internals,
      sourceScope,
      state([...fixed, { binding: absent } as GpuDrivenBatch]),
      'resident-only',
    );
    expect(table.has(absent)).toBe(false);
    return { table, absent: new WeakRef(absent) };
  })();
  gpuDrivenMeshesForFrame(internals, sourceScope, state([]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(partial.absent.deref()).toBeUndefined();
  expect(partial.table.get(binding)).toBe(mesh);
});

it('reads changing batch membership once and publishes independent physical mesh bindings', () => {
  const world = worldRenderResources(new World());
  const residents = new Map([[19, { contentEpoch: 1 } as MeshGpuHandles]]);
  const getMeshGpuHandles = vi.fn((handle: number) => residents.get(handle));
  const internals = { gpuStore: { getMeshGpuHandles } } as unknown as RenderSystemInternals;
  const bindings = [19, 23, 19].map((assetHandle) => ({ assetHandle }) as GpuDrivenBatchBinding);
  const [a, b, c] = bindings;
  assert(a && b && c);
  let reads = 0;
  const batches = bindings.map((binding) => ({
    get binding() {
      reads++;
      return binding;
    },
  }));
  const scene = { plan: { batches } } as unknown as PersistentGpuDrivenState;
  const read = () => gpuDrivenMeshesForFrame(internals, world, scene, 'resident-only');
  const first = read();
  expect([...first.keys()]).toEqual([a, c]);
  residents.set(19, { contentEpoch: 2 } as MeshGpuHandles);
  residents.set(23, { contentEpoch: 3 } as MeshGpuHandles);
  reads = 0;
  getMeshGpuHandles.mockClear();
  const changed = read();
  expect(reads).toBe(3);
  expect(getMeshGpuHandles.mock.calls.map(([handle]) => handle)).toEqual([19, 23]);
  expect([...changed.keys()]).toEqual([a, b, c]);
  expect(first.get(a)?.contentEpoch).toBe(1);
  expect(changed.get(c)?.contentEpoch).toBe(2);
  batches.splice(1, 1);
  expect([...read().keys()]).toEqual([a, c]);
  expect(changed.get(b)?.contentEpoch).toBe(3);
});

it('keeps the insertion order and physical versions of each issued binding table during churn', () => {
  const scope = worldRenderResources(new World());
  const residents = new Map([1, 2].map((id) => [id, { contentEpoch: id } as MeshGpuHandles]));
  const internals = {
    gpuStore: { getMeshGpuHandles: (id: number) => residents.get(id) },
  } as unknown as RenderSystemInternals;
  const [a, b, c] = [1, 2, 1].map((assetHandle) => ({ assetHandle }) as GpuDrivenBatchBinding);
  assert(a && b && c);
  const read = (bindings: GpuDrivenBatchBinding[]) =>
    gpuDrivenMeshesForFrame(
      internals,
      scope,
      {
        plan: { batches: bindings.map((binding) => ({ binding })) },
      } as unknown as PersistentGpuDrivenState,
      'resident-only',
    );
  const original = read([a, b, c, a]);
  const reordered = read([c, b, a, c]);
  expect(reordered.keys().next().value).toBe(c);
  expect(original.keys().next().value).toBe(a);
  for (let frame = 0; frame < 60; frame++) {
    residents.set(1, { contentEpoch: frame + 10 } as MeshGpuHandles);
    if (frame % 2) residents.delete(2);
    else residents.set(2, { contentEpoch: frame } as MeshGpuHandles);
    const issued = read([c, b, a, c]);
    expect(issued.size).toBe(frame % 2 ? 2 : 3);
    expect(issued.get(c)).toBe(issued.get(a));
    expect(issued.get(c)?.contentEpoch).toBe(frame + 10);
    expect(issued.has(b)).toBe(!(frame % 2));
    expect([...issued.values()]).toEqual([...issued].map(([, v]) => v));
    const keys: GpuDrivenBatchBinding[] = [];
    issued.forEach((_resident, binding, owner) => {
      expect(owner).toBe(issued);
      keys.push(binding);
    });
    expect(keys).toEqual([...issued.keys()]);
  }
  expect(reordered.get(a)?.contentEpoch).toBe(1);
  expect(original.get(b)?.contentEpoch).toBe(2);
});
