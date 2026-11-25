import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  FIELD_VISIBILITY_BOUNDS_WGSL,
  SCREEN_PROBE_RECONSTRUCTION_WGSL,
} from '@forgeax/engine-shader';
import {
  SURFACE_SLOT_MODULE,
  terrainProgramSource,
  waterDeformationAbiSource,
} from '@forgeax/engine-shader-compiler';

export { SURFACE_SLOT_MODULE } from '@forgeax/engine-shader-compiler';

import {
  assertMaterialAsset,
  type MaterialDeformationDeclaration,
  type MaterialProgram,
  type MaterialSurfaceModel,
  type ShaderProgramContract,
  WATER_DEFORMATION_INPUTS,
  WATER_DEFORMATION_VERSION,
} from '@forgeax/engine-types';

const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

export interface EngineShaderFile {
  readonly id: string;
  readonly defines?: Readonly<Record<string, boolean>>;
  readonly source: string;
  readonly reservedIdentifier?: string | undefined;
  readonly program?: MaterialProgram;
  /** Engine-owned fixed Surface composition, prepared only at build time. */
  readonly surfaceModule?: string;
  readonly surfaceModel?: MaterialSurfaceModel;
  readonly deformation?: MaterialDeformationDeclaration;
  /** Non-reflectable numerical and output-format facts published with this WGSL entry. */
  readonly programContract?: ShaderProgramContract;
}

const RESAMPLE_NUMERICAL_CONTRACT = Object.freeze({
  intermediatePrecision: 'f32',
  outputRange: [0, 1],
  reduction: 'box2x2-mean',
  mipLevelCount: 9,
  quantization: 'unorm8',
} as const);

const RESAMPLE_COMPUTE_PROGRAM_CONTRACT = {
  schemaVersion: 'shader-program-contract/1',
  colorTargets: [],
  publicationFormat: 'rgba8unorm',
  numerical: RESAMPLE_NUMERICAL_CONTRACT,
} satisfies ShaderProgramContract;

const RESAMPLE_FRAGMENT_PROGRAM_CONTRACT = {
  schemaVersion: 'shader-program-contract/1',
  colorTargets: [
    { location: 0, format: 'rgba32float', numericType: 'float' },
    { location: 1, format: 'rgba8unorm', numericType: 'float' },
  ],
  publicationFormat: 'rgba8unorm',
  numerical: RESAMPLE_NUMERICAL_CONTRACT,
} satisfies ShaderProgramContract;

export function extractDefineImportPath(source: string): string | undefined {
  return DEFINE_IMPORT_PATH_RE.exec(source)?.[1];
}

/** Project the engine default Surface into the Standard slot identity. */
export function projectSurfaceSlotSource(source: string): string {
  return source.replace(
    /^\s*#define_import_path\s+[^\n]+/m,
    `#define_import_path ${SURFACE_SLOT_MODULE}`,
  );
}

async function resolveEntries<T extends Record<string, unknown>>(
  entries: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const resolved = await Promise.all(
    Object.entries(entries).map(async ([key, value]) => [key, await value]),
  );
  // Object.entries retains every own key; each value is resolved without changing its shape.
  return Object.fromEntries(resolved) as { [K in keyof T]: Awaited<T[K]> };
}

/** The same source bytes used by Standard and the Build-only cloud material probe. */
const readShaderText = (path: string): Promise<string> => readFile(path, 'utf8');

export async function loadCloudDensityModules(readText = readShaderText) {
  const require = createRequire(import.meta.url);
  const srcDir = resolve(dirname(require.resolve('@forgeax/engine-shader/package.json')), 'src');
  const modules = {
    'forgeax_cloud::coordinates': resolve(srcDir, 'cloud/coordinates.wgsl'),
    'forgeax_cloud::medium': resolve(srcDir, 'cloud/medium.wgsl'),
  } as const;
  const coordinates = await readText(modules['forgeax_cloud::coordinates']);
  const medium = await readText(modules['forgeax_cloud::medium']);
  const imports = { 'forgeax_cloud::coordinates': coordinates, 'forgeax_cloud::medium': medium };
  const identity = createHash('sha256').update(JSON.stringify(imports)).digest('hex');
  return { imports, identity, sourcePaths: Object.values(modules) };
}

