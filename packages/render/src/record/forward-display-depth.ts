import type { ShaderCatalog } from '@forgeax/engine-shader';
import { predepthCoversMaterial } from '../predepth-coverage';
import type { DispatchEntry, DispatchList } from '../render-system-extract';
import { MaterialFrame, someCapturedMaterialPass } from '../scene/material-dispatch';
import { FORWARD_PASS_SELECTOR, matchPass } from '../systems/pass-selector';
import { matchesRecordMode } from './material-pass-selection';

/** A complete color replacement with less-equal depth selects the same last
 * closest fragment with or without an earlier depth raster. Prove this for the
 * occupied material passes before choosing the color pass as the depth writer. */
export function forwardColorCanWriteDepth(
  dispatch: DispatchList,
  materials: MaterialFrame,
  registry: ShaderCatalog,
): boolean {
  if (MaterialFrame.fixedProgramRoot(materials) === undefined) return false;
  const needsPrepass = someCapturedMaterialPass(dispatch, (pass, resource) => {
    if (!matchPass(pass.tags, FORWARD_PASS_SELECTOR)) return false;
    const accepted = materials.get(resource);
    if (accepted === undefined) return true;
    if (!matchesRecordMode(accepted.snapshot, 'opaque')) return false;
    return !colorReplacesDepth(pass, registry);
  });
  if (needsPrepass !== undefined) return !needsPrepass;
  // Culling can publish a flat selection even for stock Scene rows. These pass
  // records carry their current program and state but omit their owning material.
  // Prove each Forward draw directly, including transparent draws when present.
  if (!Array.isArray(dispatch) || dispatch[Symbol.iterator] !== Array.prototype[Symbol.iterator])
    return false;
  for (const pass of dispatch)
    if (matchPass(pass.tags, FORWARD_PASS_SELECTOR) && !colorReplacesDepth(pass, registry))
      return false;
  return true;
}

function colorReplacesDepth(
  pass: Pick<DispatchEntry, 'materialShaderId' | 'renderState' | 'vertexEntry' | 'fragmentEntry'>,
  registry: ShaderCatalog,
): boolean {
  const state = pass.renderState;
  if (
    state?.depthCompare !== 'less-equal' ||
    state.depthWriteEnabled === false ||
    (state.colorWriteMask ?? 15) !== 15 ||
    (state.depthBias ?? 0) !== 0 ||
    (state.depthBiasSlopeScale ?? 0) !== 0 ||
    (state.depthBiasClamp ?? 0) !== 0 ||
    (state.outputs !== undefined &&
      (state.outputs.length !== 1 || (state.outputs[0]?.writeMask ?? 15) !== 15)) ||
    (pass.vertexEntry !== undefined && pass.vertexEntry !== 'vs_main') ||
    (pass.fragmentEntry !== undefined && pass.fragmentEntry !== 'fs_main')
  )
    return false;
  if (pass.materialShaderId === undefined) return false;
  const artifact = registry.findMaterialArtifact(pass.materialShaderId);
  return artifact.ok && predepthCoversMaterial(artifact.value, state);
}
