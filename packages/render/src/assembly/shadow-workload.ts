import type { ShadowWorkloadObservation } from '../inspection-types';
import { MAX_INSPECTION_SAMPLES, MAX_RECEIPT_OBSERVATION_BYTES } from '../observation-budget';
import type { LodObservationCapture } from './lod-observation';

/** Consumes the current submission roster synchronously; no latest inspector/readback. */
export function captureShadowWorkload(
  identity: Pick<ShadowWorkloadObservation, 'frameId' | 'deviceGeneration' | 'graphGeneration'>,
  capture: LodObservationCapture | undefined,
  uiOnly = false,
): ShadowWorkloadObservation {
  const views: ShadowWorkloadObservation['views'][number][] = [];
  let reason: ShadowWorkloadObservation['reason'];
  if (uiOnly) reason = 'ui-only';
  else if (
    capture === undefined ||
    capture.frameId !== identity.frameId ||
    capture.deviceGeneration !== identity.deviceGeneration ||
    capture.views.length === 0
  )
    reason = 'view-not-captured';
  else {
    for (const view of capture.views.slice(0, MAX_INSPECTION_SAMPLES)) {
      const passes =
        view.state === 'rendered' ? view.system.captureShadowWorkload(identity.frameId) : undefined;
      if (view.state === 'held') reason ??= 'held-view';
      else if (passes === undefined) reason ??= 'view-not-captured';
      views.push(
        Object.freeze({
          viewKey: view.viewKey,
          viewId: view.entityKey,
          attachmentId: view.attachmentId,
          viewGeneration: view.viewGeneration,
          ...(view.eye === undefined ? {} : { eye: view.eye }),
          graphGeneration: view.graphGeneration,
          state: view.state,
          passes: passes ?? Object.freeze([]),
        }),
      );
    }
    if (capture.views.length > MAX_INSPECTION_SAMPLES) reason = 'observation-budget';
  }
  const result: ShadowWorkloadObservation = Object.freeze({
    ...identity,
    scope: 'display-views',
    status: reason === undefined ? 'complete' : 'unavailable',
    ...(reason === undefined ? {} : { reason }),
    views: Object.freeze(views),
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RECEIPT_OBSERVATION_BYTES)
    return Object.freeze({
      ...identity,
      scope: 'display-views',
      status: 'unavailable',
      reason: 'observation-budget',
      views: Object.freeze([]),
    });
  return result;
}