/** Load canonical Engine shader entries and their import closure. */
export async function loadCloudRendererModules(readText = readShaderText) {
  const engine = await loadEngineShaderEntries(readText);
  const require = createRequire(import.meta.url);
  const srcDir = resolve(dirname(require.resolve('@forgeax/engine-shader/package.json')), 'src');
  const names = await readdir(srcDir);
  const cloudNames = await readdir(resolve(srcDir, 'cloud'));
  return {
    imports: engine.imports,
    sourcePaths: [
      ...names.filter((name) => name.endsWith('.wgsl')).map((name) => resolve(srcDir, name)),
      ...cloudNames
        .filter((name) => name.endsWith('.wgsl'))
        .map((name) => resolve(srcDir, 'cloud', name)),
    ],
  };
}

/** Load canonical Engine shader entries and their import closure. */
export async function loadEngineShaderEntries(readText = readShaderText) {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@forgeax/engine-shader/package.json');
  const srcDir = resolve(dirname(packageJsonPath), 'src');
  const sourceReads = new Map<string, Promise<string>>();
  const readSource = (fileName: string): Promise<string> => {
    let source = sourceReads.get(fileName);
    if (source === undefined) {
      source = readText(resolve(srcDir, fileName));
      sourceReads.set(fileName, source);
    }
    return source;
  };
  const readEntry = (
    fileName: string,
    reservedIdentifier?: string,
    defines?: Readonly<Record<string, boolean>>,
  ): Promise<EngineShaderFile> =>
    readSource(fileName).then((source) => ({
      id: resolve(srcDir, fileName),
      source,
      ...(defines === undefined ? {} : { defines }),
      ...(reservedIdentifier === undefined ? {} : { reservedIdentifier }),
    }));
  const readFragmentEntry = (fileName: string, identifier: string): Promise<EngineShaderFile> =>
    readEntry(fileName, identifier, { PORTABLE_FRAGMENT: true }).then((file) => ({
      ...file,
      id: `${file.id}?portable-fragment`,
    }));
  const gbufferEntry = (
    file: EngineShaderFile,
    compactGbuffer?: ShaderProgramContract['compactGbuffer'],
  ): EngineShaderFile => ({
    ...file,
    programContract: {
      ...file.programContract,
      schemaVersion: 'shader-program-contract/1',
      gbuffer: 'standard-gbuffer/2',
      ...(compactGbuffer === undefined ? {} : { compactGbuffer }),
    },
  });
  const compactGbufferEntry = (file: EngineShaderFile): EngineShaderFile =>
    gbufferEntry(file, 'standard-gbuffer/4');
  const readGBufferEntry = (...args: Parameters<typeof readEntry>) =>
    readEntry(...args).then(gbufferEntry);
  const readGBufferFragmentEntry = (...args: Parameters<typeof readFragmentEntry>) =>
    readFragmentEntry(...args).then(gbufferEntry);
  const density = loadCloudDensityModules(readText);
  const cloudSampled = Promise.all(
    [false, true].map(async (detail) => {
      const { identity } = await density;
      const entry = await readEntry(
        'cloud/sampled-view.wgsl',
        `forgeax::cloud-sampled-view-${identity}-${detail ? 1 : 0}`,
      );
      return {
        ...entry,
        id: `${entry.id}?detail=${detail}`,
        source: `${entry.source}
const CLOUD_DETAIL: bool = ${detail};
`,
      };
    }),
  );
  const terrainEntries = Promise.all(
    ['', '-ids', '-detail'].flatMap((suffix) =>
      [false, true].map(async (shadow) => {
        const file = await readEntry(shadow ? 'shadow_caster.wgsl' : 'default-standard-pbr.wgsl');
        const identifier = `forgeax::standard-terrain${suffix}${shadow ? '-shadow' : ''}`;
        const composition = terrainProgramSource(identifier);
        if (composition === undefined)
          throw new Error(`Unknown Terrain composition: ${identifier}`);
        // Terrain surfaces never alpha-test; only the shadow composition keeps
        // the ALPHA_MASK axis it shares with the Standard shadow caster.
        // Terrain keeps its unconditional discards (view clipping, temporal
        // LOD coverage) instead of the Standard discard-source axes, as before
        // those axes existed. Temporary until material static switches.
        const fixed: Readonly<Record<string, boolean>> = shadow
          ? composition.defines
          : { ...composition.defines, ALPHA_MASK: false, LOD_DITHER: true, CLIPPING_PLANES: true };
        return {
          ...file,
          id: `${file.id}?terrain=${suffix === '' ? 'weights' : suffix.slice(1)}${shadow ? '-shadow' : ''}`,
          reservedIdentifier: identifier,
          surfaceModule: composition.surface,
          source: file.source.replace(/^#pragma variant_axis (\w+)\s*$/gm, (line, axis: string) =>
            Object.hasOwn(fixed, axis) ? '' : line,
          ),
          defines: fixed,
        } satisfies EngineShaderFile;
      }),
    ),
  );
  const entries = {
    defaultStandardPbr: readEntry('default-standard-pbr.wgsl', 'forgeax::default-standard-pbr'),
    defaultStandardPbrSkin: readEntry('default-standard-pbr-skin.wgsl', 'forgeax::pbr-skin'),
    singleLayerMedium: readEntry('single-layer-medium.wgsl', 'forgeax::single-layer-medium'),
    singleLayerWater: readEntry('single-layer-water.wgsl', 'forgeax::single-layer-water', {
      WATER_WAVES_AVAILABLE: true,
      MATERIAL_WATER_DEFORMATION_AVAILABLE: true,
      WATER_ENABLE_WAVES: true,
      WATER_USE_INFO: true,
      WATER_USE_BAKED_SIMULATION: false,
      WATER_USE_FIXED_VELOCITY: false,
      WATER_USE_FIXED_HEIGHT: false,
      WATER_USE_FIXED_DEPTH: false,
      WATER_BAKED_HEIGHT_DEPTH_AVAILABLE: false,
      WATER_HEIGHT_MAPPING_AVAILABLE: true,
      WATER_USE_REFRACTION: true,
      WATER_USE_REFLECTIONS: true,
      WATER_USE_SSR: true,
    }).then((file) => ({
      ...file,
      surfaceModel: 'single-layer-water' as const,
      surfaceModule: 'forgeax_material::default_single_layer_water_surface',
      deformation: {
        module: 'forgeax_material::water_deformation_default',
        version: WATER_DEFORMATION_VERSION,
        inputs: WATER_DEFORMATION_INPUTS,
      },
    })),
    waterInfoRasterWater: readEntry(
      'water-info-raster-water.wgsl',
      'forgeax::water-info-raster-water',
    ).then((file) => ({
      ...file,
      program: {
        module: 'forgeax_material::water_info_raster_water',
        bindings: 'group-0' as const,
      },
    })),
    waterMeshRaster: readEntry('water-mesh-raster.wgsl', 'forgeax::water-mesh-raster').then(
      (file) => ({
        ...file,
        program: { module: 'forgeax_material::water_mesh_raster', bindings: 'group-0' as const },
      }),
    ),
    waterMeshPrecise: readEntry('water-mesh-precise.wgsl', 'forgeax::water-mesh-precise'),
    waterMeshPreciseMsaa: readEntry('water-mesh-precise.wgsl', 'forgeax::water-mesh-precise-msaa', {
      WATER_PRECISE_MSAA: true,
    }).then((file) => ({ ...file, id: `${file.id}#msaa` })),
    waterInfoRasterGround: readEntry(
      'water-info-raster-ground.wgsl',
      'forgeax::water-info-raster-ground',
    ).then((file) => ({
      ...file,
      program: {
        module: 'forgeax_material::water_info_raster_ground',
        bindings: 'group-0' as const,
      },
    })),
    waterInfoRasterDilation: readEntry(
      'water-info-raster-dilation.wgsl',
      'forgeax::water-info-raster-dilation',
    ).then((file) => ({
      ...file,
      program: {
        module: 'forgeax_material::water_info_raster_dilation',
        bindings: 'group-0' as const,
      },
    })),
    unlit: readEntry('unlit.wgsl', 'forgeax::default-unlit'),
    pointsLines: readEntry('points-lines.wgsl', 'forgeax::points-lines'),
    tonemap: readEntry('tonemap.wgsl'),
    standardOutputV2: readEntry('standard-output-v2.wgsl', 'forgeax::standard-output-v2'),
    analyticFog: readEntry('analytic-fog.wgsl', 'forgeax::analytic-fog'),
    cloudLayer: readEntry('cloud.wgsl'),
    cloudAnalytic: readEntry('cloud/analytic-view.wgsl', 'forgeax::cloud-analytic-view'),
    cloudShadowFilter: readEntry('cloud/shadow-filter.wgsl', 'forgeax::cloud-shadow-filter'),
    cloudMode0Reconstruct: readEntry(
      'cloud/mode0-reconstruct.wgsl',
      'forgeax::cloud-mode0-reconstruct',
    ),
    cloudMode0Compose: readEntry('cloud/mode0-compose.wgsl', 'forgeax::cloud-mode0-compose'),
    taaResolve: readEntry('taa-resolve.wgsl'),
    motionBlur: readEntry('motion-blur.wgsl'),
    depthOfField: readEntry('depth-of-field.wgsl'),
    depthOfFieldMsaa: readEntry('depth-of-field-msaa.wgsl'),
    shadowCaster: readEntry('shadow_caster.wgsl', 'forgeax::default-shadow-caster', {
      STANDARD_STOCK_SURFACE_AVAILABLE: true,
    }),
    sprite: readEntry('sprite.wgsl', 'forgeax::sprite'),
    spriteLit: readEntry('sprite-lit.wgsl', 'forgeax::sprite-lit'),
    msdfText: readEntry('msdf-text.wgsl', 'forgeax::msdf-text'),
    iblEquirectToCube: readEntry('ibl-equirect-to-cube.wgsl'),
    iblPrefilter: readEntry('ibl-prefilter.wgsl'),
    iblBrdfLut: readEntry('ibl-brdf-lut.wgsl'),
    probeBackground: readEntry('ibl-probe-background.wgsl'),
    fxaa: readEntry('fxaa.wgsl'),
    bloomHorizontal: readEntry('bloom-horizontal.wgsl'),
    bloomVertical: readEntry('bloom-vertical.wgsl'),
    bloomComposite: readEntry('bloom-composite.wgsl'),
    volumeInject: readEntry('volume/volume-inject.wgsl'),
    volumeTemporal: readEntry('volume/volume-temporal.wgsl'),
    volumeIntegrate: readEntry('volume/volume-integrate.wgsl'),
    volumeComposite: readEntry('volume/volume-composite.wgsl'),
    skybox: readEntry('skybox.wgsl'),
    atmosphereCube: readEntry('atmosphere-cubemap.wgsl'),
    atmosphereBackground: readEntry('atmosphere-background.wgsl', undefined, {
      ATMOSPHERE_UTILITY_SHADOWS: true,
    }),
    atmosphereLutsFragment: readEntry('atmosphere-luts-fragment.wgsl', undefined, {
      ATMOSPHERE_UTILITY_SHADOWS: true,
    }),
    atmosphereLuts: readEntry('atmosphere-luts.wgsl', undefined, {
      ATMOSPHERE_UTILITY_SHADOWS: true,
    }),
    atmosphereCompose: readEntry('atmosphere-compose.wgsl', undefined, {
      ATMOSPHERE_UTILITY_SHADOWS: true,
    }),
    hdrpSsao: readEntry('hdrp-ssao.wgsl').then((file) => gbufferEntry(file, 'standard-gbuffer/4')),
    hdrpGtaoCompute: readGBufferEntry('hdrp-gtao-compute.wgsl'),
    lightTextureResampleCompute: readEntry(
      'light-texture-resample-compute.wgsl',
      'forgeax::engine-light-texture-resample-compute',
    ).then((file) => ({
      ...file,
      programContract: RESAMPLE_COMPUTE_PROGRAM_CONTRACT,
    })),
    lightTextureResampleFragment: readEntry(
      'light-texture-resample-fragment.wgsl',
      'forgeax::engine-light-texture-resample-fragment',
    ).then((file) => ({
      ...file,
      programContract: RESAMPLE_FRAGMENT_PROGRAM_CONTRACT,
    })),
    depthPyramidSeed: readEntry('depth-pyramid-seed.wgsl'),
    depthPyramidReduce: readEntry('depth-pyramid-reduce.wgsl'),
    depthPyramidSeedFragment: readFragmentEntry(
      'depth-pyramid-seed.wgsl',
      'forgeax::depth-pyramid-seed-fragment',
    ),
    depthPyramidReduceFragment: readFragmentEntry(
      'depth-pyramid-reduce.wgsl',
      'forgeax::depth-pyramid-reduce-fragment',
    ),
    ssrTrace: readGBufferEntry('ssr-trace.wgsl').then(compactGbufferEntry),
    ssrTraceFragment: readGBufferFragmentEntry(
      'ssr-trace.wgsl',
      'forgeax::ssr-trace-fragment',
    ).then(compactGbufferEntry),
    ssrCompose: readGBufferEntry('ssr-compose.wgsl').then(compactGbufferEntry),
    ssrComposeFragment: readGBufferFragmentEntry(
      'ssr-compose.wgsl',
      'forgeax::ssr-compose-fragment',
    ).then(compactGbufferEntry),
    rayQuery: readEntry('ray-query.wgsl'),
    rayPathTracer: readEntry('ray-path-tracer.wgsl', 'forgeax::engine-ray-path-tracer'),
    rayRasterSource: readGBufferEntry('ray-raster-source.wgsl'),
    rayProbePlacement: readGBufferEntry('ray-probe-placement.wgsl'),
    rayDiffuseComposite: readGBufferEntry('ray-diffuse-composite.wgsl'),
    rayDiffuseReconstruct: readGBufferEntry('ray-diffuse-reconstruct.wgsl'),
    rayIrradianceField: readGBufferEntry('ray-irradiance-field.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: true,
    }),
    rayBakedField: readGBufferEntry('ray-irradiance-field.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: false,
    }).then((file) => ({ ...file, id: `${file.id}?baked` })),
    rayScreenProbe: readGBufferEntry('ray-screen-probe.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: true,
      IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE: false,
    }),
    rayScreenProbeGenerate: readEntry('ray-screen-probe.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: true,
      IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE: true,
    }).then((file) => ({ ...file, id: `${file.id}?generate-visibility-cache` })),
    rayScreenProbeAtlas: readEntry('ray-screen-probe-atlas.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: true,
      IRRADIANCE_FIELD_RADIANCE_ATLAS: true,
    }),
    rayReflectionComposite: readGBufferEntry('ray-reflection-composite.wgsl'),
    standardDeferred: readGBufferEntry(
      'standard-deferred-lighting.wgsl',
      'forgeax::engine-standard-deferred-lighting',
    ).then(
      (file): EngineShaderFile => ({
        ...file,
        programContract: {
          ...file.programContract,
          schemaVersion: 'shader-program-contract/1',
          compactGbuffer: 'standard-gbuffer/4',
        },
      }),
    ),
    forwardDirectionalShadow: readEntry(
      'forward-directional-shadow.wgsl',
      'forgeax::engine-forward-directional-shadow',
      { DIRECTIONAL_PCSS_AVAILABLE: true, POINT_SHADOW_AVAILABLE: true },
    ),
    forwardScreenCompose: readEntry(
      'forward-screen-compose.wgsl',
      'forgeax::engine-forward-screen-compose',
    ),
    forwardContact: readEntry(
      'forward-contact-shadow.wgsl',
      'forgeax::engine-forward-contact-shadow',
    ),
    decalProject: readGBufferEntry('decal-project.wgsl', 'forgeax::engine-decal-project').then(
      compactGbufferEntry,
    ),
    decalApply: readGBufferEntry('decal-apply.wgsl', 'forgeax::engine-decal-apply').then(
      compactGbufferEntry,
    ),
    subsurfaceDiffusion: readGBufferEntry(
      'subsurface-diffusion.wgsl',
      'forgeax::engine-subsurface-diffusion',
    ),
  };
  const imports = {
    'forgeax_skin::task': readSource('skin-task.wgsl'),
    'forgeax_material::terrain_vertex': readSource('terrain-vertex.wgsl'),
    'forgeax_material::terrain_layer_sampling': readSource('terrain-layer-sampling.wgsl'),
    'forgeax_material::terrain_surface': readSource('terrain-surface.wgsl'),
    'forgeax_material::terrain_detail_surface': readSource('terrain-detail-surface.wgsl'),
    'forgeax_material::terrain_id_surface': readSource('terrain-id-surface.wgsl'),
    'forgeax_ray::screen_probe': readSource('ray-screen-probe.wgsl'),
    'forgeax_ray::irradiance_field_sample': readSource('ray-irradiance-field-sample.wgsl'),
    'forgeax_ray::screen_candidate': readSource('ray-screen-candidate.wgsl'),
    'forgeax_ray::screen_reconstruction': SCREEN_PROBE_RECONSTRUCTION_WGSL,
    'forgeax_ray::field_visibility': FIELD_VISIBILITY_BOUNDS_WGSL,
    'forgeax_ray::traversal': readSource('ray-traversal.wgsl'),
    'forgeax_lighting::light_texture_resample_kernel': readSource(
      'light-texture-resample-kernel.wgsl',
    ),
    'forgeax_material::ray_abi': readSource('ray-material-abi.wgsl'),
    'forgeax_pbr::ray_bsdf': readSource('ray-bsdf.wgsl'),
    'forgeax_material::texture_coordinates': readSource('texture-coordinates.wgsl'),
    'forgeax_material::displacement': readSource('standard-displacement.wgsl'),
    'forgeax_material::standard_surface': readSource('standard-surface.wgsl'),
    'forgeax_clipping::planes': readSource('clipping.wgsl'),
    'forgeax_shadow::surface': readSource('shadow-surface.wgsl'),
    'forgeax_shadow::capsule': readSource('capsule-shadow.wgsl'),
    'forgeax_view::common': readSource('common.wgsl'),
    'forgeax_view::output_encoding': readSource('output-encoding.wgsl'),
    'forgeax_view::tone_mapping': readSource('tone-mapping.wgsl'),
    'forgeax_material::fragment_output': readSource('material/fragment-output.wgsl'),
    'forgeax_pbr::brdf': readSource('brdf.wgsl'),
    'forgeax_pbr::specular_aa': readSource('specular-aa.wgsl'),
    'forgeax_pbr::temporal': readSource('pbr-temporal.wgsl'),
    forgeax_scene_temporal: readSource('scene-temporal.wgsl'),
    'forgeax_view::fog': readSource('fog.wgsl'),
    'forgeax_cloud::layer': entries.cloudLayer.then((file) => file.source),
    'forgeax_pbr::contact_shadow': readSource('contact-shadow.wgsl'),
    'forgeax_standard::cluster': readSource('standard-cluster.wgsl'),
    'forgeax_pbr::ibl_shared': readSource('ibl-shared.wgsl'),
    'forgeax_pbr::ibl_equirect_to_cube': readSource('ibl-equirect-to-cube.wgsl'),
    'forgeax_pbr::sky_sh_polynomial': readSource('sky-sh-polynomial.wgsl'),
    'forgeax_pbr::ibl_prefilter': readSource('ibl-prefilter.wgsl'),
    'forgeax_pbr::ibl_brdf_lut': readSource('ibl-brdf-lut.wgsl'),
    'forgeax_pbr::ibl_sampling': readSource('ibl-sampling.wgsl'),
    'forgeax_pbr::pmrem': readSource('ibl-pmrem.wgsl'),
    'forgeax_pbr::tbn': readSource('tbn.wgsl'),
    'forgeax_geometry::tangent_frame32': readSource('tangent-frame32.wgsl'),
    'forgeax_pbr::lighting_directional': readSource('lighting-directional.wgsl'),
    'forgeax_pbr::lighting_punctual': readSource('lighting-punctual.wgsl'),
    'forgeax_pbr::lighting_spot_modifiers': readSource('lighting-spot-modifiers.wgsl'),
    'forgeax_pbr::lighting_ies_profile': readSource('lighting-ies-profile.wgsl'),
    'forgeax_pbr::lighting_rect_area': readSource('lighting-rect-area.wgsl'),
    'forgeax_pbr::lighting_probe': readSource('lighting-probe.wgsl'),
    'forgeax_pbr::lighting_attenuation': readSource('lighting-attenuation.wgsl'),
    'forgeax_pbr::lighting_spot_projector': readSource('lighting-spot-projector.wgsl'),
    'forgeax_view::fxaa': readSource('fxaa.wgsl'),
    'forgeax_view::bloom_horizontal': readSource('bloom-horizontal.wgsl'),
    'forgeax_view::bloom_vertical': readSource('bloom-vertical.wgsl'),
    'forgeax_view::bloom_composite': readSource('bloom-composite.wgsl'),
    'forgeax_view::skybox': readSource('skybox.wgsl'),
    'forgeax_view::atmosphere': readSource('view-atmosphere.wgsl'),
    'forgeax_atmosphere::visibility': readSource('atmosphere-visibility.wgsl'),
    'forgeax_atmosphere::sampling': readSource('atmosphere-sampling.wgsl'),
    'forgeax_atmosphere::table_access': readSource('atmosphere-table-access.wgsl'),
    'forgeax_standard::cluster_texture_data': readSource('cluster-texture-data.wgsl'),
    'forgeax_atmosphere::optics': readSource('atmosphere-optics.wgsl'),
    'forgeax_atmosphere::coordinates': readSource('atmosphere-coordinates.wgsl'),
    'forgeax_atmosphere::table_kernels': readSource('atmosphere-table-kernels.wgsl'),
    'forgeax_cloud::coordinates': density.then(
      ({ imports }) => imports['forgeax_cloud::coordinates'],
    ),
    'forgeax_cloud::geometry': readSource('cloud/geometry.wgsl'),
    'forgeax_cloud::lighting': readSource('cloud/lighting.wgsl'),
    'forgeax_cloud::shadow': readSource('cloud/shadow.wgsl'),
    'forgeax_cloud::depth_minmax': readSource('cloud/depth-minmax.wgsl'),
    'forgeax_cloud::reconstruct': readSource('cloud/reconstruct.wgsl'),
    'forgeax_cloud::compose': readSource('cloud/compose.wgsl'),
    'forgeax_cloud::aerial': readSource('cloud/aerial.wgsl'),
    'forgeax_cloud::medium': density.then(({ imports }) => imports['forgeax_cloud::medium']),
    'forgeax_cloud::trace': readSource('cloud/trace.wgsl'),
    'forgeax_hdrp::ssao': readSource('hdrp-ssao.wgsl'),
    'forgeax_pbr::standard_lighting': readSource('standard-lighting.wgsl'),
    'forgeax_pbr::gbuffer': readSource('standard-gbuffer.wgsl'),
    'forgeax_pbr::gbuffer_output': readSource('standard-gbuffer-output.wgsl'),
    'forgeax_depth_pyramid::sample': readSource('depth-pyramid-sample.wgsl'),
    'forgeax_ssr::forward': readSource('ssr-forward.wgsl'),
    'forgeax_ssr::ray': readSource('ssr-ray.wgsl'),
    'forgeax_pbr::shadow_pcf': readSource('shadow-pcf.wgsl'),
    'forgeax_pbr::clearcoat': readSource('material/physical/clearcoat.wgsl'),
    'forgeax_pbr::anisotropy': readSource('material/physical/anisotropy.wgsl'),
    'forgeax_pbr::sheen': readSource('material/physical/sheen.wgsl'),
    'forgeax_pbr::iridescence': readSource('material/physical/iridescence.wgsl'),
    'forgeax_material::alpha_hash': readSource('alpha-hash.wgsl'),
    'forgeax_material::oit': readSource('oit.wgsl'),
    'forgeax_material::surface_v1': readSource('surface_v1.wgsl'),
    'forgeax_material::water_waves': readSource('water-waves.wgsl'),
    'forgeax_material::water_transition_continuity': readSource('water-transition-continuity.wgsl'),
    'forgeax_material::water_deformation_v1': Promise.resolve(waterDeformationAbiSource()),
    'forgeax_material::water_deformation_default': readSource('water-deformation-default.wgsl'),
    'forgeax_material::water_deformation_input': readSource('water-deformation-input.wgsl'),
    'forgeax_material::single_layer_water_surface_v1': readSource(
      'single-layer-water-surface_v1.wgsl',
    ),
    'forgeax_material::default_single_layer_water_surface': readSource(
      'default_single_layer_water_surface.wgsl',
    ),
    'forgeax_material::water_surface': readSource('water-surface.wgsl'),
    'forgeax_material::water_fluid': readSource('water-fluid.wgsl'),
    'forgeax_material::water_underwater': readSource('water-underwater.wgsl'),
    'forgeax_material::single_layer_medium_surface_v1': readSource(
      'single-layer-medium-surface_v1.wgsl',
    ),
    'forgeax_material::default_single_layer_medium_surface': readSource(
      'default_single_layer_medium_surface.wgsl',
    ),
    'forgeax_material::default_standard_surface': readSource('default_standard_surface.wgsl'),
    'forgeax_material::standard_physical_inputs': readSource(
      'material/standard-physical-inputs.wgsl',
    ),
    'forgeax_material::standard_surface_maps': readSource('material/standard-surface-maps.wgsl'),
    'forgeax_material::surface_sampling': readSource('surface-sampling.wgsl'),
    [SURFACE_SLOT_MODULE]: readSource('default_standard_surface.wgsl').then(
      projectSurfaceSlotSource,
    ),
  };
  const [resolvedEntries, resolvedImports] = await Promise.all([
    resolveEntries(entries),
    resolveEntries(imports),
  ]);
  return {
    cloudAtmosphere: [
      resolvedEntries.cloudAnalytic,
      resolvedEntries.cloudShadowFilter,
      resolvedEntries.cloudMode0Reconstruct,
      resolvedEntries.cloudMode0Compose,
      ...(await cloudSampled),
    ],
    terrain: await terrainEntries,
    ...resolvedEntries,
    imports: resolvedImports,
  };
}

