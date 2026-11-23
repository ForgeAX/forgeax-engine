import { type BindGroupLayout, type BindGroupLayoutEntry, ok } from '@forgeax/engine-rhi';
import { PARTICLE_MESH_SURFACE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import {
  derive,
  MATERIAL_POST_PROCESS_SCENE_LAYOUT,
  type MaterialProgramBindingContract,
  type MaterialProgramSystemInputs,
  type MaterialSurfaceModel,
  type ParamSchemaEntry,
  type ShaderEntryPointReads,
  type ShaderReflection,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { FORWARD_SCREEN_SURFACE_VIEW_SLOT, retainViewLayout } from '../../../environment/bindings';
import {
  assembleLitMaterialEntries,
  type SkylightBindGroupResources,
} from '../../../ibl/skylight-bind-group';
import {
  projectMaterialLayoutEntries,
  projectSurfaceMaterialBindings,
} from '../../../pbr-pipeline';
import type { RendererPipelineCacheState } from '../../recovery/renderer-recover';
import { createMaterialLayoutCache } from '../layout-cache';

function setup() {
  let source = '';
  let bindings: MaterialProgramBindingContract = 'render-material';
  let schema: readonly ParamSchemaEntry[] | undefined;
  let surface: { model: MaterialSurfaceModel } | undefined;
  let layoutIdentity: string | undefined;
  let systemInputs: MaterialProgramSystemInputs | undefined;
  let entryPoints: readonly ShaderEntryPointReads[] | undefined;
  let materialBindings: readonly number[] | undefined;
  let variants: readonly { entryPoints?: readonly ShaderEntryPointReads[] }[] = [];
  let reflection: ShaderReflection | undefined;
  const state = {
    preparedMaterialPipelineLayoutCache: new Map(),
    perShaderMaterialLayoutCache: new Map(),
  } as RendererPipelineCacheState;
  const view = { kind: 'view' },
    material = { kind: 'material' },
    mesh = { kind: 'mesh' },
    instances = { kind: 'instances' };
  const createBindGroupLayout = vi.fn((descriptor) => ok({ descriptor }));
  const createPipelineLayout = vi.fn((descriptor) => ok({ descriptor }));
  const lookup = vi.fn(() =>
    ok({
      source,
      receipt: { bindings, surface, systemInputs, entryPoints, reflection: { layoutIdentity } },
      paramSchema: schema,
      program: { identity: source, materialBindings, entryPoints },
    }),
  );
  const shader = {
    findMaterialArtifact: lookup,
    materialShaderManifestEntry: () =>
      variants.length === 0 && reflection === undefined ? undefined : { variants, reflection },
    materialProgram: () => ({ probeBlendRecordRequired: false }),
  };
  const pipelineState = {
    viewBindGroupLayout: view,
    materialBindGroupLayout: material,
    meshBindGroupLayout: mesh,
    instancesBindGroupLayout: instances,
  } as never;
  const device = {
    createBindGroupLayout,
    createPipelineLayout,
    caps: { storageBuffer: true },
    limits: {},
  } as never;
  const cache = createMaterialLayoutCache({
    currentPipelineCacheState: () => state,
    currentPipelineState: () => pipelineState,
    currentBuildDevice: () => device,
    getShader: () => shader as never,
    viewAndSceneDepthLayoutEntries: () => [
      { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: 3,
        texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
      },
    ],
    reportError: (error) => {
      throw error;
    },
  });
  return {
    cache,
    state,
    lookup,
    createBindGroupLayout,
    createPipelineLayout,
    view,
    shader,
    setSource(value: string) {
      source = value;
    },
    setBindings(value: MaterialProgramBindingContract) {
      bindings = value;
    },
    setSystemInputs(value: MaterialProgramSystemInputs) {
      systemInputs = value;
    },
    setEntryPoints(value: readonly ShaderEntryPointReads[]) {
      entryPoints = value;
    },
    setLayoutIdentity(value: string) {
      layoutIdentity = value;
    },
    setSchema(value: readonly ParamSchemaEntry[]) {
      schema = value;
    },
    setSurfaceReads(
      reads: readonly ShaderEntryPointReads[],
      declarations: readonly number[],
      model: MaterialSurfaceModel = 'single-layer-water',
    ) {
      surface = { model };
      entryPoints = reads;
      materialBindings = declarations;
    },
    setVariants(value: typeof variants) {
      variants = value;
    },
    setReflection(value: ShaderReflection) {
      reflection = value;
    },
  };
}

it('uses the compiled storage and multisampled depth reflection for a prepared producer layout', () => {
  const owner = setup();
  const reflected: ShaderReflection = {
    schemaVersion: 'shader-reflection/3',
    uvSetCount: 0,
    boundGlobals: [
      {
        group: 0,
        binding: 2,
        addressSpace: 'storage',
        resourceKind: 'storage-buffer',
        resourceAccess: 'read-only',
        visibility: 1,
      },
      {
        group: 0,
        binding: 4,
        addressSpace: 'storage',
        resourceKind: 'storage-buffer',
        resourceAccess: 'read-write',
        visibility: 2,
      },
      {
        group: 0,
        binding: 6,
        addressSpace: 'handle',
        resourceKind: 'texture',
        resourceAccess: 'read-only',
        textureClass: 'sampled',
        sampleType: 'depth',
        viewDimension: '2d',
        multisampled: true,
        visibility: 2,
      },
    ],
  };
  owner.setReflection(reflected);
  const layout = owner.cache.getOrBuildPreparedStoragePipelineLayout('game::storage');
  expect(owner.createBindGroupLayout.mock.calls[0]?.[0].entries).toEqual([
    { binding: 2, visibility: 1, buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: 2, buffer: { type: 'storage' } },
    {
      binding: 6,
      visibility: 2,
      texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
    },
  ]);
  expect(owner.cache.getOrBuildPreparedStoragePipelineLayout('game::storage')).toBe(layout);
  owner.setReflection({
    ...reflected,
    boundGlobals: reflected.boundGlobals.map((value) =>
      value.binding === 6 ? { ...value, multisampled: false } : value,
    ),
  });
  expect(owner.cache.getOrBuildPreparedStoragePipelineLayout('game::storage')).not.toBe(layout);
  expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::storage')).not.toBe(layout);
});

it('reuses prepared layouts while still observing lookup and invalidates source and generation changes', () => {
  const owner = setup();
  owner.setSource('@group(0) @binding(0) var<uniform> view: View;');
  const first = owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  const lookups = owner.lookup.mock.calls.length;
  expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect')).toBe(first);
  expect(owner.lookup).toHaveBeenCalledTimes(lookups + 1);
  expect(owner.createPipelineLayout).toHaveBeenCalledTimes(1);
  owner.setSource('@group(0) @binding(0) var depth: texture_depth_2d;');
  owner.setBindings('render-material-with-scene-depth');
  const replacement = owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  expect(replacement).not.toBe(first);
  expect(owner.createBindGroupLayout).toHaveBeenCalledTimes(1);
  expect(owner.createPipelineLayout.mock.calls[1]?.[0].bindGroupLayouts[0]).not.toBe(owner.view);
  owner.state.preparedMaterialPipelineLayoutCache.clear();
  expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect')).not.toBe(
    replacement,
  );
});

it('keys prepared clustered graphics by the selected entry View bindings', () => {
  const owner = setup();
  owner.setEntryPoints([
    { name: 'vs_main', stage: 'vertex', bindings: [] },
    { name: 'fs_main', stage: 'fragment', bindings: [] },
  ]);
  owner.lookup.mockReturnValue(owner.lookup());
  retainViewLayout(owner.view as unknown as BindGroupLayout, [], true);
  const request = (reads: ReadonlyMap<number, number>) =>
    owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect', true, undefined, reads);

  const unlit = request(new Map());
  const lightingReads = new Map([[FORWARD_SCREEN_SURFACE_VIEW_SLOT, 2]]);
  const lit = request(lightingReads);
  expect(lit).not.toBe(unlit);
  expect(request(new Map(lightingReads))).toBe(lit);
  expect(request(new Map())).toBe(unlit);
  expect(owner.createBindGroupLayout).toHaveBeenCalledWith(
    expect.objectContaining({
      entries: [expect.objectContaining({ binding: FORWARD_SCREEN_SURFACE_VIEW_SLOT })],
    }),
  );
  expect(owner.createPipelineLayout).toHaveBeenCalledTimes(2);
});

it('selects resource meaning from the receipt even when source names suggest another layout', () => {
  const owner = setup();
  owner.setSource('@group(0) @binding(0) var misleading_depth: texture_depth_2d;');
  owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  expect(owner.createPipelineLayout.mock.calls[0]?.[0].bindGroupLayouts[0]).toBe(owner.view);
  owner.setBindings('render-material-and-scene-depth');
  owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::effect');
  expect(owner.createBindGroupLayout.mock.calls[0]?.[0].label).toContain('view-depth');
  expect(
    owner.createBindGroupLayout.mock.calls[0]?.[0].entries.map(
      (entry: GPUBindGroupLayoutEntry) => entry.binding,
    ),
  ).toEqual([0, 1]);
  expect(owner.createPipelineLayout).toHaveBeenCalledTimes(2);
});

it('keeps the complete Standard material prefix for explicit Standard particle surfaces', () => {
  const owner = setup();
  owner.setBindings('render-standard-material-and-scene-depth');
  owner.setSchema([]);
  owner.cache.getOrBuildPerShaderMaterialLayout('game::water-sphere', undefined, 'pbr', true);
  const entries: readonly BindGroupLayoutEntry[] = Array.from(
    owner.createBindGroupLayout.mock.calls[0]?.[0].entries ?? [],
  );
  expect(entries.find((entry) => entry.binding === 0)).toMatchObject({
    binding: 0,
    buffer: { type: 'uniform', hasDynamicOffset: true },
  });
  expect(entries.find((entry) => entry.binding === 17)).toMatchObject({
    binding: 17,
    buffer: { type: 'uniform', minBindingSize: 112 },
  });
  expect(entries.find((entry) => entry.binding === 20)).toMatchObject({
    binding: 20,
    sampler: { type: 'filtering' },
  });
  expect(entries.find((entry) => entry.binding === 22)).toMatchObject({
    binding: 22,
    buffer: { type: 'uniform' },
  });
  expect(entries.some((entry) => entry.binding === 47)).toBe(false);
});

it.each([
  'post-process',
  'render-material',
] as const)('rebuilds WaterInfo format layouts while preserving the %s scene ABI', (bindings) => {
  const owner = setup();
  owner.setSource('accepted-water-program');
  owner.setBindings(bindings);
  owner.setSystemInputs({ water: 'water-frame/3' });
  const entryPoints = [
    { name: 'fs_main', stage: 'fragment' as const, bindings: [{ group: 2, binding: 18 }] },
  ];
  if (bindings === 'render-material') owner.setSurfaceReads(entryPoints, []);
  else owner.setEntryPoints(entryPoints);

  const entriesFor = (layout: unknown) =>
    (layout as { descriptor: { entries: GPUBindGroupLayoutEntry[] } }).descriptor.entries;
  for (const format of ['rgba16float', 'rgba32float', 'rgba16float'] as const) {
    const layout = owner.cache.getOrBuildPreparedMaterialPipelineLayout(
      'game::water',
      false,
      format,
    );
    expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout('game::water', false, format)).toBe(
      layout,
    );
    const groups = (layout as unknown as { descriptor: { bindGroupLayouts: unknown[] } }).descriptor
      .bindGroupLayouts;
    expect(groups).toHaveLength(3);
    if (bindings === 'post-process')
      expect(entriesFor(groups[0])).toEqual(MATERIAL_POST_PROCESS_SCENE_LAYOUT.entries);
    else expect(groups[0]).toBe(owner.view);
    expect(entriesFor(groups[2])).toEqual([
      {
        binding: 18,
        visibility: 2,
        texture: {
          sampleType: format === 'rgba16float' ? 'float' : 'unfilterable-float',
          viewDimension: '2d-array',
        },
      },
    ]);
  }
  expect(owner.createPipelineLayout).toHaveBeenCalledTimes(3);
});

