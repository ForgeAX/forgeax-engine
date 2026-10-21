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
