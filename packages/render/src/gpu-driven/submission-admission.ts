import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { SubmissionPlan } from './batch-topology';
import type { GpuDrivenPrepareInput } from './production-raster';
import {
  patchSuppressedPrimitiveWords,
  suppressedPrimitiveWords,
} from './production-raster-prepare';
import { sameEntityKeySet } from './production-raster-support';

/** Active-entity admission of one submission plan; reused while the active set holds. */
export interface SubmissionAdmission {
  readonly scene: PersistentGpuDrivenState['scene'];
  readonly source: SubmissionPlan;
  readonly addressExtent: number;
  readonly allocationRevision: number;
  readonly activeEntityRevision?: number;
  readonly activeEntityKeys?: ReadonlySet<number>;
  readonly suppressed?: Uint32Array;
  /** The scene rows `suppressed` was derived from, for patching the next admission. */
  readonly slots: PersistentGpuDrivenState['slots'];
}

export function submissionAdmission(
  scene: PersistentGpuDrivenState,
  input: GpuDrivenPrepareInput,
  previous: SubmissionAdmission | undefined,
): SubmissionAdmission {
  const extent = scene.scene.rowAddressExtent;
  if (
    previous !== undefined &&
    previous.source === scene.plan &&
    previous.scene === scene.scene &&
    previous.addressExtent === extent &&
    previous.allocationRevision === scene.scene.allocationRevision &&
    sameActiveEntities(previous, input)
  )
    return previous;
  return createSubmissionAdmission(scene, extent, input, previous);
}

function sameActiveEntities(admission: SubmissionAdmission, input: GpuDrivenPrepareInput): boolean {
  if (input.activeEntityRevision !== undefined && admission.activeEntityRevision !== undefined)
    return input.activeEntityRevision === admission.activeEntityRevision;
  return sameEntityKeySet(admission.activeEntityKeys, input.activeEntityKeys);
}

function createSubmissionAdmission(
  scene: PersistentGpuDrivenState,
  sceneCapacity: number,
  input: GpuDrivenPrepareInput,
  previous: SubmissionAdmission | undefined,
): SubmissionAdmission {
  const { activeEntityRevision, activeEntityKeys } = input;
  if (previous?.scene !== scene.scene) previous = undefined;
  const patched =
    activeEntityKeys === undefined ||
    previous?.activeEntityKeys === undefined ||
    previous.suppressed === undefined
      ? undefined
      : patchSuppressedPrimitiveWords(
          {
            addressRevision: previous.allocationRevision,
            slots: previous.slots,
            activeEntityKeys: previous.activeEntityKeys,
            words: previous.suppressed,
          },
          scene.slots,
          activeEntityKeys,
          scene.scene,
        );
  return {
    scene: scene.scene,
    source: scene.plan,
    addressExtent: sceneCapacity,
    allocationRevision: scene.scene.allocationRevision,
    slots: scene.slots,
    ...(activeEntityRevision === undefined ? {} : { activeEntityRevision }),
    ...(activeEntityKeys === undefined
      ? {}
      : {
          activeEntityKeys,
          suppressed:
            patched ?? suppressedPrimitiveWords(scene.slots, activeEntityKeys, scene.scene),
        }),
  };
}
