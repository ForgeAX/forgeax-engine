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
  const worlds = [new World(), new World()];
  const scopes = worlds.map(worldRenderResources);
  const meshes = [{ contentEpoch: 1 }, { contentEpoch: 2 }] as MeshGpuHandles[];
  const getMeshGpuHandles = vi.fn(
    (_handle: number, scope: (typeof scopes)[number]) => meshes[scopes.indexOf(scope)],
  );
  const ensureResident = vi.fn(() => ok(meshes[0]));
  const internals = {
    gpuStore: { getMeshGpuHandles, ensureResident },
  } as unknown as RenderSystemInternals;
  const bindings = [0, 0, 1].map(
    (worldId) => ({ worldId, assetHandle: 7 }) as GpuDrivenBatchBinding,
  );
  const state = {
    plan: { batches: bindings.map((binding) => ({ binding }) as GpuDrivenBatch) },
    get slots() {
      throw new Error('shared residency must not visit scene members');
    },
  } as unknown as PersistentGpuDrivenState;
  const result = gpuDrivenMeshesForFrame(internals, scopes, state);
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
  const scopes = [worldRenderResources(new World())];
  let mesh = { contentEpoch: 1 } as MeshGpuHandles;
  const internals = {
    gpuStore: { getMeshGpuHandles: () => mesh, ensureResident: () => ok(mesh) },
  } as unknown as RenderSystemInternals;
  const binding = { worldId: 0, assetHandle: 7 } as GpuDrivenBatchBinding;
  const state = (batches: readonly GpuDrivenBatch[]) =>
    ({ plan: { batches } }) as unknown as PersistentGpuDrivenState;
  const fixed = [{ binding } as GpuDrivenBatch];
  const first = gpuDrivenMeshesForFrame(internals, scopes, state(fixed));
  expect(gpuDrivenMeshesForFrame(internals, scopes, state(fixed))).toBe(first);
  mesh = { contentEpoch: 2 } as MeshGpuHandles;
  const replaced = gpuDrivenMeshesForFrame(internals, scopes, state(fixed));
  expect(replaced).not.toBe(first);
  expect(replaced.get(binding)).toBe(mesh);
  const released = (() => {
    const earlier = [{ binding } as GpuDrivenBatch];
    expect(gpuDrivenMeshesForFrame(internals, scopes, state(earlier))).toBe(replaced);
    return new WeakRef(earlier);
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(released.deref()).toBeUndefined();
});
