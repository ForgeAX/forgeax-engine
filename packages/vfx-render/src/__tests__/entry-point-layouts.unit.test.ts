import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import {
  projectVfxEntryPointLayouts,
  registerVfxEntryPointBindings,
} from '../feature/entry-point-layouts';

type Resource = RenderFeatureWorkPlan['resources'][number];
type Pass = RenderFeatureWorkPlan['passes'][number];
it('preserves mixed stage order, binding overrides and temporal tags while projecting actual entry reads', () => {
  const program = {
    wgsl: 'source is unchanged',
    entryPoints: ['allocate', 'update'],
    bindings: [
      {
        label: '@group(0)',
        entries: Array.from({ length: 9 }, (_, binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'storage' as const },
        })),
      },
    ],
  };
  registerVfxEntryPointBindings(program, [
    {
      name: 'allocate',
      stage: 'compute',
      bindings: [0, 1, 8].map((binding) => ({ group: 0, binding })),
    },
    {
      name: 'update',
      stage: 'compute',
      bindings: [1, 2].map((binding) => ({ group: 0, binding })),
    },
  ]);
  const resources: Resource[] = [
    { kind: 'compute-program', name: 'program', program },
    {
      kind: 'compute-bindings',
      name: 'bindings',
      program: 'program',
      entries: Array.from({ length: 9 }, (_, binding) => ({ binding, resource: `data${binding}` })),
    },
    {
      kind: 'compute-bindings',
      name: 'second',
      program: 'program',
      entries: Array.from({ length: 9 }, (_, binding) => ({
        binding,
        resource: `second${binding}`,
      })),
    },
  ];
  const temporal = { timeline: 'ocean', epoch: 2, tick: 7, phase: 'consumer' as const };
  const passes: Pass[] = [
    {
      kind: 'compute',
      name: 'tick',
      program: 'program',
      bindings: 'bindings',
      temporal,
      dispatches: [
        { kind: 'direct', entryPoint: 'allocate', workgroups: [1] },
        { kind: 'direct', entryPoint: 'update', workgroups: [2] },
        { kind: 'direct', entryPoint: 'update', workgroups: [3], bindings: 'second' },
        { kind: 'direct', entryPoint: 'allocate', workgroups: [4] },
      ],
    },
  ];
  projectVfxEntryPointLayouts([{ resources, passes }]);
  const programs = resources.filter((row) => row.kind === 'compute-program');
  expect(programs).toHaveLength(2);
  expect(
    programs.map((row) => row.program.bindings?.[0]?.entries.map((entry) => entry.binding)),
  ).toEqual([
    [0, 1, 8],
    [1, 2],
  ]);
  expect(programs.every((row) => row.program.wgsl === 'source is unchanged')).toBe(true);
  expect(
    passes.map((pass) =>
      pass.kind === 'compute'
        ? pass.dispatches.map((d) => (d.kind === 'direct' ? d.workgroups : []))
        : [],
    ),
  ).toEqual([[[1]], [[2], [3]], [[4]]]);
  expect(passes.every((pass) => pass.temporal === temporal)).toBe(true);
  const actual = resources.filter((row) => row.kind === 'compute-bindings');
  expect(actual.every((row) => row.entries.length <= 3)).toBe(true);
  expect(
    actual.some(
      (row) =>
        row.entries.every((entry) => entry.resource.startsWith('second')) &&
        row.entries.length === 2,
    ),
  ).toBe(true);
  expect(
    resources.some(
      (row) => row.name === 'program' || row.name === 'bindings' || row.name === 'second',
    ),
  ).toBe(false);
});
it('keeps legacy programs without exact entry reflection on the existing union contract', () => {
  const resources: Resource[] = [
    {
      kind: 'compute-program',
      name: 'legacy',
      program: {
        wgsl: 'original',
        entryPoints: ['main'],
        bindings: [{ label: '@group(0)', entries: [] }],
      },
    },
  ];
  const original = resources[0];
  const passes: Pass[] = [];
  projectVfxEntryPointLayouts([{ resources, passes }]);
  expect(resources[0]).toBe(original);
});

it('uses the original native eight-storage admission on actual projected layouts', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  vi.spyOn(device, 'limits', 'get').mockReturnValue({
    ...device.limits,
    maxStorageBuffersPerShaderStage: 8,
  });
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const program = {
    wgsl: 'same module',
    entryPoints: ['a', 'b'],
    bindings: [
      {
        label: '@group(0)',
        entries: Array.from({ length: 9 }, (_, binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'storage' as const },
        })),
      },
    ],
  };
  const resources: Resource[] = [{ kind: 'compute-program', name: 'program', program }];
  const passes: Pass[] = [];
  registerVfxEntryPointBindings(program, [
    { name: 'a', stage: 'compute', bindings: [0, 1, 8].map((binding) => ({ group: 0, binding })) },
    { name: 'b', stage: 'compute', bindings: [2, 3].map((binding) => ({ group: 0, binding })) },
  ]);
  try {
    expect(owner.beginFeature('union', 0).prepareProgram('bad', program).ok).toBe(false);
    projectVfxEntryPointLayouts([{ resources, passes }]);
    const layouts = vi.spyOn(device, 'createBindGroupLayout');
    const session = owner.beginFeature('entries', 0);
    for (const resource of resources)
      if (resource.kind === 'compute-program')
        expect(session.prepareProgram(resource.name, resource.program).ok).toBe(true);
    expect(
      layouts.mock.calls.map(
        ([descriptor]) =>
          Array.from(descriptor.entries ?? []).filter((row) => row.buffer?.type === 'storage')
            .length,
      ),
    ).toEqual([3, 2]);
  } finally {
    owner.dispose();
  }
});
