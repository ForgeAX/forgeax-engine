import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { MeshAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import {
  gpuParticleRenderFeature,
  planPasses,
  planResources,
  vfxTestIntent,
} from './vfx-frame-fixture';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const kinds = ['billboard', 'mesh', 'ribbon', 'trail', 'beam'] as const;
const simulation = [
  'spawn',
  'update',
  'scan_blocks',
  'scan_block_offsets',
  'add_offsets',
  'compact',
  'event',
  'stage_swirl',
];
const entries = [
  ...simulation,
  'sort',
  ...kinds,
  'trail_history',
  'trail_offsets',
  'future_kernel',
].map((name) => `forgeax_vfx_${name}_main`);
const mesh: MeshAsset = {
  kind: 'mesh',
  vertices: new Float32Array(18),
  attributes: {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array(9),
    uv: new Float32Array(6),
  },
  indices: new Uint16Array([0, 1, 2]),
  submeshes: [
    { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
  ],
  materialSlots: [{ slotName: 'Default' }],
};

function createFixture(
  selected: readonly (typeof kinds)[number][],
  capacity = 4,
  extensions = true,
) {
  const world = new World();
  const player = world.spawn().unwrap();
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: identity(),
  };
  const renderers = selected.map((kind) => ({
    kind,
    material: 'material',
    mesh: 'mesh',
    capacity: 4,
    historyLength: 4,
    stripKey: 'alive-index',
    endpointField: 'velocity',
    sorting: 'view-depth',
    enabled: true,
    castShadows: kind === 'mesh',
  }));
  const emitter = {
    id: 'first-use',
    capacity,
    space: 'world',
    simulationWhenCulled: 'continue',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 0.1 },
    wgsl: '// unchanged cooked source',
    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
    reflection: {
      entryPoints: extensions
        ? entries
        : entries.filter(
            (name) =>
              !['event', 'stage_swirl', 'future_kernel'].some(
                (extra) => name === `forgeax_vfx_${extra}_main`,
              ),
          ),
      bindings: [{ entries: [] }],
      dataInterfaces: [],
      stages: extensions
        ? [
            {
              id: 'swirl',
              entry: 'swirl',
              entryPoint: 'forgeax_vfx_stage_swirl_main',
              domain: 'particle',
              resources: [],
              dependsOn: ['update'],
              iterationBudget: 1,
            },
          ]
        : [],
    },
    renderers,
  };
  const definition = vfxTestIntent({ emitter, programFingerprint: 'fixture' } as never).effect;
  const reference = {
    id: emitter.id,
    effect: world.internSharedRef('ParticleEffectAsset', definition),
  };
  const intent = {
    sequence: 1,
    player,
    emitter: reference,
    programFingerprint: 'fixture',
    reset: true,
    fixedDelta: 1 / 60,
    phaseTick: 0,
    tick: 0,
    seed: 1,
    playCycle: 0,
    spawnCount: 1,
    firstParticleId: 0,
    instanceGeneration: 0,
    channelInputs: [],
    eventCounters: {},
    parameterBlock: new Uint8Array(),
  };
  const entry = {
    sourceWorldIndex: 0,
    worldId: 0,
    runtimeId: 0,
    renderGeneration: 0,
    camera,
    views: [{ identity: 'main', camera }],
    intents: [intent],
    retained: [] as unknown[],
    materials: new Map(),
    meshes: new Map([['mesh', mesh]]),
    emitterState: new Map([
      [
        `${Number(player)}:first-use`,
        { enabled: true, localToWorld: identity(), player, emitter: reference },
      ],
    ]),
  };
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  let frameNumber = 0;
  const plan = (generation = 1) =>
    feature
      .plan(
        { worlds: [entry], frameNumber: ++frameNumber } as never,
        {
          targets: [],
          caps: {},
          generation,
          resolveAsset: (_index: number, handle: never) => resolveAssetHandle(world, handle),
        } as never,
      )
      .unwrap();
  let firstRasterDrawCount: number | undefined;
  const program = (generation = 1) => {
    const planned = plan(generation);
    firstRasterDrawCount ??= planPasses(planned).flatMap((pass) =>
      pass.kind === 'raster' ? pass.draws : [],
    ).length;
    const row = planResources(planned).find((resource) => resource.kind === 'compute-program');
    if (row?.kind !== 'compute-program') throw new Error('missing native compute program');
    for (const pass of planPasses(planned)) {
      if (pass.kind !== 'compute' || pass.program !== row.name) continue;
      for (const dispatch of pass.dispatches)
        expect(row.program.entryPoints).toContain(dispatch.entryPoint);
    }
    return row.program;
  };
  return {
    world,
    player,
    camera,
    renderers,
    emitter,
    reference,
    intent,
    entry,
    program,
    rasterCount: () => firstRasterDrawCount,
  };
}

