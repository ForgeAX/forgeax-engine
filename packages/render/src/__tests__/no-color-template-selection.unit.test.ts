import { ok } from '@forgeax/engine-rhi';
import {
  findVariantByKey,
  type MaterialShaderManifestEntry,
  materialShaderSource,
  materialShaderVariantsWithAxis,
  publishShaderProgramTemplates,
  type ShaderProgramCompiler,
  ShaderRegistry,
  type ShaderTemplateManifest,
} from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import {
  materialRasterSourceFacts,
  resolveMaterialShaderArtifact,
} from '../assembly/material/assembly';
import { createMaterialLayoutCache } from '../assembly/material/layout-cache';
import { selectPublishedVariant } from '../assembly/material/variant-selection';
import { selectNoColorPbrVariant } from '../assembly/material-shader-policy';
import { selectGpuDrivenSceneIndexVariant } from '../assembly/shader-prewarm-policy';
import { resolveEngineManifestEntries } from '../assembly/webgpu-ready-shaders';
import { skinnedPositionProof } from '../material-program-selection';
import { buildBindGroupLayoutDescriptor, sharedMaterialBindingDeclarations } from '../pbr-pipeline';

afterEach(() => vi.restoreAllMocks());

const profile = {
  id: 'template',
  language: 'wgsl',
  profileVersion: '1',
  adapterVersion: '1',
  compilerVersion: '1',
  nagaVersion: '1',
} as const;

async function templateFamily(axes: readonly string[]) {
  const selection = Object.fromEntries(axes.map((axis) => [axis, false]));
  const compile = vi.fn<ShaderProgramCompiler['compile']>((_template, defines) =>
    ok({
      manifestEntry: {
        hash: 'selected-native-program',
        wgsl: `// ${JSON.stringify(defines)}\n@compute @workgroup_size(1) fn main() {}`,
        bindings: '[]',
        glsl: undefined,
      },
      uvSetCount: 0,
    }),
  );
  const manifest: ShaderTemplateManifest = {
    schemaVersion: '7.0.0',
    library: publishShaderProgramTemplates(
      new Map([
        [
          'test::pbr',
          {
            schemaVersion: 'shader-program-template/1',
            compilerProfile: profile,
            source: '@compute @workgroup_size(1) fn main() {}',
            imports: {},
            axes,
          },
        ],
      ]),
    ).unwrap(),
    entries: [
      {
        hash: 'primary',
        identifier: 'forgeax::default-standard-pbr',
        program: 'test::pbr',
        selection,
      },
      {
        hash: 'unlit',
        identifier: 'forgeax::default-unlit',
        role: 'unlit',
        program: 'test::pbr',
        selection,
      },
      {
        hash: 'tonemap',
        identifier: 'test::tonemap',
        role: 'tonemap',
        program: 'test::pbr',
        selection,
      },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::default-standard-pbr',
        sourcePath: 'test::pbr',
        paramSchema: '[]',
        program: 'test::pbr',
        selection,
      },
    ],
  };
  const registry = new ShaderRegistry({
    manifestUrl: '/templates',
    readText: async () => JSON.stringify(manifest),
    programCompiler: { profile, compile },
  });
  (await registry.loadManifest()).unwrap();
  const family = registry.materialShaderManifestEntry('forgeax::default-standard-pbr');
  if (family === undefined) throw new Error('Test template family is missing');
  return { family, compile, registry };
}

