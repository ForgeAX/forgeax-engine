import { type RhiDevice, RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import { isShaderTemplateManifestRow, manifestShaderSource } from '@forgeax/engine-shader';
import type { ManifestEntry, ShaderSource } from '@forgeax/engine-types';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import type { SeedShaderModule } from './material-shader-policy';

/** Native record owns first-use creation for these manifest programs. */
export function stockUtilityShaderFactory<Factory>(runtime: {
  readonly device: RhiDevice;
  readonly shaderModuleFactory?: Factory | undefined;
  readonly immediateShaderModuleFactory?: Factory | undefined;
}): Factory | undefined {
  return runtime.device.caps.backendKind === 'webgpu'
    ? (runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory)
    : runtime.shaderModuleFactory;
}

/** `[source key, pipeline label, WGSL entry point]`; the label equals the manifest stage. */
type UtilityShaderStage<Key extends string> = readonly [Key, string, string, string];

function utilityEntry(entries: readonly ManifestEntry[], entryPoint: string, identifier: string) {
  return entries.find((entry) =>
    isShaderTemplateManifestRow(entry)
      ? entry.identifier === identifier
      : entry.entryPoints === undefined
        ? entry.wgsl.includes(`fn ${entryPoint}(`)
        : entry.entryPoints.some((point) => point.name === entryPoint),
  );
}

export const DEPTH_PYRAMID_SHADER_STAGES = [
  ['seed', 'depth_pyramid_seed', 'depth_pyramid_seed', 'forgeax_depth_pyramid::seed'],
  ['reduce', 'depth_pyramid_reduce', 'depth_pyramid_reduce', 'forgeax_depth_pyramid::reduce'],
] as const satisfies readonly UtilityShaderStage<keyof DepthPyramidShaderSources>[];

export const SSR_SHADER_STAGES = [
  ['trace', 'ssr_trace', 'ssr_trace', 'forgeax_ssr::trace'],
  ['compose', 'ssr_compose', 'vs_ssr_compose', 'forgeax_ssr::compose'],
] as const satisfies readonly UtilityShaderStage<
  Exclude<keyof SsrShaderSources, 'gbuffer' | 'compactGbuffer'>
>[];

const DEPTH_PYRAMID_FRAGMENT_STAGES = [
  [
    'seed',
    'depth_pyramid_seed_fragment',
    'depth_pyramid_seed_fragment',
    'forgeax::depth-pyramid-seed-fragment',
  ],
  [
    'reduce',
    'depth_pyramid_reduce_fragment',
    'depth_pyramid_reduce_fragment',
    'forgeax::depth-pyramid-reduce-fragment',
  ],
] as const;
const SSR_FRAGMENT_STAGES = [
  ['trace', 'ssr_trace_fragment', 'ssr_trace_fragment', 'forgeax::ssr-trace-fragment'],
  ['compose', 'ssr_compose_fragment', 'vs_ssr_compose_fragment', 'forgeax::ssr-compose-fragment'],
] as const;

export const ATMOSPHERE_SHADER_STAGES = [
  ['compose', 'atmosphere_compose', 'atmosphere_compose_vs', 'forgeax_atmosphere::compose'],
  ['luts', 'atmosphere_luts', 'atmosphere_transmittance', 'forgeax_atmosphere::luts'],
  [
    'lutsFragment',
    'atmosphere_luts_fragment',
    'atmosphere_tables_vs',
    'forgeax_atmosphere::luts_fragment',
  ],
  ['cube', 'atmosphere_cube', 'atmosphere_cubemap_vs', 'forgeax_environment::cubemap'],
  [
    'background',
    'atmosphere_background',
    'atmosphere_background_vs',
    'forgeax_environment::background',
  ],
] as const satisfies readonly UtilityShaderStage<keyof AtmosphereShaderSources>[];

export const VOLUMETRIC_FOG_SHADER_STAGES = [
  ['inject', 'volume_inject', 'volume_inject', 'forgeax_view::volume_inject'],
  ['temporal', 'volume_temporal', 'volume_temporal', 'forgeax_view::volume_temporal'],
  ['integrate', 'volume_integrate', 'volume_integrate', 'forgeax_view::volume_integrate'],
  ['composite', 'volume_composite', 'volume_fs', 'forgeax_view::volume_composite'],
] as const satisfies readonly UtilityShaderStage<keyof VolumetricFogShaderSources>[];

/** Publish a manifest member without composing it until its pass reads it. */
export function declareUtilityShader<Key extends string, Sources extends object>(
  sources: Sources,
  key: Key,
  read: () => ShaderSource,
): Sources & Record<Key, ShaderSource> {
  let source: ShaderSource | undefined;
  return Object.defineProperty(sources, key, {
    enumerable: true,
    get: () => (source ??= read()),
  }) as Sources & Record<Key, ShaderSource>;
}

/**
 * Admit one whole manifest bundle. Backends that supply a compiler seed all
 * modules together. Native first-use creation needs only the published sources.
 * A missing bundle is valid; a partial bundle is a build defect.
 */
export async function prepareUtilityShaders<Key extends string>(
  bundle: string,
  stages: readonly UtilityShaderStage<Key>[],
  entries: readonly ManifestEntry[],
  compile: ((label: string, source: string | ShaderSource) => Promise<ShaderModule>) | undefined,
  seed: SeedShaderModule,
): Promise<Record<Key, ShaderSource> | undefined> {
  const resolved = stages.map(([stage, label, entryPoint, identifier]) => ({
    stage,
    label,
    entry: utilityEntry(entries, entryPoint, identifier),
  }));
  if (resolved.every(({ entry }) => entry === undefined)) return undefined;
  const missing = resolved.find(({ entry }) => entry === undefined);
  if (missing !== undefined) {
    throw new RhiError({
      code: 'shader-compile-failed',
      expected: `shader manifest contains all ${stages.length} ${bundle} utility entries`,
      hint: `add the package-owned WGSL entry for '${missing.label}' to the engine shader manifest`,
    });
  }
  const compiled: Array<{ label: string; module: ShaderModule; source: ShaderSource }> = [];
  const sources = {} as Record<Key, ShaderSource>;
  for (const { stage, label, entry } of resolved) {
    if (entry === undefined) throw new Error(`missing ${bundle} shader ${label}`);
    if (compile === undefined) {
      declareUtilityShader(sources, stage, () => manifestShaderSource(entry));
    } else {
      const source = manifestShaderSource(entry);
      compiled.push({ label, module: await compile(label, source), source });
      sources[stage] = source;
    }
  }
  for (const { label, module, source } of compiled) seed(label, module, source);
  return sources;
}

/** Publish SSR alongside the depth pyramid it reads. Older backends can seed both bundles. */
export async function prepareSsrWithDepthPyramid(
  entries: readonly ManifestEntry[],
  compile:
    | ((label: string, source: string | ShaderSource, bundle: string) => Promise<ShaderModule>)
    | undefined,
  seed: SeedShaderModule,
  execution: 'compute' | 'fragment' = 'compute',
): Promise<{ ssr?: SsrShaderSources; pyramid: DepthPyramidShaderSources } | undefined> {
  const pyramid = await prepareUtilityShaders(
    'depth pyramid',
    execution === 'fragment' ? DEPTH_PYRAMID_FRAGMENT_STAGES : DEPTH_PYRAMID_SHADER_STAGES,
    entries,
    compile === undefined ? undefined : (label, source) => compile(label, source, 'depth pyramid'),
    seed,
  );
  const ssr = await prepareUtilityShaders(
    'SSR',
    execution === 'fragment' ? SSR_FRAGMENT_STAGES : SSR_SHADER_STAGES,
    entries,
    compile === undefined ? undefined : (label, source) => compile(label, source, 'SSR'),
    seed,
  );
  if (pyramid !== undefined && execution === 'fragment') {
    Object.defineProperties(pyramid, {
      seedFragment: { enumerable: true, get: () => pyramid.seed },
      reduceFragment: { enumerable: true, get: () => pyramid.reduce },
    });
  }
  if (ssr === undefined) return pyramid === undefined ? undefined : { pyramid };
  const required = execution === 'fragment' ? SSR_FRAGMENT_STAGES : SSR_SHADER_STAGES;
  const compatible = required.every(
    ([, , entryPoint, id]) =>
      utilityEntry(entries, entryPoint, id)?.programContract?.gbuffer === 'standard-gbuffer/2',
  );
  const compactCompatible =
    compatible &&
    required.every(
      ([, , entryPoint, id]) =>
        utilityEntry(entries, entryPoint, id)?.programContract?.compactGbuffer ===
        'standard-gbuffer/4',
    );
  const admittedSsr: SsrShaderSources = Object.assign(
    ssr,
    compatible ? { gbuffer: 'standard-gbuffer/2' as const } : undefined,
    compactCompatible ? { compactGbuffer: 'standard-gbuffer/4' as const } : undefined,
  );

  if (pyramid === undefined) {
    throw new RhiError({
      code: 'shader-compile-failed',
      expected: 'shader manifest contains the depth pyramid entries SSR traces against',
      hint: "add 'depth_pyramid_seed' and 'depth_pyramid_reduce' to the engine shader manifest",
    });
  }
  return execution === 'compute'
    ? { ssr: admittedSsr, pyramid }
    : {
        ssr: Object.defineProperties(admittedSsr, {
          traceFragment: { enumerable: true, get: () => ssr.trace },
          composeFragment: { enumerable: true, get: () => ssr.compose },
        }),
        pyramid,
      };
}
