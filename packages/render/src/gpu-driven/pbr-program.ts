import type { ShaderModule } from '@forgeax/engine-rhi';
import { isSupportedVariantKey, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
  SKIN_MATERIAL_SHADER_ID,
} from '../pbr-pipeline';
import { withInlineSsrVariant } from '../ssr/admission';

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
  forwardInlineSsr = false,
): MaterialShaderArtifact {
  if (!simpleReceiver && !leanLighting && !forwardInlineSsr) return artifact;
  const key = artifact.variantSet;
  const ssrKey =
    forwardInlineSsr &&
    (isStandardPbrMaterialShader(artifact.material) ||
      key?.includes('FORWARD_INLINE_SSR=') === true)
      ? withInlineSsrVariant(key)
      : key;
  if (ssrKey === undefined) return artifact;
  const selected =
    simpleReceiver || leanLighting
      ? ssrKey
          .replace(
            /DIRECTIONAL_SHADOW_SIMPLE=(true|false)/,
            `DIRECTIONAL_SHADOW_SIMPLE=${simpleReceiver}`,
          )
          .replace(/LEAN_LIGHTING=(true|false)/, `LEAN_LIGHTING=${leanLighting}`)
      : ssrKey;
  const eligible = isSupportedVariantKey(selected) ? selected : ssrKey;
  return eligible === key ? artifact : { ...artifact, variantSet: eligible };
}