it('selects a native fallback without allocating the feature matrix or compiling unselected programs', async () => {
  const { family, compile } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'ALPHA_MASK',
    'ATMOSPHERE_AVAILABLE',
    'COVERAGE_ONLY',
    'PROJECTOR_AVAILABLE',
    'CUSTOM_A',
    'CUSTOM_B',
    'CUSTOM_C',
  ]);
  // Count materialized descriptors, rather than relying on machine-specific timing.
  const freeze = vi.spyOn(Object, 'freeze');
  let selected: ReturnType<typeof selectNoColorPbrVariant>;
  let descriptors: number;
  try {
    selected = selectNoColorPbrVariant(family, true, undefined);
    descriptors = freeze.mock.calls.filter(
      ([value]) =>
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'definesKey'),
    ).length;
  } finally {
    freeze.mockRestore();
  }
  expect(descriptors).toBeLessThanOrEqual(1);
  expect(selected?.defines).toEqual({
    STORAGE_BUFFER_AVAILABLE: true,
    VERTEX_COLOR_AVAILABLE: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    ALPHA_MASK: false,
    ATMOSPHERE_AVAILABLE: false,
    COVERAGE_ONLY: false,
    PROJECTOR_AVAILABLE: true,
    CUSTOM_A: true,
    CUSTOM_B: true,
    CUSTOM_C: true,
  });
  expect(compile).not.toHaveBeenCalled();
  if (selected === undefined) throw new Error('Test fallback selection is missing');
  expect(findVariantByKey(family, selected.definesKey)).toBe(selected);
  expect(materialShaderSource(selected).read()).toContain('@compute');
  expect(selected.uvSetCount).toBe(0);
  expect(compile).toHaveBeenCalledTimes(1);
});

it.each([
  'source facts',
  'gameplay lookup',
  'skin bounds',
  'storage layout',
] as const)('reads one template declaration without expanding the family for %s', async (consumer) => {
  const axes = Array.from({ length: 8 }, (_, i) => `CUSTOM_${i}`);
  const { registry, compile } = await templateFamily(axes);
  const id = 'forgeax::default-standard-pbr';
  const prepare = vi.fn(() => false);
  const freeze = vi.spyOn(Object, 'freeze');
  let descriptors: number;
  try {
    if (consumer === 'source facts') materialRasterSourceFacts(registry, id, { variantSet: '' });
    else if (consumer === 'gameplay lookup') {
      vi.spyOn(registry, 'isSourceBackedMaterialArtifact').mockReturnValue(true);
      expect(
        resolveMaterialShaderArtifact(id, registry, { variantSet: '' }, prepare),
      ).toBeUndefined();
      expect(prepare).toHaveBeenCalledOnce();
    } else if (consumer === 'storage layout') {
      const unexpected = (): never => {
        throw new Error('Missing variant reached device setup');
      };
      const reportError = vi.fn();
      const layouts = createMaterialLayoutCache({
        getShader: () => registry,
        currentBuildDevice: unexpected,
        currentPipelineState: unexpected,
        currentPipelineCacheState: unexpected,
        viewAndSceneDepthLayoutEntries: unexpected,
        reportError,
      });
      expect(layouts.getOrBuildPreparedStoragePipelineLayout(id, 'UNKNOWN=false')).toBeNull();
      expect(reportError).toHaveBeenCalledOnce();
    } else expect(skinnedPositionProof(undefined, id, registry)).toBe(false);
    descriptors = freeze.mock.calls.filter(
      ([value]) =>
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'definesKey'),
    ).length;
  } finally {
    freeze.mockRestore();
  }
  expect(descriptors).toBeLessThanOrEqual(1);
  expect(compile).not.toHaveBeenCalled();
});

it('visits only requested template rows and preserves strict sparse legacy axis matches', async () => {
  const { family, compile } = await templateFamily(['CUSTOM_A', 'CUSTOM_B', 'CUSTOM_C']);
  const freeze = vi.spyOn(Object, 'freeze');
  const visited = materialShaderVariantsWithAxis(family, 'CUSTOM_A', false);
  const first = visited.next().value;
  expect(first?.defines).toEqual({ CUSTOM_A: false, CUSTOM_B: true, CUSTOM_C: true });
  expect(
    freeze.mock.calls.filter(
      ([row]) => row && typeof row === 'object' && Object.hasOwn(row, 'definesKey'),
    ),
  ).toHaveLength(1);
  const rest = [...visited];
  expect(rest).toHaveLength(3);
  expect([...materialShaderVariantsWithAxis(family, 'MISSING', false)]).toEqual([]);
  expect(compile).not.toHaveBeenCalled();
  const legacy = { variants: [{ defines: {} }, ...rest] } as MaterialShaderManifestEntry;
  expect([...materialShaderVariantsWithAxis(legacy, 'CUSTOM_A', false)]).toEqual(rest);
});

