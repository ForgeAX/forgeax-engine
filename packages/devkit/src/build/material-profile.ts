import type { BuildOptions } from '../types.js';

/** Generated startup reads actual selected device facts, including Render Worker readiness. */
export function materialBuildCapabilityGuard(profile: BuildOptions['materialProfile']): string {
  if (profile === undefined) return '';
  if (profile !== 'webgpu-storage') throw new Error('unsupported material build profile');
  return `const materialBuildCaps = workerExecution && typeof app.remoteEval === 'function'
      ? await app.remoteEval('const inspected = await execution.inspectRenderer(); if (!inspected.ok) throw inspected.error; return inspected.value.capabilities;')
      : app.renderer.inspect().capabilities;
    if (materialBuildCaps?.backendKind !== 'webgpu' || materialBuildCaps.compute !== true || materialBuildCaps.storageBuffer !== true)
      throw new Error('forgeax: webgpu-storage validation build requires actual WebGPU compute/storage; fallback is unsupported');`;
}
