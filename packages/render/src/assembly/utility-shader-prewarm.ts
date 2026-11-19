import { RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import { isShaderTemplateManifestRow, manifestShaderSource } from '@forgeax/engine-shader';
import type { ManifestEntry, ShaderSource } from '@forgeax/engine-types';
import type {
  AtmosphereShaderSources,
  DepthPyramidShaderSources,
  SsrShaderSources,
  VolumetricFogShaderSources,
} from '../render-contract';
import type { SeedShaderModule } from './material-shader-policy';

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
  ['temporal', 'ssr_temporal', 'ssr_temporal', 'forgeax_ssr::temporal'],
  ['compose', 'ssr_compose', 'vs_ssr_compose', 'forgeax_ssr::compose'],
] as const satisfies readonly UtilityShaderStage<Exclude<keyof SsrShaderSources, 'gbuffer'>>[];

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
  ['temporal', 'ssr_temporal_fragment', 'ssr_temporal_fragment', 'forgeax::ssr-temporal-fragment'],
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
  ['ibl', 'atmosphere_ibl', 'atmosphere_ibl_vs', 'forgeax_environment::ibl'],
] as const satisfies readonly UtilityShaderStage<keyof AtmosphereShaderSources>[];

export const VOLUMETRIC_FOG_SHADER_STAGES = [
  ['inject', 'volume_inject', 'volume_inject', 'forgeax_view::volume_inject'],
  ['temporal', 'volume_temporal', 'volume_temporal', 'forgeax_view::volume_temporal'],
  ['integrate', 'volume_integrate', 'volume_integrate', 'forgeax_view::volume_integrate'],
  ['composite', 'volume_composite', 'volume_fs', 'forgeax_view::volume_composite'],
] as const satisfies readonly UtilityShaderStage<keyof VolumetricFogShaderSources>[];

/**
 * Admit and compile one utility bundle before exposing any of its modules.
 * A manifest carrying none of the bundle is a valid structural build; a
 * partial bundle is a build defect.
 */
export async function prewarmUtilityShaders<Key extends string>(
  bundle: string,
  stages: readonly UtilityShaderStage<Key>[],
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string | ShaderSource) => Promise<ShaderModule>,
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
    const source = manifestShaderSource(entry);
    compiled.push({ label, module: await compile(label, source), source });
    sources[stage] = manifestShaderSource(entry);
  }
  for (const { label, module, source } of compiled) seed(label, module, source);
  return sources;
}

/**
 * Prewarm SSR together with the depth pyramid it traces against. The two
 * bundles compile independently, but SSR installs only with a pyramid.
 */
export async function prewarmSsrWithDepthPyramid(
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string | ShaderSource, bundle: string) => Promise<ShaderModule>,
  seed: SeedShaderModule,
  execution: 'compute' | 'fragment' = 'compute',
): Promise<{ ssr: SsrShaderSources; pyramid: DepthPyramidShaderSources } | undefined> {
  const pyramid = await prewarmUtilityShaders(
    'depth pyramid',
    execution === 'fragment' ? DEPTH_PYRAMID_FRAGMENT_STAGES : DEPTH_PYRAMID_SHADER_STAGES,
    entries,
    (label, source) => compile(label, source, 'depth pyramid'),
    seed,
  );
  const ssr = await prewarmUtilityShaders(
    'SSR',
    execution === 'fragment' ? SSR_FRAGMENT_STAGES : SSR_SHADER_STAGES,
    entries,
    (label, source) => compile(label, source, 'SSR'),
    seed,
  );
  if (ssr === undefined) return undefined;
  const required = execution === 'fragment' ? SSR_FRAGMENT_STAGES : SSR_SHADER_STAGES;
  const compatible = required.every(
    ([, , entryPoint, id]) =>
      utilityEntry(entries, entryPoint, id)?.programContract?.gbuffer === 'standard-gbuffer/2',
  );
  const admittedSsr = { ...ssr, ...(compatible ? { gbuffer: 'standard-gbuffer/2' as const } : {}) };

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
        ssr: {
          ...admittedSsr,
          traceFragment: ssr.trace,
          temporalFragment: ssr.temporal,
          composeFragment: ssr.compose,
        },
        pyramid: { ...pyramid, seedFragment: pyramid.seed, reduceFragment: pyramid.reduce },
      };
}