it('publishes only the winning row of an ambiguous raster request', async () => {
  const { family, compile } = await templateFamily([
    'VERTEX_COLOR_AVAILABLE',
    'STORAGE_BUFFER_AVAILABLE',
    'PROBE_BLEND_AVAILABLE',
    'TRANSMISSION_AVAILABLE',
    'CUSTOM_A',
    'CUSTOM_B',
    'CUSTOM_C',
  ]);
  const freeze = vi.spyOn(Object, 'freeze');
  const selected = selectPublishedVariant(family, { vertexColorAvailable: false });
  expect(selected?.defines).toEqual({
    VERTEX_COLOR_AVAILABLE: false,
    STORAGE_BUFFER_AVAILABLE: true,
    PROBE_BLEND_AVAILABLE: false,
    TRANSMISSION_AVAILABLE: false,
    CUSTOM_A: false,
    CUSTOM_B: false,
    CUSTOM_C: false,
  });
  expect(
    freeze.mock.calls.filter(
      ([row]) => row && typeof row === 'object' && Object.hasOwn(row, 'definesKey'),
    ),
  ).toHaveLength(1);
  expect(compile).not.toHaveBeenCalled();
});

it('requires both geometry capability axes on native fallback families', async () => {
  const { family, compile } = await templateFamily(['VERTEX_COLOR_AVAILABLE']);
  expect(selectNoColorPbrVariant(family, true, undefined)).toBeUndefined();
  expect(compile).not.toHaveBeenCalled();
});

it('patches ready-device boot programs without enumerating native feature families', async () => {
  const { registry, compile } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'ALPHA_MASK',
    'ATMOSPHERE_AVAILABLE',
    'COVERAGE_ONLY',
    'SKINNING_DISABLED',
    'PROJECTOR_AVAILABLE',
    'CUSTOM_A',
    'CUSTOM_B',
  ]);
  const freeze = vi.spyOn(Object, 'freeze');
  let descriptors: number;
  let entries: ReturnType<typeof resolveEngineManifestEntries>;
  try {
    entries = resolveEngineManifestEntries(registry, [...registry.entries()], 'null', {
      storageBuffer: true,
      webgl2Downlevel: false,
      atmosphere: false,
      extendedLighting: true,
      directionalPcss: true,
      projector: true,
    });
    descriptors = freeze.mock.calls.filter(
      ([value]) =>
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'definesKey'),
    ).length;
  } finally {
    freeze.mockRestore();
  }
  expect(descriptors).toBeLessThanOrEqual(1);
  expect(compile).not.toHaveBeenCalled();
  expect(entries.pbr.defines).toMatchObject({
    STORAGE_BUFFER_AVAILABLE: true,
    VERTEX_COLOR_AVAILABLE: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    SKINNING_DISABLED: true,
    PROJECTOR_AVAILABLE: true,
  });
});

