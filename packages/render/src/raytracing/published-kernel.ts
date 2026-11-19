import { RhiError } from '@forgeax/engine-rhi';
import type { MaterialGBufferLayout, ShaderProgramContract } from '@forgeax/engine-types';
/** Select one published module by its emitted entry-point spelling. */
export function findPublishedKernel(
  entries: Iterable<{ readonly wgsl: string; readonly programContract?: ShaderProgramContract }>,
  entryPoint: string,
  gbuffer?: MaterialGBufferLayout,
): string | undefined {
  let source: string | undefined;
  for (const entry of entries) {
    if (gbuffer !== undefined && entry.programContract?.gbuffer !== gbuffer) continue;
    if (!entry.wgsl.includes(`fn ${entryPoint}(`)) continue;
    if (source !== undefined) return undefined;
    source = entry.wgsl;
  }
  return source;
}

export function requirePublishedKernel(
  entries: Iterable<{ readonly wgsl: string; readonly programContract?: ShaderProgramContract }>,
  entryPoint: string,
  gbuffer?: MaterialGBufferLayout,
): string {
  const source = findPublishedKernel(entries, entryPoint, gbuffer);
  if (source === undefined)
    throw new RhiError({
      code: 'shader-compile-failed',
      expected: `one published ${entryPoint} kernel${gbuffer === undefined ? '' : ` for ${gbuffer}`}`,
      hint: 'Rebuild the Engine shader manifest and re-cook the current layout.',
    });
  return source;
}
