import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { terrainProgramSource } from '@forgeax/engine-shader-compiler';
import { assertMaterialAsset, type MaterialProgram } from '@forgeax/engine-types';
import { cloudAtmosphereEntries } from './cloud-atmosphere-entries';

const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path\s+([A-Za-z0-9_.:-]+)/m;

export interface EngineShaderFile {
  readonly id: string;
  readonly defines?: Readonly<Record<string, boolean>>;
  readonly source: string;
  readonly reservedIdentifier?: string | undefined;
  readonly program?: MaterialProgram;
  /** Engine-owned fixed Surface composition, prepared only at build time. */
  readonly surfaceModule?: string;
}

export function extractDefineImportPath(source: string): string | undefined {
  return DEFINE_IMPORT_PATH_RE.exec(source)?.[1];
}

export const SURFACE_SLOT_MODULE = 'forgeax_material::slot::surface' as const;

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

/** Load canonical Engine shader entries and their import closure. */
export async function loadEngineShaderEntries() {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@forgeax/engine-shader/package.json');
  const srcDir = resolve(dirname(packageJsonPath), 'src');
  const sourceReads = new Map<string, Promise<string>>();
  const readSource = (fileName: string): Promise<string> => {
    let source = sourceReads.get(fileName);
    if (source === undefined) {
      source = readFile(resolve(srcDir, fileName), 'utf8');
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
  const terrainEntries = Promise.all(
    [false, true].flatMap((ids) =>
      [false, true].map(async (shadow) => {
        const file = await readEntry(shadow ? 'shadow_caster.wgsl' : 'default-standard-pbr.wgsl');
        const identifier = `forgeax::standard-terrain${ids ? '-ids' : ''}${shadow ? '-shadow' : ''}`;
        const composition = terrainProgramSource(identifier);
        if (composition === undefined)
          throw new Error(`Unknown Terrain composition: ${identifier}`);
        const fixed = composition.defines;
        return {
          ...file,
          id: `${file.id}?terrain=${ids ? 'ids' : 'weights'}${shadow ? '-shadow' : ''}`,
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
    unlit: readEntry('unlit.wgsl', 'forgeax::default-unlit'),
    pointsLines: readEntry('points-lines.wgsl', 'forgeax::points-lines'),
    tonemap: readEntry('tonemap.wgsl'),
    analyticFog: readEntry('analytic-fog.wgsl', 'forgeax::analytic-fog'),
    cloudLayer: readEntry('cloud.wgsl'),
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
    iblIrradiance: readEntry('ibl-irradiance.wgsl'),
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
    atmosphereIbl: readEntry('atmosphere-ibl.wgsl'),
    atmosphereLuts: readEntry('atmosphere-luts.wgsl', undefined, {
      ATMOSPHERE_UTILITY_SHADOWS: true,
    }),
    atmosphereCompose: readEntry('atmosphere-compose.wgsl', undefined, {
      ATMOSPHERE_UTILITY_SHADOWS: true,
    }),
    hdrpSsao: readEntry('hdrp-ssao.wgsl'),
    depthPyramidSeed: readEntry('depth-pyramid-seed.wgsl'),
    depthPyramidReduce: readEntry('depth-pyramid-reduce.wgsl'),
    ssrTrace: readEntry('ssr-trace.wgsl'),
    ssrTemporal: readEntry('ssr-temporal.wgsl'),
    ssrCompose: readEntry('ssr-compose.wgsl'),
    rayQuery: readEntry('ray-query.wgsl'),
    rayPathTracer: readEntry('ray-path-tracer.wgsl', 'forgeax::engine-ray-path-tracer'),
    rayRasterSource: readEntry('ray-raster-source.wgsl'),
    rayProbePlacement: readEntry('ray-probe-placement.wgsl'),
    rayDiffuseComposite: readEntry('ray-diffuse-composite.wgsl'),
    rayDiffuseReconstruct: readEntry('ray-diffuse-reconstruct.wgsl'),
    rayIrradianceField: readEntry('ray-irradiance-field.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: true,
    }),
    rayBakedField: readEntry('ray-irradiance-field.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: false,
    }).then((file) => ({ ...file, id: `${file.id}?baked` })),
    rayScreenProbe: readEntry('ray-screen-probe.wgsl', undefined, {
      IRRADIANCE_FIELD_VISIBILITY: true,
    }),
    rayReflectionComposite: readEntry('ray-reflection-composite.wgsl'),
    standardDeferred: readEntry(
      'standard-deferred-lighting.wgsl',
      'forgeax::engine-standard-deferred-lighting',
    ),
    shadowVariance: readEntry('shadow-variance.wgsl', 'forgeax::engine-shadow-variance'),
    decalProject: readEntry('decal-project.wgsl', 'forgeax::engine-decal-project'),
    decalApply: readEntry('decal-apply.wgsl', 'forgeax::engine-decal-apply'),
    subsurfaceDiffusion: readEntry(
      'subsurface-diffusion.wgsl',
      'forgeax::engine-subsurface-diffusion',
    ),
  };
  const imports = {
    'forgeax_material::terrain_vertex': readSource('terrain-vertex.wgsl'),
    'forgeax_material::terrain_layer_sampling': readSource('terrain-layer-sampling.wgsl'),
    'forgeax_material::terrain_surface': readSource('terrain-surface.wgsl'),
    'forgeax_material::terrain_id_surface': readSource('terrain-id-surface.wgsl'),
    'forgeax_ray::irradiance_field_sample': readSource('ray-irradiance-field-sample.wgsl'),
    'forgeax_ray::traversal': readSource('ray-traversal.wgsl'),
    'forgeax_material::ray_abi': readSource('ray-material-abi.wgsl'),
    'forgeax_pbr::ray_bsdf': readSource('ray-bsdf.wgsl'),
    'forgeax_material::texture_coordinates': readSource('texture-coordinates.wgsl'),
    'forgeax_material::displacement': readSource('standard-displacement.wgsl'),
    'forgeax_material::standard_surface': readSource('standard-surface.wgsl'),
    'forgeax_clipping::planes': readSource('clipping.wgsl'),
    'forgeax_shadow::surface': readSource('shadow-surface.wgsl'),
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
    'forgeax_standard::cluster': readSource('standard-cluster.wgsl'),
    'forgeax_pbr::ibl_shared': readSource('ibl-shared.wgsl'),
    'forgeax_pbr::ibl_equirect_to_cube': readSource('ibl-equirect-to-cube.wgsl'),
    'forgeax_pbr::ibl_irradiance': readSource('ibl-irradiance.wgsl'),
    'forgeax_pbr::ibl_prefilter': readSource('ibl-prefilter.wgsl'),
    'forgeax_pbr::ibl_brdf_lut': readSource('ibl-brdf-lut.wgsl'),
    'forgeax_pbr::ibl_sampling': readSource('ibl-sampling.wgsl'),
    'forgeax_pbr::pmrem': readSource('ibl-pmrem.wgsl'),
    'forgeax_pbr::tbn': readSource('tbn.wgsl'),
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
    'forgeax_atmosphere::optics': readSource('atmosphere-optics.wgsl'),
    'forgeax_atmosphere::coordinates': readSource('atmosphere-coordinates.wgsl'),
    'forgeax_hdrp::ssao': readSource('hdrp-ssao.wgsl'),
    'forgeax_pbr::standard_lighting': readSource('standard-lighting.wgsl'),
    'forgeax_pbr::gbuffer': readSource('standard-gbuffer.wgsl'),
    'forgeax_pbr::gbuffer_output': readSource('standard-gbuffer-output.wgsl'),
    'forgeax_depth_pyramid::sample': readSource('depth-pyramid-sample.wgsl'),
    'forgeax_pbr::shadow_pcf': readSource('shadow-pcf.wgsl'),
    'forgeax_pbr::clearcoat': readSource('material/physical/clearcoat.wgsl'),
    'forgeax_pbr::anisotropy': readSource('material/physical/anisotropy.wgsl'),
    'forgeax_pbr::sheen': readSource('material/physical/sheen.wgsl'),
    'forgeax_pbr::iridescence': readSource('material/physical/iridescence.wgsl'),
    'forgeax_material::alpha_hash': readSource('alpha-hash.wgsl'),
    'forgeax_material::oit': readSource('oit.wgsl'),
    'forgeax_material::surface_v1': readSource('surface_v1.wgsl'),
    'forgeax_material::single_layer_medium_surface_v1': readSource(
      'single-layer-medium-surface_v1.wgsl',
    ),
    'forgeax_material::default_single_layer_medium_surface': readSource(
      'default_single_layer_medium_surface.wgsl',
    ),
    'forgeax_material::default_standard_surface': readSource('default_standard_surface.wgsl'),
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
    cloudAtmosphere: cloudAtmosphereEntries(),
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