it.each([
  false,
  true,
])('retains compiled boot selection at storage capability %s', async (storageBuffer) => {
  const axes = [
    'STORAGE_BUFFER_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'SKINNING_DISABLED',
    'ATMOSPHERE_AVAILABLE',
    'EXTENDED_LIGHTING_AVAILABLE',
    'PROJECTOR_AVAILABLE',
  ];
  const { registry, family } = await templateFamily(axes);
  const compiled = {
    identifier: family.identifier,
    sourcePath: family.sourcePath,
    paramSchema: family.paramSchema,
    composedWgsl: '',
    variants: family.variants,
  };
  const legacyRegistry = {
    materialShaderManifestEntries: () => [compiled],
    materialShaderManifestEntry: (identifier: string) =>
      identifier === compiled.identifier ? compiled : undefined,
  } as unknown as ShaderRegistry;
  const flat = [
    {
      hash: 'pbr',
      identifier: family.identifier,
      wgsl: '',
      glsl: '',
      bindings: '',
      role: 'pbr' as const,
    },
    { hash: 'unlit', wgsl: '', glsl: '', bindings: '', role: 'unlit' as const },
    { hash: 'tonemap', wgsl: '', glsl: '', bindings: '', role: 'tonemap' as const },
  ];
  const caps = {
    storageBuffer,
    webgl2Downlevel: !storageBuffer,
    atmosphere: false,
    extendedLighting: false,
    directionalPcss: false,
    projector: true,
  };
  const native = resolveEngineManifestEntries(registry, [...registry.entries()], 'null', caps);
  const legacy = resolveEngineManifestEntries(legacyRegistry, flat, 'null', caps);
  expect(native.pbr.wgsl).toEqual(legacy.pbr.wgsl);
});

it('selects a native GPU scene-index boot lane without allocating unrelated variants', async () => {
  const { family, compile } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'ALPHA_MASK',
    'COVERAGE_ONLY',
    'PROJECTOR_AVAILABLE',
    'CLIPPING_PLANES',
    'LOD_DITHER',
    'WATER_WAVES_AVAILABLE',
    'WATER_INFO_RGBA16',
    'CUSTOM_A',
    'CUSTOM_B',
    'CUSTOM_C',
  ]);
  const freeze = vi.spyOn(Object, 'freeze');
  let selected: ReturnType<typeof selectGpuDrivenSceneIndexVariant>;
  let descriptors: number;
  try {
    selected = selectGpuDrivenSceneIndexVariant(family, true, true, true);
    descriptors = freeze.mock.calls.filter(
      ([value]) =>
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'definesKey'),
    ).length;
  } finally {
    freeze.mockRestore();
  }
  expect(descriptors).toBeLessThanOrEqual(1);
  expect(selected?.defines).toMatchObject({
    STORAGE_BUFFER_AVAILABLE: true,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
    VERTEX_COLOR_AVAILABLE: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    ALPHA_MASK: false,
    COVERAGE_ONLY: false,
    PROJECTOR_AVAILABLE: true,
    CLIPPING_PLANES: false,
    LOD_DITHER: false,
    WATER_WAVES_AVAILABLE: false,
    WATER_INFO_RGBA16: false,
    CUSTOM_A: false,
    CUSTOM_B: false,
    CUSTOM_C: false,
  });
  expect(compile).not.toHaveBeenCalled();
});

it('recognizes a native shared layout family without expanding or composing its variants', async () => {
  const { registry, compile } = await templateFamily(['STORAGE_BUFFER_AVAILABLE', 'CUSTOM_A']);
  const freeze = vi.spyOn(Object, 'freeze');
  let descriptors: number;
  try {
    expect(
      sharedMaterialBindingDeclarations(registry, 'forgeax::default-standard-pbr'),
    ).toBeUndefined();
    descriptors = freeze.mock.calls.filter(
      ([value]) =>
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'definesKey'),
    ).length;
  } finally {
    freeze.mockRestore();
  }
  expect(descriptors).toBe(0);
  expect(compile).not.toHaveBeenCalled();
});

