import { RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import type { ManifestEntry } from '@forgeax/engine-types';
import type { DepthPyramidShaderSources, SsrShaderSources } from '../render-contract';

/** `[source key, pipeline label, WGSL entry point]`; the label equals the manifest stage. */
type UtilityShaderStage<Key extends string> = readonly [Key, string, string];

export const DEPTH_PYRAMID_SHADER_STAGES = [
  ['seed', 'depth_pyramid_seed', 'depth_pyramid_seed'],
  ['reduce', 'depth_pyramid_reduce', 'depth_pyramid_reduce'],
] as const satisfies readonly UtilityShaderStage<keyof DepthPyramidShaderSources>[];

export const SSR_SHADER_STAGES = [
  ['trace', 'ssr_trace', 'ssr_trace'],
  ['temporal', 'ssr_temporal', 'ssr_temporal'],
  ['compose', 'ssr_compose', 'vs_ssr_compose'],
] as const satisfies readonly UtilityShaderStage<keyof SsrShaderSources>[];

/**
 * Admit and compile one utility bundle before exposing any of its modules.
 * A manifest carrying none of the bundle is a valid structural build; a
 * partial bundle is a build defect.
 */
export async function prewarmUtilityShaders<Key extends string>(
  bundle: string,
  stages: readonly UtilityShaderStage<Key>[],
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string) => Promise<ShaderModule>,
  seed: (label: string, module: ShaderModule) => void,
): Promise<Record<Key, string> | undefined> {
  const resolved = stages.map(([stage, label, entryPoint]) => ({
    stage,
    label,
    entry: entries.find((entry) => entry.wgsl.includes(`fn ${entryPoint}(`)),
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
  const compiled: Array<{ label: string; module: ShaderModule }> = [];
  const sources = {} as Record<Key, string>;
  for (const { stage, label, entry } of resolved) {
    if (entry === undefined) throw new Error(`missing ${bundle} shader ${label}`);
    compiled.push({ label, module: await compile(label, entry.wgsl) });
    sources[stage] = entry.wgsl;
  }
  for (const { label, module } of compiled) seed(label, module);
  return sources;
}

/**
 * Prewarm SSR together with the depth pyramid it traces against. The two
 * bundles compile independently, but SSR installs only with a pyramid.
 */
export async function prewarmSsrWithDepthPyramid(
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string, bundle: string) => Promise<ShaderModule>,
  seed: (label: string, module: ShaderModule) => void,
): Promise<{ ssr: SsrShaderSources; pyramid: DepthPyramidShaderSources } | undefined> {
  const pyramid = await prewarmUtilityShaders(
    'depth pyramid',
    DEPTH_PYRAMID_SHADER_STAGES,
    entries,
    (label, source) => compile(label, source, 'depth pyramid'),
    seed,
  );
  const ssr = await prewarmUtilityShaders(
    'SSR',
    SSR_SHADER_STAGES,
    entries,
    (label, source) => compile(label, source, 'SSR'),
    seed,
  );
  if (ssr === undefined) return undefined;
  if (pyramid === undefined) {
    throw new RhiError({
      code: 'shader-compile-failed',
      expected: 'shader manifest contains the depth pyramid entries SSR traces against',
      hint: "add 'depth_pyramid_seed' and 'depth_pyramid_reduce' to the engine shader manifest",
    });
  }
  return { ssr, pyramid };
}
