import type { PassSelector } from '@forgeax/engine-types';
import type { MaterialSnapshot } from '../render-system-extract';
import type { AcceptedMaterial } from '../scene/material-dispatch';
import { matchPass } from '../systems/pass-selector';
import { standardTransmissionValue } from '../transmission/projection';

export type MaterialRecordMode =
  | 'opaque'
  | 'opaque-depth'
  | 'opaque-fogged'
  | 'opaque-unfogged'
  | 'transmission'
  | 'transparent'
  | 'translucent-before-transmission'
  | 'translucent'
  | 'oit-accumulate'
  | 'oit-residual'
  | 'single-layer-medium-nearest-layer'
  | 'single-layer-medium-color'
  | 'water-prepass'
  | 'water-color'
  | 'water-visibility'
  | 'water-forward-color'
  | 'water-shadow'
  | 'water-velocity';

export function isWaterMaterial(material: MaterialSnapshot): boolean {
  return material.surfaceModel === 'single-layer-water';
}

export function isSurfaceRecordMode(mode: MaterialRecordMode | undefined): boolean {
  return (
    mode === 'single-layer-medium-nearest-layer' ||
    mode === 'single-layer-medium-color' ||
    mode === 'water-prepass' ||
    mode === 'water-color' ||
    mode === 'water-visibility' ||
    mode === 'water-forward-color' ||
    mode === 'water-shadow' ||
    mode === 'water-velocity'
  );
}

export function isMediumMaterial(
  material: Pick<MaterialSnapshot, 'surfaceModel' | 'materialShaderId'>,
): boolean {
  return (
    material.surfaceModel === 'single-layer-medium' ||
    material.surfaceModel === 'single-layer-water' ||
    material.materialShaderId === 'forgeax::single-layer-medium'
  );
}

export function matchesRecordMode(material: MaterialSnapshot, mode: MaterialRecordMode): boolean {
  const medium = isMediumMaterial(material);
  if (
    mode === 'water-prepass' ||
    mode === 'water-color' ||
    mode === 'water-visibility' ||
    mode === 'water-forward-color' ||
    mode === 'water-shadow' ||
    mode === 'water-velocity'
  )
    return isWaterMaterial(material);
  if (mode === 'single-layer-medium-nearest-layer' || mode === 'single-layer-medium-color')
    return medium && !isWaterMaterial(material);
  return matchesOrdinaryRecordMode(material, mode, medium);
}

/** Select one shared material before expanding any of its draw members. */
export function materialMatchesPass(
  material: Pick<AcceptedMaterial, 'snapshot' | 'passes'>,
  selector: PassSelector | undefined,
  mode: MaterialRecordMode | undefined,
  excludeSelector: PassSelector | undefined,
): boolean {
  if (mode !== undefined && !matchesRecordMode(material.snapshot, mode)) return false;
  if (isSurfaceRecordMode(mode)) return true;
  if (selector !== undefined) {
    let selected = false;
    for (const pass of material.passes) {
      if (matchPass(pass.tags, selector)) {
        selected = true;
        break;
      }
    }
    if (!selected) return false;
  }
  if (excludeSelector !== undefined)
    for (const pass of material.passes) if (matchPass(pass.tags, excludeSelector)) return false;
  return true;
}

/** FrameList.at also accepts negative and fractional indices. A draw address never does. */
export function submittedMaterialRow(
  slots: import('../scene/frame-list').FrameList<readonly number[]>,
  row: number,
): readonly number[] | undefined {
  return Number.isInteger(row) && row >= 0 ? slots.at(row) : undefined;
}

/** Resolve a submesh from its submitted row and the fixed, uploaded material table. */
export function materialFromSubmittedSlots(
  materials: readonly MaterialSnapshot[],
  indices: readonly number[] | undefined,
  sourceSlot = 0,
): MaterialSnapshot {
  const slot = indices?.[sourceSlot] ?? indices?.[0];
  const material = slot === undefined ? undefined : materials[slot];
  if (material === undefined) throw new Error('Draw has no fixed submitted material slot');
  return material;
}

function matchesOrdinaryRecordMode(
  material: MaterialSnapshot,
  mode: MaterialRecordMode,
  medium: boolean,
): boolean {
  const transmission = (standardTransmissionValue(material) ?? 0) > 0;
  if (mode === 'translucent' || mode === 'translucent-before-transmission')
    return (transmission || material.transparent === true) && !medium;
  if (mode === 'transmission') return transmission;
  if (mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual')
    return material.transparent === true && !transmission && !medium;
  const opaque = !transmission && material.transparent !== true && !medium;
  if (mode === 'opaque-fogged') return opaque && material.renderState?.fog !== false;
  if (mode === 'opaque-unfogged') return opaque && material.renderState?.fog === false;
  return opaque;
}
