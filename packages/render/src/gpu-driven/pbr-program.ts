import type { ShaderModule } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';

/** One producer-selected WGSL module and its matching vertex/material receipt. */
export interface GpuDrivenPbrProgram {
  readonly module: ShaderModule;
  readonly artifact: MaterialShaderArtifact;
}

export function standardPbrProgramKey(
  materialShaderId: string,
  vertexColorAvailable = false,
): string | undefined {
  const material =
    materialShaderId === 'forgeax::default-standard-pbr'
      ? materialShaderId
      : materialShaderId === 'forgeax::pbr-skin' ||
          materialShaderId === 'forgeax::default-standard-pbr-skin'
        ? 'forgeax::pbr-skin'
        : undefined;
  return material === undefined ? undefined : `${material}|color=${vertexColorAvailable}`;
}

export function resolveStandardPbrProgram(
  programs: ReadonlyMap<string, GpuDrivenPbrProgram> | undefined,
  materialShaderId: string,
  vertexColorAvailable = false,
): GpuDrivenPbrProgram | undefined {
  const key = standardPbrProgramKey(materialShaderId, vertexColorAvailable);
  return key === undefined ? undefined : programs?.get(key);
}