/** Load package-owned shader entries into the shared Engine input shape. */
export async function loadPackageMaterialShaderEntries(
  packageName: string,
): Promise<EngineShaderFile[]> {
  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const prefix = '@forgeax/engine-';
    if (!packageName.startsWith(prefix)) return [];
    const workspaceName = packageName.slice(prefix.length);
    let current = process.cwd();
    while (true) {
      const candidate = resolve(current, 'packages', workspaceName);
      if (existsSync(resolve(candidate, 'package.json'))) {
        packageRoot = candidate;
        break;
      }
      const parent = dirname(current);
      if (parent === current) return [];
      current = parent;
    }
  }
  const shaderRoot = resolve(packageRoot, 'src', 'shaders');
  let names: string[];
  try {
    names = await readdir(shaderRoot);
  } catch {
    return [];
  }
  const result: EngineShaderFile[] = [];
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
    forgeax?: { materialPrograms?: Record<string, Omit<MaterialProgram, 'module'>> };
  };
  for (const name of names.filter((value) => value.endsWith('.wgsl')).sort()) {
    const id = resolve(shaderRoot, name);
    const source = await readFile(id, 'utf8');
    const identifier = extractDefineImportPath(source);
    if (identifier === undefined) continue;
    const declaration = manifest.forgeax?.materialPrograms?.[name];
    const program = declaration === undefined ? undefined : { ...declaration, module: identifier };
    if (program !== undefined)
      assertMaterialAsset({ kind: 'material', passes: [{ name: 'Forward', program }] });
    result.push({
      id,
      source,
      reservedIdentifier: identifier,
      ...(program === undefined ? {} : { program }),
    });
  }
  return result;
}
