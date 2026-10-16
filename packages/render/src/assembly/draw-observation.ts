import { MAX_INSPECTION_SAMPLES, MAX_RECEIPT_OBSERVATION_BYTES } from '../observation-budget';
import { unavailableDrawObservation } from '../record/draw-observation';
import type { DrawObservation } from '../render-contract';
import {
  type LodObservationCapture,
  type LodObservationCaptureValidity,
  lodObservationCaptureFailure,
} from './lod-observation';

/** Reuse the issued frame's actual view/lease/graph capture, without another frame ledger. */
export function captureMaterialDraws(capture: LodObservationCapture | undefined) {
  return capture?.views.map((view) => ({ view, draws: view.system.materialDraws }));
}

export function observeMaterialDraws(
  capture: LodObservationCapture | undefined,
  recorded: ReturnType<typeof captureMaterialDraws>,
  validity: LodObservationCaptureValidity,
  isCaptureCurrent: ((generation: number) => boolean) | undefined,
): DrawObservation {
  if (capture === undefined || recorded === undefined || capture.views.length === 0)
    return unavailableDrawObservation('not-captured');
  const failure = lodObservationCaptureFailure(capture, validity);
  if (failure !== undefined) {
    return unavailableDrawObservation(
      failure === 'superseded' ||
        failure === 'lease-detached' ||
        failure === 'view-retired' ||
        failure === 'graph-generation-mismatch'
        ? failure
        : 'capture-unavailable',
    );
  }
  const rows: import('../render-contract').MaterialDrawObservation[] = [];
  for (const { view, draws } of recorded) {
    if (view.state === 'held') return unavailableDrawObservation('held-view');
    if (view.system.materialDraws !== draws) return unavailableDrawObservation('superseded');
    if (draws.status !== 'complete') return draws;
    for (const row of draws.draws) {
      if (!capture.leases.some((lease) => lease.worldIdentity === row.worldIdentity))
        return unavailableDrawObservation('source-unavailable');
      if (!isCaptureCurrent?.(row.pipeline.captureGeneration))
        return unavailableDrawObservation('capture-unavailable');
      rows.push(row);
      if (rows.length > MAX_INSPECTION_SAMPLES)
        return unavailableDrawObservation('snapshot-too-large');
    }
  }
  const result: DrawObservation = Object.freeze({ status: 'complete', draws: Object.freeze(rows) });
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <=
    MAX_RECEIPT_OBSERVATION_BYTES
    ? result
    : unavailableDrawObservation('snapshot-too-large');
}
