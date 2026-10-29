import type { Buffer } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createMeshSsboGrowController } from '../assembly/mesh-ssbo-grow';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { PerSubmeshMaterialBgDeps } from '../record/main-pass-material';
import { materialUniformResources, prepareMaterialUniform } from '../record/material-uniforms';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import { defaultMaterialSnapshot } from '../render-system-extract';

it('keeps physical upload proofs separate when a queue callback prepares another material', () => {
  const resources = materialUniformResources([]);
  const world = {} as RenderResourceScope;
  const outer = defaultMaterialSnapshot();
  const inner = defaultMaterialSnapshot();
  const outerBuffer = {};
  const innerBuffer = {};
  const write = vi.fn((..._args: unknown[]) => ok(undefined));
  const device = { queue: { writeBuffer: write } };
  const deps = (buffer: object) =>
    ({
      runtime: { device },
      frameState: {},
      pipelineState: { materialUniformBuffer: { buffer } },
    }) as unknown as PerSubmeshMaterialBgDeps;
  const outside = deps(outerBuffer);
  const inside = deps(innerBuffer);
  write.mockImplementationOnce(() => {
    prepareMaterialUniform(inside, inner, world, resources);
    return ok(undefined);
  });
  prepareMaterialUniform(outside, outer, world, resources);
  expect(write.mock.calls.map(([buffer]) => buffer)).toEqual([outerBuffer, innerBuffer]);
  prepareMaterialUniform(outside, outer, world, resources);
  prepareMaterialUniform(inside, inner, world, resources);
  expect(write).toHaveBeenCalledTimes(2);
});

it('remembers the written buffer when reentry grows the same runtime arena', () => {
  const resources = materialUniformResources([]);
  const world = {} as RenderResourceScope;
  const outer = defaultMaterialSnapshot(101);
  const inner = defaultMaterialSnapshot(102);
  const growth = createMeshSsboGrowController({
    device: {
      limits: { maxStorageBufferBindingSize: 1 << 20 },
      createBuffer: (descriptor) => ({ label: descriptor.label }) as unknown as Buffer,
    },
    errorRegistry: {
      fire: (error) => {
        throw error;
      },
    },
    initialSlotCount: 1,
    materialStride: MATERIAL_PER_ENTITY_STRIDE,
    meshUsage: 0,
    materialUsage: 0,
  });
  growth.initialBuild();
  const storage = growth.state.material;
  const oldBuffer = storage.buffer;
  const write = vi.fn((..._args: unknown[]) => ok(undefined));
  const deps = {
    runtime: {
      device: { queue: { writeBuffer: write } },
      meshSsboState: growth.state,
      growMeshSsbo: growth.growMeshSsbo,
    },
    frameState: {},
    pipelineState: { materialUniformBuffer: storage },
  } as unknown as PerSubmeshMaterialBgDeps;
  write.mockImplementationOnce(() => {
    prepareMaterialUniform(deps, inner, world, resources);
    return ok(undefined);
  });
  prepareMaterialUniform(deps, outer, world, resources);
  const newBuffer = storage.buffer;
  expect(newBuffer).not.toBe(oldBuffer);
  prepareMaterialUniform(deps, outer, world, resources);
  expect(write.mock.calls).toHaveLength(3);
  expect(write.mock.calls[0]?.[0]).toBe(oldBuffer);
  expect(write.mock.calls[1]?.[0]).toBe(newBuffer);
  expect(write.mock.calls[2]?.[0]).toBe(newBuffer);
  expect(write.mock.calls.map(([, offset]) => offset)).toEqual([0, MATERIAL_PER_ENTITY_STRIDE, 0]);
  prepareMaterialUniform(deps, inner, world, resources);
  prepareMaterialUniform(deps, outer, world, resources);
  expect(write).toHaveBeenCalledTimes(3);
});