it('separates lighting, geometry and shader axes and reobserves changed parameter schemas', () => {
  const owner = setup();
  owner.setSchema([{ name: 'baseColorTexture', type: 'texture2d' }]);
  const first = owner.cache.getOrBuildPerShaderMaterialLayout(
    'game::effect',
    undefined,
    'pbr',
    false,
  );
  expect(first).not.toBeNull();
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'pbr', false),
  ).toBe(first);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'pbr', true),
  ).not.toBe(first);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'unlit-urp', false),
  ).not.toBe(first);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::second', undefined, 'pbr', false),
  ).not.toBe(first);
  owner.setSchema([
    { name: 'baseColorTexture', type: 'texture2d' },
    { name: 'gain', type: 'f32' },
  ]);
  expect(
    owner.cache.getOrBuildPerShaderMaterialLayout('game::effect', undefined, 'pbr', false),
  ).not.toBe(first);
});

it('projects the medium layout from canonical entry reads while retaining foam and sampled resources', () => {
  const owner = setup();
  owner.setSource('cooked-water-with-declaration-only-depth-samplers');
  owner.setSystemInputs({ water: 'water-frame/3' });
  owner.setSchema(
    Array.from({ length: 7 }, (_, index) => ({
      name: `texture${index}`,
      type: 'texture2d' as const,
    })),
  );
  const readBindings = [
    0, 1, 2, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 29, 30, 31, 32, 33, 34, 35, 46,
  ];
  owner.setSurfaceReads(
    [
      { name: 'vs_main', stage: 'vertex', bindings: [{ group: 1, binding: 0 }] },
      {
        name: 'fs_main',
        stage: 'fragment',
        bindings: readBindings.map((binding) => ({ group: 1, binding })),
      },
    ],
    Array.from({ length: 36 }, (_, binding) => binding),
  );
  owner.cache.getOrBuildPerShaderMaterialLayout('sha256:water', undefined, 'pbr', true);
  const entries = owner.createBindGroupLayout.mock.calls[0]?.[0]
    .entries as GPUBindGroupLayoutEntry[];
  expect(
    entries.map((entry: GPUBindGroupLayoutEntry) => entry.binding).sort((a, b) => a - b),
  ).toEqual(readBindings);
  expect(
    entries.filter((entry) => entry.sampler !== undefined).map((entry) => entry.binding),
  ).toEqual([1, 16, 18, 31, 33]);
  expect(entries.find((entry) => entry.binding === 34)).toMatchObject({
    visibility: 3,
    texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
  });
  expect(entries.find((entry) => entry.binding === 35)).toMatchObject({
    visibility: 3,
    buffer: { type: 'read-only-storage' },
  });
  expect(
    projectSurfaceMaterialBindings(
      Array.from({ length: 47 }, (_, binding) => ({ binding, resource: `binding-${binding}` })),
      owner.shader as never,
      'sha256:water',
    ).map((entry) => entry.binding),
  ).toEqual(readBindings);
});

