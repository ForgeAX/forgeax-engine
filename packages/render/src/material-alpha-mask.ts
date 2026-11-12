import { isSupportedVariantKey } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { seededDepthMasked } from './material-render-state';

/**
 * Alpha test is a compile-time material variant (ALPHA_MASK). A material with
 * a positive alphaCutoff or an enabled alphaHash selects the alpha-mask lane;
 * every other material selects the opaque program, which contains no
 * reachable discard. On tile-based GPUs (Apple TBDR) any reachable discard in
 * a pipeline disables hidden-surface removal for that pipeline, so a runtime
 * branch or pipeline override is not a substitute for this split.
 */
export function materialAlphaMask(
  paramSnapshot: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return Number(paramSnapshot?.alphaCutoff ?? 0) > 0 || Number(paramSnapshot?.alphaHash ?? 0) > 0.5;
}

/** The compile-time ALPHA_MASK axis a selected artifact variant was built with. */
export function artifactAlphaMask(variantSet: string | undefined): boolean {
  return variantSet?.includes('ALPHA_MASK=true') === true;
}

/** Forward colour entries of the Standard template; other entries keep their own discard. */
const MASKED_IN_EARLY_PASS_ENTRIES: ReadonlySet<string | undefined> = new Set([
  undefined,
  'fs_main',
  'fs_opaque',
  'fs_forward_screen',
]);

/**
 * Alpha test only in the depth prepass (UE r.EarlyZPassOnlyMaterialMasking).
 *
 * A default-depth masked writer over the exact prepass depth tests `equal`
 * with no depth write (seededDepthRenderState): the prepass ran the same alpha
 * test (same Surface, cutoff and object-space alpha hash, which has no frame
 * seed) and wrote depth only for surviving fragments, so the depth test
 * already rejects every fragment the main-pass alpha discard would. The main
 * pass then selects the ALPHA_MASK=false program, which has no reachable alpha
 * discard (Apple TBDR keeps hidden-surface removal). Coverage and output alpha
 * come from the cooked ALPHA_CLIPPING / ALPHA_TO_COVERAGE defines, not this
 * axis, so the shaded value is unchanged. View clipping and LOD cross-fade
 * are separate discard axes; the caller's surface-discard request selects them
 * again.
 *
 * `authored` is the pass state before seeding and `seeded` the final pipeline
 * state. Anything else returns the input unchanged: no seeded draw, an
 * authored depth state, blending, alpha-to-coverage, or a non-colour entry.
 */
export function maskedInEarlyPassVariantSet(
  variantSet: string | undefined,
  authored: MaterialRenderState | undefined,
  seeded: MaterialRenderState | undefined,
  fragmentEntry: string | undefined,
): string | undefined {
  if (
    variantSet === undefined ||
    !seededDepthMasked(authored, artifactAlphaMask(variantSet)) ||
    seeded?.depthCompare !== 'equal' ||
    seeded.depthWriteEnabled !== false ||
    seeded.alphaToCoverageEnabled === true ||
    seeded.blend !== undefined ||
    !MASKED_IN_EARLY_PASS_ENTRIES.has(fragmentEntry)
  )
    return variantSet;
  let opaque = variantSet.replace('ALPHA_MASK=true', 'ALPHA_MASK=false');
  // ALPHA_MASK=true implies the clip state; the surface-discard request
  // selects it again for a clipped view. LOD cross-fade programs keep it.
  if (!opaque.includes('LOD_DITHER=true'))
    opaque = opaque.replace('CLIPPING_PLANES=true', 'CLIPPING_PLANES=false');
  return isSupportedVariantKey(opaque) ? opaque : variantSet;
}
