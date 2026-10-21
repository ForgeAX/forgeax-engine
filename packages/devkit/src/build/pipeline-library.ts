import { specializeComputeEntries } from '@forgeax/engine-naga';
import type { DevKitAppOptions } from '../plugin-build.js';

type PipelineLibraryManifest = NonNullable<DevKitAppOptions['pipelineLibrary']>;

/** Precompute reachable entry closures once, before any player loads the library. */
export async function precomputePipelineLibrary(
  manifest: PipelineLibraryManifest,
): Promise<PipelineLibraryManifest> {
  if (manifest.computeEntryModules !== undefined) return manifest;
  const entries = new Map<number, Set<string>>();
  for (const { compute } of manifest.computePipelines) {
    // An omitted entry selects a device-defined sole entry. Preserve that path.
    if (compute.entryPoint === undefined) continue;
    let names = entries.get(compute.module);
    if (names === undefined) {
      names = new Set();
      entries.set(compute.module, names);
    }
    names.add(compute.entryPoint);
  }
  const projectedEntries: { module: number; entryPoint: string; source: string }[] = [];
  const uses = new Map<string, number>();
  for (const [module, names] of entries) {
    const descriptor = manifest.shaders[module];
    if (descriptor === undefined) throw new Error('Missing compute pipeline shader');
    const projected = await specializeComputeEntries(descriptor.code, [...names]);
    if (!projected.ok) throw projected.error;
    for (const { entryPoint, source } of projected.value) {
      if (source === descriptor.code) continue;
      projectedEntries.push({ module, entryPoint, source });
      uses.set(source, (uses.get(source) ?? 0) + 1);
    }
  }
  const shaders = [...manifest.shaders];
  const sources = new Map(shaders.map((shader, id) => [shader.code, id]));
  const computeEntryModules: NonNullable<PipelineLibraryManifest['computeEntryModules']>[number][] =
    [];
  for (const { module, entryPoint, source } of projectedEntries) {
    // A unique closure cannot share a pipeline. Keep its original module
    // rather than shipping and creating another native shader for it.
    if ((uses.get(source) ?? 0) < 2) continue;
    let specializedModule = sources.get(source);
    if (specializedModule === undefined) {
      specializedModule = shaders.length;
      shaders.push({ code: source });
      sources.set(source, specializedModule);
    }
    computeEntryModules.push({ module, entryPoint, specializedModule });
  }
  return computeEntryModules.length === 0
    ? manifest
    : { ...manifest, shaders, computeEntryModules };
}