it.each([
  false,
  true,
])('shares a sparse Standard Surface layout with prepared draws (ORM=%s)', (orm) => {
  const owner = setup();
  owner.setSchema([
    { name: 'roughness', type: 'f32' },
    ...(orm ? [{ name: 'orm', type: 'texture2d' as const }] : []),
    { name: 'unused', type: 'texture2d' },
  ]);
  const slots = orm ? [0, 1, 2] : [0];
  owner.setSurfaceReads(
    [
      { name: 'vs_main', stage: 'vertex', bindings: [] },
      {
        name: 'fs_main',
        stage: 'fragment',
        bindings: slots.map((binding) => ({ group: 1, binding })),
      },
    ],
    orm ? [0, 1, 2, 3, 4] : [0, 1, 2],
    'standard',
  );
  const shader = 'sha256:sparse-standard';
  const layout = owner.cache.getOrBuildPerShaderMaterialLayout(shader)?.materialBgl;
  if (layout === undefined) throw new Error('Expected a projected material layout');
  const entries = Array.from(
    owner.createBindGroupLayout.mock.calls[0]?.[0].entries as BindGroupLayoutEntry[],
  );
  expect(entries.map(({ binding }) => binding)).toEqual(slots);
  expect(entries.filter((entry) => entry.texture !== undefined)).toHaveLength(orm ? 1 : 0);

  owner.cache.getOrBuildPreparedMaterialPipelineLayout(shader);
  expect(owner.createPipelineLayout.mock.calls[1]?.[0].bindGroupLayouts[1]).toBe(layout);
  expect(
    projectMaterialLayoutEntries(layout, [0, { binding: 1 }, { binding: 2 }, { binding: 3 }]),
  ).toEqual(orm ? [0, { binding: 1 }, { binding: 2 }] : [0]);
});