it('retains cooked family backdrop bindings below the dedicated transmission budget', async () => {
  const { registry } = await templateFamily([]);
  registry.installMaterialArtifact('game::cooked-transmission', {
    source:
      '@group(1) @binding(0) var<uniform> tint: vec4<f32>; @group(1) @binding(8) var backdrop: texture_2d<f32>; @fragment fn fs_main() -> @location(0) vec4<f32> { return tint + textureLoad(backdrop, vec2<i32>(0), 0); }',
    paramSchema: [],
  });
  const family = {
    identifier: 'game::cooked-transmission',
    sourcePath: 'game::cooked-transmission',
    composedWgsl: '',
    paramSchema: '[]',
    variants: [false, true].map((clipping) => ({
      definesKey: `CLIPPING_PLANES=${clipping}`,
      defines: { CLIPPING_PLANES: clipping },
      composedWgsl: '',
      entryPoints: [
        {
          name: 'fs_main',
          stage: 'fragment' as const,
          bindings: [
            { group: 1, binding: 0 },
            { group: 1, binding: clipping ? 12 : 8 },
          ],
        },
      ],
    })),
  };
  const manifest = vi.spyOn(registry, 'materialShaderManifestEntry').mockReturnValue(family);
  expect(sharedMaterialBindingDeclarations(registry, family.identifier)).toEqual([0, 8, 12]);
  const layout = buildBindGroupLayoutDescriptor(
    {
      shader: { id: family.identifier, passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    },
    {
      kind: 'pbr-material-merged',
      registry,
      materialParamSchema: [],
      caps: { storageBuffer: true, transmissionBackdrop: false },
    },
  );
  expect(layout.entries.some(({ binding }) => binding === 8)).toBe(true);
  const first = family.variants[0];
  if (first === undefined) throw new Error('Cooked family variant missing');
  const { entryPoints: _entries, ...unproven } = first;
  manifest.mockReturnValue({ ...family, variants: [unproven] });
  expect(sharedMaterialBindingDeclarations(registry, family.identifier)).toBeUndefined();
  manifest.mockReturnValue(family);
  expect(
    sharedMaterialBindingDeclarations(registry, 'forgeax::default-standard-pbr'),
  ).toBeUndefined();
});

it('retains declared backdrop bindings without resolving unused runtime coverage programs', () => {
  const registry = new ShaderRegistry({});
  const identifier = 'game::runtime-coverage';
  const source =
    '@group(1) @binding(0) var<uniform> tint: vec4<f32>; @group(1) @binding(7) var backdropSampler: sampler; @group(1) @binding(8) var backdrop: texture_2d<f32>; @fragment fn fs_main() -> @location(0) vec4<f32> { return tint + textureSample(backdrop, backdropSampler, vec2<f32>(0.5)); }';
  registry.installMaterialArtifact(identifier, {
    source,
    paramSchema: [],
    entryPoints: [{ name: 'fs_main', stage: 'fragment', bindings: [{ group: 1, binding: 0 }] }],
  });
  const select = vi.fn((_lod: boolean) => identifier);
  registry.installMaterialTemplateVariants(
    identifier,
    [false, true].map((lod) => ({
      defines: { LOD_DITHER: lod },
      select: () => select(lod),
    })),
  );
  expect(sharedMaterialBindingDeclarations(registry, identifier)).toEqual([0, 7, 8]);
  const layout = buildBindGroupLayoutDescriptor(
    {
      shader: { id: identifier, passKind: 'forward', variantSet: undefined },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    },
    {
      kind: 'pbr-material-merged',
      registry,
      materialParamSchema: [],
      caps: { storageBuffer: true, transmissionBackdrop: false },
    },
  );
  expect(layout.entries.map(({ binding }) => binding)).toEqual(expect.arrayContaining([7, 8]));
  expect(select).not.toHaveBeenCalled();
  const row = registry.materialShaderManifestEntry(identifier);
  if (row === undefined) throw new Error('Runtime coverage family missing');
  const selected = findVariantByKey(row, '');
  if (selected === undefined) throw new Error('Requested LOD program missing');
  expect(materialShaderSource(selected).read()).toBe(source);
  expect(select.mock.calls).toEqual([[true]]);
});

it('ranks an unkeyed native material without expanding its feature table', async () => {
  const { family, compile } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'ALPHA_MASK',
    'COVERAGE_ONLY',
    'PROJECTOR_AVAILABLE',
    'CUSTOM_A',
    'CUSTOM_B',
    'CUSTOM_C',
  ]);
  const freeze = vi.spyOn(Object, 'freeze');
  let selected: ReturnType<typeof selectPublishedVariant>;
  let descriptors: number;
  try {
    selected = selectPublishedVariant(family, { vertexColorAvailable: false });
    descriptors = freeze.mock.calls.filter(
      ([value]) =>
        value !== null && typeof value === 'object' && Object.hasOwn(value, 'definesKey'),
    ).length;
  } finally {
    freeze.mockRestore();
  }
  expect(descriptors).toBeLessThanOrEqual(20);
  expect(selected?.defines).toMatchObject({
    STORAGE_BUFFER_AVAILABLE: true,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
    CLUSTER_FORWARD_AVAILABLE: false,
    VERTEX_COLOR_AVAILABLE: false,
    ALPHA_MASK: false,
    COVERAGE_ONLY: false,
    CUSTOM_A: false,
    CUSTOM_B: false,
    CUSTOM_C: false,
    PROJECTOR_AVAILABLE: false,
  });
  expect(compile).not.toHaveBeenCalled();
});