for (let mask = 0; mask < 32; mask += 1) {
  const selected = kinds.filter((_, index) => (mask & (1 << index)) !== 0);
  it(`prepares only authored VFX topologies: ${selected.join('+') || 'simulation-only'}`, () => {
    const { player, camera, renderers, emitter, reference, intent, entry, program, rasterCount } =
      createFixture(selected);
    const first = program();
    expect(rasterCount()).toBe(selected.length);
    expect(first.wgsl).toBe(emitter.wgsl);
    expect(first.bindings).toEqual(emitter.reflection.bindings);
    for (const kind of kinds) {
      if (!selected.includes(kind))
        expect(first.entryPoints).not.toContain(`forgeax_vfx_${kind}_main`);
    }
    for (const name of [
      ...simulation.filter((name) => name !== 'scan_block_offsets' && name !== 'add_offsets'),
      'future_kernel',
    ])
      expect(first.entryPoints).toContain(`forgeax_vfx_${name}_main`);
    expect(first.entryPoints).not.toContain('forgeax_vfx_scan_block_offsets_main');
    expect(first.entryPoints).not.toContain('forgeax_vfx_add_offsets_main');
    expect(first.entryPoints.includes('forgeax_vfx_sort_main')).toBe(
      selected.includes('billboard') || selected.includes('mesh'),
    );
    intent.reset = false;
    camera.viewProjection[12] = 10_000;
    expect(program()).toEqual(first);
    camera.viewProjection[12] = 0;
    expect(program()).toEqual(first);
    for (const renderer of renderers) renderer.enabled = false;
    expect(program()).toEqual(first);
    for (const renderer of renderers) {
      renderer.enabled = true;
      renderer.sorting = 'custom-descending';
    }
    expect(program()).toEqual(first);
    entry.intents = [];
    entry.retained = [
      { player, emitter: reference, intent, localToWorld: identity(), visible: true },
    ];
    expect(program()).toEqual(first);
    entry.retained = [];
    intent.reset = true;
    intent.playCycle += 1;
    intent.sequence += 1;
    entry.intents = [intent];
    expect(program()).toEqual(first);
    expect(program(2)).toEqual(first);
  });
}

it.each([
  { name: 'dust', kind: 'billboard' as const, capacity: 9, sorting: 'view-depth', count: 6 },
  { name: 'chips', kind: 'mesh' as const, capacity: 7, sorting: 'none', count: 5 },
  { name: 'sparks', kind: 'mesh' as const, capacity: 9, sorting: 'none', count: 5 },
  { name: 'one block', kind: 'mesh' as const, capacity: 256, sorting: 'none', count: 5 },
  { name: 'two blocks', kind: 'mesh' as const, capacity: 257, sorting: 'none', count: 7 },
  {
    name: 'sorted two blocks',
    kind: 'billboard' as const,
    capacity: 257,
    sorting: 'view-depth',
    count: 8,
  },
])('creates only $count first-use compute pipelines for $name', async ({
  kind,
  capacity,
  sorting,
  count,
}) => {
  const fixture = createFixture([kind], capacity, false);
  for (const renderer of fixture.renderers) renderer.sorting = sorting;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: fixture.emitter.wgsl })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const prepare = (name: string, generation = 1) => {
    pipelines.mockClear();
    const descriptor = fixture.program(generation);
    const session = owner.beginFeature('forgeax.vfx-render.gpu-particles', generation, 'immediate');
    session.prepareProgram(name, descriptor).unwrap();
    for (const lease of session.commitFrame()) lease.release().unwrap();
    return pipelines.mock.calls.map(([pipeline]) => pipeline.compute.entryPoint);
  };
  try {
    expect(prepare('first-player')).toHaveLength(count);
    fixture.intent.spawnCount = 0;
    expect(prepare('first-player')).toEqual([]);
    expect(prepare('second-player')).toEqual([]);
    // A change between no sorting and sorting changes the contract once;
    // switching back must reuse the original descriptor's compiled program.
    for (const renderer of fixture.renderers)
      renderer.sorting = sorting === 'none' ? 'view-depth' : 'none';
    expect(prepare('second-player')).toHaveLength(count + (sorting === 'none' ? 1 : -1));
    for (const renderer of fixture.renderers) renderer.sorting = sorting;
    expect(prepare('second-player')).toEqual([]);
    fixture.emitter.capacity = capacity > 256 ? 256 : 257;
    expect(prepare('second-player')).toHaveLength(count + (capacity > 256 ? -2 : 2));
    fixture.emitter.capacity = capacity;
    expect(prepare('second-player')).toEqual([]);
    // Rebuild the same required set through the existing generation owner.
    expect(prepare('second-player', 2)).toHaveLength(count);
  } finally {
    owner.dispose().unwrap();
    pipelines.mockRestore();
  }
});