it('projects a prepared Particle Mesh from its published schema and entry reads', () => {
  const owner = setup();
  owner.setSchema(PARTICLE_MESH_SURFACE_PARAM_SCHEMA);
  owner.setLayoutIdentity(derive(PARTICLE_MESH_SURFACE_PARAM_SCHEMA).layoutIdentity);
  owner.setEntryPoints([
    { name: 'vs_main', stage: 'vertex', bindings: [] },
    {
      name: 'fs_main',
      stage: 'fragment',
      bindings: [0, 1, 2].map((binding) => ({ group: 1, binding })),
    },
  ]);
  const shader = 'forgeax::vfx-render.particles.mesh-unlit';
  expect(owner.cache.getOrBuildPreparedMaterialPipelineLayout(shader)).not.toBeNull();
  const entries = owner.createBindGroupLayout.mock.calls[0]?.[0].entries as BindGroupLayoutEntry[];
  expect(entries.map(({ binding }) => binding)).toEqual([0, 1, 2]);
});

it('retains reads from every shared Surface variant and stays conservative for missing facts', () => {
  const owner = setup();
  owner.setSchema([
    { name: 'texture0', type: 'texture2d' },
    { name: 'texture1', type: 'texture2d' },
  ]);
  owner.setSurfaceReads(
    [{ name: 'fs_main', stage: 'fragment', bindings: [{ group: 1, binding: 2 }] }],
    [0, 1, 2, 3, 4, 14],
  );
  owner.setVariants([
    {
      entryPoints: [
        {
          name: 'fs_variant',
          stage: 'fragment',
          bindings: [
            { group: 1, binding: 3 },
            { group: 1, binding: 4 },
          ],
        },
      ],
    },
  ]);
  const entries = [0, 1, 2, 3, 4, 14].map((binding) => ({ binding }));
  expect(
    projectSurfaceMaterialBindings(entries, owner.shader as never, 'sha256:water').map(
      (entry) => entry.binding,
    ),
  ).toEqual([0, 2, 3, 4]);
  owner.setVariants([{}]);
  expect(projectSurfaceMaterialBindings(entries, owner.shader as never, 'sha256:water')).toEqual(
    entries,
  );
});

