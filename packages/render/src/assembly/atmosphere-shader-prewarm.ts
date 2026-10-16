import { RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import type { ManifestEntry } from '@forgeax/engine-types';
import type { AtmosphereShaderSources } from '../render-contract';

/** Admit and compile the complete analytic-atmosphere shader programs atomically. */
export async function prewarmAtmosphereShaders(
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string) => Promise<ShaderModule>,
  seed: (label: string, module: ShaderModule) => void,
): Promise<AtmosphereShaderSources | undefined> {
  const stages = [
    ['compose', 'atmosphere_compose', 'atmosphere_compose_vs'],
    ['luts', 'atmosphere_luts', 'atmosphere_transmittance'],
    ['cube', 'atmosphere_cube', 'atmosphere_cubemap_vs'],
    ['background', 'atmosphere_background', 'atmosphere_background_vs'],
    ['ibl', 'atmosphere_ibl', 'atmosphere_ibl_vs'],
  ] as const;
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
      expected: 'shader manifest contains all analytic-atmosphere utility entries',
      hint: `add the package-owned WGSL entry for '${missing.label}' to the engine shader manifest`,
    });
  }
  const compiled: Array<{ label: string; module: ShaderModule }> = [];
  const sources = {} as Record<keyof AtmosphereShaderSources, string>;
  for (const { stage, label, entry } of resolved) {
    if (entry === undefined) throw new Error(`missing atmosphere shader ${label}`);
    compiled.push({ label, module: await compile(label, entry.wgsl) });
    sources[stage] = entry.wgsl;
  }
  for (const { label, module } of compiled) seed(label, module);
  return sources;
}
