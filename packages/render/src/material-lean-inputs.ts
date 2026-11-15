import { standardLeanInputMaskCompatible } from '@forgeax/engine-shader';
import type { MaterialTextureCoordinates } from '@forgeax/engine-types';

/**
 * Lean vertex inputs are a compile-time Standard variant
 * (STANDARD_LEAN_INPUTS): UV0 only, no object basis or object position; the
 * tangent stays. UE emits only the TexCoords the material reads
 * (HLSLMaterialTranslator.cpp:15704-15716, LocalVertexFactoryCommon.ush:32-33)
 * and no instance basis under GPU Scene (LocalVertexFactoryCommon.ush:12-15);
 * here the renderer derives the same fact from authored values, so a material
 * that reads a projection basis, the object position (alpha hash) or a UV set
 * above 0 keeps the general inputs. Transmission reads the object basis for
 * thickness. An unknown mask (custom shader) is never lean.
 */
export function materialLeanInputs(
  paramSnapshot: Readonly<Record<string, unknown>> | undefined,
  standardTextureMask: number | undefined,
  textureCoordinates: ReadonlyMap<string, MaterialTextureCoordinates> | undefined,
): boolean {
  if (standardTextureMask === undefined || !standardLeanInputMaskCompatible(standardTextureMask))
    return false;
  if (Number(paramSnapshot?.alphaHash ?? 0) > 0.5 || Number(paramSnapshot?.transmission ?? 0) > 0)
    return false;
  for (const coordinates of textureCoordinates?.values() ?? []) {
    if ((coordinates.set ?? 0) !== 0) return false;
  }
  return true;
}
