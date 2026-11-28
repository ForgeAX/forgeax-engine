import type { RhiDevice } from '@forgeax/engine-rhi';
import { ok, type ShaderEntryPointReads } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { PipelineState } from '../../render-system';
import { createWaterFrameLayouts } from '../water-frame-layouts';

it('projects certified Water-only graphics without a dummy mesh binding and keeps mesh layouts distinct', () => {
  const layouts: { entries: readonly { binding: number }[] }[] = [];
  const device = {
    caps: { storageBuffer: true },
    limits: {
      maxBindingsPerBindGroup: 64,
      maxUniformBuffersPerShaderStage: 16,
      maxSampledTexturesPerShaderStage: 16,
    },
    createBindGroupLayout: vi.fn((descriptor) => {
      layouts.push(descriptor);
      return ok(descriptor);
    }),
    createPipelineLayout: vi.fn((descriptor) => ok(descriptor)),
  } as unknown as RhiDevice;
  const owner = createWaterFrameLayouts(
    { errorRegistry: { fire: vi.fn() } } as never,
    () => device,
  );
  const layout = {};
  const state = {
    viewBindGroupLayout: layout,
    materialBindGroupLayout: layout,
    meshBindGroupLayout: layout,
    instancesBindGroupLayout: layout,
  } as PipelineState;
  const reads: readonly ShaderEntryPointReads[] = [
    {
      name: 'vs_main',
      stage: 'vertex',
      bindings: [
        { group: 2, binding: 16 },
        { group: 2, binding: 17 },
        { group: 2, binding: 21 },
      ],
    },
  ];
  const field = owner.waterWavesPipelineLayout(
    state,
    'pbr',
    false,
    undefined,
    undefined,
    'field',
    reads,
  );
  expect(field).not.toBeNull();
  const groups = (
    field?.pipelineLayout as unknown as { bindGroupLayouts: { entries: unknown[] }[] }
  ).bindGroupLayouts;
  for (const group of [0, 1, 3]) expect(groups[group]?.entries).toEqual([]);
  const system = layouts.find((value) => value.entries.some((entry) => entry.binding === 16));
  expect(system?.entries.map((entry) => entry.binding)).toEqual([16, 17, 21]);
  const first = reads[0];
  if (first === undefined) throw new Error('Missing fixture entry');
  const meshReads = [
    {
      ...reads[0],
      name: 'vs_mesh',
      stage: 'vertex' as const,
      bindings: [{ group: 2, binding: 0 }, ...first.bindings],
    },
  ];
  const mesh = owner.waterWavesPipelineLayout(
    state,
    'pbr',
    false,
    undefined,
    undefined,
    'mesh',
    meshReads,
  );
  expect(mesh?.group2Layout).not.toBe(field?.group2Layout);
  expect(layouts.at(-1)?.entries.map((entry) => entry.binding)).toEqual([0, 16, 17, 21]);
});
