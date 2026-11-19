import type { ShaderModule } from '@forgeax/engine-rhi';
import { isSupportedVariantKey, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  SKIN_MATERIAL_SHADER_ID,
} from '../pbr-pipeline';

/** One producer-selected WGSL module and its matching vertex/material receipt. */
export interface GpuDrivenPbrProgram {
  readonly module: ShaderModule;
  readonly artifact: MaterialShaderArtifact;
}

export function standardPbrProgramKey(
  materialShaderId: string,
  vertexColorAvailable = false,
): string | undefined {
  if (!isCanonicalStandardPbrMaterialShader(materialShaderId)) return undefined;
  const material = isStandardPbrSkinMaterialShader(materialShaderId)
    ? SKIN_MATERIAL_SHADER_ID
    : materialShaderId;
  return `${material}|color=${vertexColorAvailable}`;
}

export function resolveStandardPbrProgram(
  programs: ReadonlyMap<string, GpuDrivenPbrProgram> | undefined,
  materialShaderId: string,
  vertexColorAvailable = false,
): GpuDrivenPbrProgram | undefined {
  const key = standardPbrProgramKey(materialShaderId, vertexColorAvailable);
  return key === undefined ? undefined : programs?.get(key);
}

/** Select independent frame lighting facts only within published rows. */
export function withFrameLighting(
  artifact: MaterialShaderArtifact,
  simpleReceiver: boolean,
  leanLighting: boolean,
): MaterialShaderArtifact {
  const key = artifact.variantSet;
  if (key === undefined || (!simpleReceiver && !leanLighting)) return artifact;
  const selected = key
    .replace(
      /DIRECTIONAL_SHADOW_SIMPLE=(true|false)/,
      `DIRECTIONAL_SHADOW_SIMPLE=${simpleReceiver}`,
    )
    .replace(/LEAN_LIGHTING=(true|false)/, `LEAN_LIGHTING=${leanLighting}`);
  return isSupportedVariantKey(selected) ? { ...artifact, variantSet: selected } : artifact;
}