it.each([
  {},
  { vertexColorAvailable: true },
  { clustered: true },
  { probeBlend: true },
  { address: 'direct' as const },
  { vertexColorAvailable: false, alphaMask: true },
])('retains the compiled material preference result for %o', async (options) => {
  const { family, compile } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'PROBE_BLEND_AVAILABLE',
    'TRANSMISSION_AVAILABLE',
    'ALPHA_MASK',
    'CUSTOM_A',
  ]);
  const expected = selectPublishedVariant(
    {
      identifier: family.identifier,
      sourcePath: family.sourcePath,
      paramSchema: family.paramSchema,
      composedWgsl: '',
      variants: family.variants,
    },
    options,
  );
  expect(selectPublishedVariant(family, options)?.definesKey).toBe(expected?.definesKey);
  expect(compile).not.toHaveBeenCalled();
});

it('keeps the canonical all-true key first when all preference scores tie', async () => {
  const { family } = await templateFamily(['CUSTOM_A', 'CUSTOM_B']);
  expect(selectPublishedVariant(family, {})?.definesKey).toBe('');
});

it.each([
  { leanInputs: true, address: 'direct' as const },
  { leanInputs: true, address: 'scene-index' as const },
  { leanInputs: true, visibleSurface: true },
])('preserves native lean-input fallback ordering for %o', async (options) => {
  const { family } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'STANDARD_LEAN_INPUTS',
    'VISIBLE_SURFACE_AVAILABLE',
    'ALPHA_MASK',
    'COVERAGE_ONLY',
  ]);
  const expected = selectPublishedVariant(
    {
      identifier: family.identifier,
      sourcePath: family.sourcePath,
      paramSchema: family.paramSchema,
      composedWgsl: '',
      variants: family.variants,
    },
    options,
  );
  expect(selectPublishedVariant(family, options)?.definesKey).toBe(expected?.definesKey);
});

it('selects partial native discard constraints with geometry facts without compiling a feature matrix', async () => {
  const { family, compile } = await templateFamily([
    'STORAGE_BUFFER_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'CLUSTER_FORWARD_AVAILABLE',
    'ALPHA_MASK',
    'COVERAGE_ONLY',
    'CLIPPING_PLANES',
    'LOD_DITHER',
  ]);
  const selected = selectPublishedVariant(family, {
    variantSet: 'CLIPPING_PLANES=false+LOD_DITHER=false',
    vertexColorAvailable: false,
    clustered: false,
    alphaMask: true,
    address: 'direct',
  });
  expect(selected?.defines).toMatchObject({
    CLIPPING_PLANES: false,
    LOD_DITHER: false,
    VERTEX_COLOR_AVAILABLE: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    ALPHA_MASK: true,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
    COVERAGE_ONLY: false,
  });
  expect(
    selectPublishedVariant(family, { variantSet: 'ALPHA_MASK=false', alphaMask: true }),
  ).toBeUndefined();
  expect(selectPublishedVariant(family, { variantSet: 'MISSING_AXIS=false' })).toBeUndefined();
  expect(compile).not.toHaveBeenCalled();
});

