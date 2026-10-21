import type { PassSelector } from '@forgeax/engine-types';
import type { MaterialSnapshot } from '../render-system-extract';
import type { AcceptedMaterial } from '../scene/material-dispatch';
import { matchPass } from '../systems/pass-selector';
import { standardTransmissionValue } from '../transmission/projection';

export type MaterialRecordMode =
  | 'opaque'
  | 'transmission'
  | 'transparent'
  | 'translucent-before-transmission'
  | 'translucent'
  | 'oit-accumulate'
  | 'oit-residual'
  | 'single-layer-medium-nearest-layer'
  | 'single-layer-medium-color';

export function isMediumMaterial(material: MaterialSnapshot): boolean {
  return (
    material.surfaceModel === 'single-layer-medium' ||
    material.materialShaderId === 'forgeax::single-layer-medium'
  );
}

export function matchesRecordMode(material: MaterialSnapshot, mode: MaterialRecordMode): boolean {
  const medium = isMediumMaterial(material);
  if (mode === 'single-layer-medium-nearest-layer' || mode === 'single-layer-medium-color')
    return medium;
  const transmission = (standardTransmissionValue(material) ?? 0) > 0;
  if (mode === 'translucent' || mode === 'translucent-before-transmission')
    return (transmission || material.transparent === true) && !medium;
  if (mode === 'transmission') return transmission;
  if (mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual')
    return material.transparent === true && !transmission && !medium;
  return !transmission && material.transparent !== true && !medium;
}

/** Select one shared material before expanding any of its draw members. */
export function materialMatchesPass(
  material: Pick<AcceptedMaterial, 'snapshot' | 'passes'>,
  selector: PassSelector | undefined,
  mode: MaterialRecordMode | undefined,
  excludeSelector: PassSelector | undefined,
): boolean {
  if (mode !== undefined && !matchesRecordMode(material.snapshot, mode)) return false;
  if (mode === 'single-layer-medium-nearest-layer' || mode === 'single-layer-medium-color')
    return true;
  return (
    (selector === undefined || material.passes.some((pass) => matchPass(pass.tags, selector))) &&
    (excludeSelector === undefined ||
      !material.passes.some((pass) => matchPass(pass.tags, excludeSelector)))
  );
}

/** Resolve the fixed material table already uploaded for this draw. */
export function drawMaterial(
  c: Pick<
    import('./render-context')._InternalRenderPipelineContext,
    'materialSlots' | 'materialSlotIndices'
  >,
  row: number,
  sourceSlot = 0,
): MaterialSnapshot {
  const indices = c.materialSlotIndices[row];
  const slot = indices?.[sourceSlot] ?? indices?.[0];
  const material = slot === undefined ? undefined : c.materialSlots[slot];
  if (material === undefined) throw new Error('Draw has no fixed submitted material slot');
  return material;
}