it('observes only an existing current material layout without constructing one on a miss', () => {
  const owner = setup();
  owner.setSchema([{ name: 'baseColorTexture', type: 'texture2d' }]);
  expect(owner.cache.lookupMaterialBindGroupLayout('game::effect')).toBeUndefined();
  expect(owner.createBindGroupLayout).not.toHaveBeenCalled();
  const layout = owner.cache.getOrBuildPerShaderMaterialLayout('game::effect');
  expect(layout).not.toBeNull();
  const created = owner.createBindGroupLayout.mock.calls.length;
  expect(owner.cache.lookupMaterialBindGroupLayout('game::effect')).toBe(layout?.materialBgl);
  owner.setSource('new accepted program');
  expect(owner.cache.lookupMaterialBindGroupLayout('game::effect')).toBeUndefined();
  expect(owner.createBindGroupLayout).toHaveBeenCalledTimes(created);
  owner.state.perShaderMaterialLayoutCache.clear();
  expect(owner.cache.lookupMaterialBindGroupLayout('game::effect')).toBeUndefined();
  expect(owner.createBindGroupLayout).toHaveBeenCalledTimes(created);
});

it('keeps custom lit parameters and native IBL slots without Standard tails', () => {
  const owner = setup();
  owner.setBindings('render-lit-material-and-scene-depth');
  const schema: readonly ParamSchemaEntry[] = [
    { name: 'wetness', type: 'f32' },
    { name: 'normalTexture', type: 'texture2d' },
    { name: 'clearcoatNormalTexture', type: 'texture2d' },
  ];
  owner.setSchema(schema);
  expect(owner.cache.getParamSchema('game::wet-hull')).toBe(schema);
  owner.cache.getOrBuildPerShaderMaterialLayout('game::wet-hull', undefined, 'pbr', true);
  const entries: readonly GPUBindGroupLayoutEntry[] =
    owner.createBindGroupLayout.mock.calls[0]?.[0].entries ?? [];
  expect(entries.map((entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(entries.find((entry) => entry.binding === 5)?.buffer).toMatchObject({
    type: 'uniform',
    minBindingSize: 112,
  });
  expect(entries.find((entry) => entry.binding === 7)?.texture?.viewDimension).toBe('2d');
  expect(entries.some((entry) => entry.binding === 46 || entry.binding === 47)).toBe(false);
});

it('binds custom material IBL from the native Skylight resource owner', () => {
  const skylight = {
    skySh: {},
    irradianceSampler: {},
    prefilterView: {},
    prefilterSampler: {},
    brdfLutView: {},
    intensityBuffer: {},
  } as unknown as SkylightBindGroupResources;
  const entries = assembleLitMaterialEntries([], skylight, 5);
  expect(entries.map((entry) => entry.binding)).toEqual([5, 6, 7, 8, 9, 10]);
  expect(entries.map((entry) => entry.resource.value)).toEqual([
    { buffer: skylight.skySh, size: 112 },
    skylight.irradianceSampler,
    skylight.prefilterView,
    skylight.prefilterSampler,
    skylight.brdfLutView,
    { buffer: skylight.intensityBuffer },
  ]);
  expect(
    assembleLitMaterialEntries(
      [],
      {
        skySh: skylight.skySh,
        irradianceSampler: skylight.irradianceSampler,
        prefilterView: skylight.prefilterView,
        prefilterSampler: skylight.prefilterSampler,
        brdfLutView: skylight.brdfLutView,
        intensityBuffer: skylight.intensityBuffer,
      },
      1,
    ).find((entry) => entry.binding === 3)?.resource.value,
  ).toBe(skylight.prefilterView);
});

it('keeps an empty lit schema free of a user UBO and permits vertex IBL reads', () => {
  const owner = setup();
  owner.setBindings('render-lit-material-and-scene-depth');
  owner.setSchema([]);
  owner.cache.getOrBuildPerShaderMaterialLayout('game::empty-lit', undefined, 'pbr', true);
  const entries: readonly GPUBindGroupLayoutEntry[] =
    owner.createBindGroupLayout.mock.calls[0]?.[0].entries ?? [];
  expect(entries.map((entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(entries[0]?.buffer).toMatchObject({ type: 'uniform', minBindingSize: 112 });
  expect(entries.every((entry) => entry.visibility === 3)).toBe(true);
  const layouts = owner.createPipelineLayout.mock.lastCall?.[0].bindGroupLayouts;
  expect(layouts?.[0]).not.toBe(owner.view);
  expect(
    owner.createBindGroupLayout.mock.lastCall?.[0].entries.some(
      (entry: GPUBindGroupLayoutEntry) =>
        entry.binding === 1 && entry.texture?.sampleType === 'depth',
    ),
  ).toBe(true);
});