it('keeps the fallback direct layout free of scene-index and discard bindings', async () => {
  const axes = [
    'STORAGE_BUFFER_AVAILABLE',
    'VERTEX_COLOR_AVAILABLE',
    'GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
    'LOD_DITHER',
    'CLIPPING_PLANES',
  ];
  const { family } = await templateFamily(axes);
  const native = selectNoColorPbrVariant(family, true, undefined);
  expect(native?.defines).toEqual({
    STORAGE_BUFFER_AVAILABLE: true,
    VERTEX_COLOR_AVAILABLE: false,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
    LOD_DITHER: false,
    CLIPPING_PLANES: false,
  });
  const base = { STORAGE_BUFFER_AVAILABLE: true, VERTEX_COLOR_AVAILABLE: false };
  const variants = [
    {
      definesKey: 'unsafe',
      defines: {
        ...base,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
        LOD_DITHER: true,
        CLIPPING_PLANES: true,
      },
      composedWgsl: 'scene-index',
    },
    {
      definesKey: 'direct',
      defines: {
        ...base,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
        LOD_DITHER: false,
        CLIPPING_PLANES: false,
      },
      composedWgsl: 'direct',
    },
  ];
  const compiled = { variants } as unknown as Parameters<typeof selectNoColorPbrVariant>[0];
  expect(selectNoColorPbrVariant(compiled, true, undefined)).toBe(variants[1]);
  expect(
    selectNoColorPbrVariant(
      compiled,
      true,
      'GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+LOD_DITHER=true+CLIPPING_PLANES=true',
    ),
  ).toBe(variants[0]);
});

it('selects a published variant without rereading the roster per request axis', () => {
  const direct = {
    definesKey: 'direct',
    defines: { GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false, CLUSTER_FORWARD_AVAILABLE: false },
    composedWgsl: '',
  };
  const indexed = {
    definesKey: 'indexed',
    defines: { GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true, CLUSTER_FORWARD_AVAILABLE: true },
    composedWgsl: '',
  };
  const variants = [direct, indexed] as MaterialShaderManifestEntry['variants'];
  const read = vi.fn(() => variants);
  const family = {
    identifier: 'game::published',
    sourcePath: '',
    paramSchema: '',
    composedWgsl: '',
    get variants() {
      return read();
    },
  };
  expect(selectPublishedVariant(family, { address: 'scene-index', clustered: true })).toBe(indexed);
  // One pass to read the roster and one to discover axes for an unsealed caller.
  expect(read).toHaveBeenCalledTimes(2);
});

it('evaluates published lean fallback before discarding coverage-only selections', () => {
  const general = {
    definesKey: 'general',
    defines: { STANDARD_LEAN_INPUTS: false },
    composedWgsl: '',
  };
  const coverage = {
    definesKey: 'coverage',
    defines: { STANDARD_LEAN_INPUTS: true, COVERAGE_ONLY: true },
    composedWgsl: '',
  };
  const family: MaterialShaderManifestEntry = {
    identifier: 'game::published',
    sourcePath: '',
    paramSchema: '',
    composedWgsl: '',
    variants: [general, coverage] as MaterialShaderManifestEntry['variants'],
  };
  expect(selectPublishedVariant(family, { leanInputs: true })).toBeUndefined();
  expect(selectPublishedVariant(family, { leanInputs: false })).toBe(general);
  expect(
    selectPublishedVariant(
      { ...family, variants: [general] as typeof family.variants },
      {
        leanInputs: true,
      },
    ),
  ).toBe(general);
});
