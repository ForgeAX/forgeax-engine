import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type {
  LodOcclusionInspection,
  LodOcclusionReceiptObservation,
  LodOcclusionReceiptUnavailableReason,
  LodOcclusionReceiptViewObservation,
} from '../inspection-types';
import { MAX_INSPECTION_SAMPLES, MAX_RECEIPT_OBSERVATION_BYTES } from '../observation-budget';
import type { FrameReceipt } from '../render-contract';
import type { RenderSystem } from '../render-system';

export interface LodObservationLeaseCapture {
  readonly lease: RenderReadLease;
  readonly worldIdentity: string;
  readonly generation: number;
}

export interface LodObservationViewCapture {
  readonly viewKey: string;
  readonly entityKey: number;
  readonly eye: 'left' | 'right' | undefined;
  readonly attachmentId: string;
  readonly viewGeneration: number;
  readonly graphGeneration: number;
  readonly graphIncarnation: object | undefined;
  readonly state: 'rendered' | 'held';
  readonly system: RenderSystem;
  readonly viewRef: object | undefined;
  readonly primary: boolean;
  readonly inspection: LodOcclusionInspection | undefined;
}

export interface LodObservationCapture {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly views: readonly LodObservationViewCapture[];
  readonly leases: readonly LodObservationLeaseCapture[];
}

export interface LodObservationCaptureValidity {
  readonly isLatest: () => boolean;
  readonly isViewCurrent: (view: LodObservationViewCapture) => boolean;
  readonly isLeaseAttached: (lease: LodObservationLeaseCapture) => boolean;
}

export function unavailableLodObservation(
  reason: LodOcclusionReceiptUnavailableReason,
  views: readonly LodOcclusionReceiptViewObservation[] = [],
): LodOcclusionReceiptObservation {
  const result: LodOcclusionReceiptObservation = Object.freeze({
    status: 'unavailable',
    reason,
    views: Object.freeze([...views]),
  });
  return fitReceiptObservation(result);
}

export async function observeLodOcclusionCapture(
  receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration'>,
  capture: LodObservationCapture | undefined,
  validity: LodObservationCaptureValidity,
): Promise<LodOcclusionReceiptObservation> {
  if (capture === undefined) return unavailableLodObservation('not-captured');
  if (capture.frameId !== receipt.frameId || capture.deviceGeneration !== receipt.deviceGeneration)
    return unavailableLodObservation('not-captured');
  if (capture.views.length === 0) return unavailableLodObservation('empty-display-roster');

  const cameraGenerations = new Map<number, number>();
  for (const view of capture.views) {
    const previous = cameraGenerations.get(view.entityKey);
    if (previous !== undefined && previous !== view.viewGeneration)
      return unavailableLodObservation('camera-generation-mismatch', roster(capture.views));
    cameraGenerations.set(view.entityKey, view.viewGeneration);
  }

  const initialReason = validateCapture(capture, validity);
  if (initialReason !== undefined)
    return unavailableLodObservation(initialReason, roster(capture.views));

  for (const view of capture.views) {
    if (view.state !== 'rendered') continue;
    const captureFailure = currentCaptureFailure(capture, validity);
    if (captureFailure !== undefined)
      return unavailableLodObservation(captureFailure, roster(capture.views));
    const inspection = view.system.lodOcclusionInspection;
    if (inspection !== view.inspection)
      return unavailableLodObservation('lod-readback-unavailable', roster(capture.views));
    const ownerInspection = await view.system.observeLodOcclusion({
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
    });
    const captureFailureAfterRead = currentCaptureFailure(capture, validity);
    if (captureFailureAfterRead !== undefined)
      return unavailableLodObservation(captureFailureAfterRead, roster(capture.views));
    const currentInspection = view.system.lodOcclusionInspection;
    if (
      (ownerInspection === undefined && currentInspection !== inspection) ||
      (ownerInspection !== undefined &&
        (currentInspection !== ownerInspection ||
          !ownerInspectionMatchesCapture(view, capture, receipt, ownerInspection)))
    )
      return unavailableLodObservation('lod-readback-unavailable', roster(capture.views));
  }

  const projected: LodOcclusionReceiptViewObservation[] = [];
  let unavailableReason: LodOcclusionReceiptUnavailableReason | undefined;
  for (const view of capture.views) {
    const currentInspection =
      view.state === 'rendered' ? view.system.lodOcclusionInspection : undefined;
    projected.push(projectView(view, currentInspection));
    if (view.state !== 'rendered') unavailableReason ??= 'held-view';
    if (
      !view.system.perFrameGraphInfo ||
      view.system.perFrameGraphInfo.generation !== view.graphGeneration
    )
      unavailableReason ??= 'graph-generation-mismatch';
    if (view.state === 'held') continue;
    if (currentInspection === undefined) {
      unavailableReason ??= 'lod-readback-unavailable';
      continue;
    }
    if (
      currentInspection.submit.frameId !== receipt.frameId ||
      currentInspection.submit.deviceGeneration !== receipt.deviceGeneration
    ) {
      unavailableReason ??= 'lod-readback-unavailable';
      continue;
    }
    if (
      currentInspection.view.cameraEntity !== view.entityKey ||
      currentInspection.view.viewGeneration !== view.viewGeneration
    ) {
      unavailableReason ??= 'camera-generation-mismatch';
      continue;
    }
    if (
      currentInspection.view.attachmentId !== view.attachmentId ||
      !capture.leases.some((lease) => lease.worldIdentity === view.attachmentId)
    ) {
      unavailableReason ??= 'attachment-unavailable';
      continue;
    }
    if (
      currentInspection.worlds.some(
        (world) => !capture.leases.some((lease) => lease.worldIdentity === world.attachmentId),
      )
    ) {
      unavailableReason ??= 'world-attribution-unavailable';
      continue;
    }
    if (
      currentInspection.samples.length > MAX_INSPECTION_SAMPLES ||
      currentInspection.worlds.some((world) =>
        world.rows.some((row) => row.samples.length > MAX_INSPECTION_SAMPLES),
      )
    ) {
      unavailableReason ??= 'snapshot-too-large';
      continue;
    }
    const attributedWorlds = currentInspection.worlds.filter(
      (world) =>
        world.rows.length > 0 &&
        world.attribution.status === 'same-submit' &&
        world.attribution.submit.frameId === receipt.frameId &&
        world.attribution.submit.deviceGeneration === receipt.deviceGeneration &&
        world.attribution.submit.build === currentInspection.submit.build,
    );
    const attributed =
      currentInspection.worlds.length > 0 &&
      attributedWorlds.length === currentInspection.worlds.length;
    if (!attributed) {
      unavailableReason ??=
        attributedWorlds.length > 0
          ? 'world-attribution-unavailable'
          : hasUnsupportedLodLane(view.system)
            ? 'unsupported-lod-lane'
            : 'lod-readback-unavailable';
    }
    if (view.system.gpuDrivenInspection.overflow)
      unavailableReason ??= 'world-attribution-unavailable';
  }

  const result: LodOcclusionReceiptObservation =
    unavailableReason === undefined
      ? Object.freeze({
          status: 'complete',
          views: Object.freeze(
            projected.map((view) => {
              if (view.state !== 'rendered' || view.lodOcclusion === undefined)
                throw new Error('complete LOD receipt requires every rendered view inspection');
              return Object.freeze({
                ...view,
                state: 'rendered' as const,
                lodOcclusion: view.lodOcclusion,
              });
            }),
          ),
        })
      : Object.freeze({
          status: 'unavailable',
          reason: unavailableReason,
          views: Object.freeze(projected),
        });
  return fitReceiptObservation(result);
}

export function lodObservationCaptureFailure(
  capture: LodObservationCapture | undefined,
  validity: LodObservationCaptureValidity,
): LodOcclusionReceiptUnavailableReason | undefined {
  return capture === undefined ? undefined : currentCaptureFailure(capture, validity);
}

export function cachedLodObservationMatchesCapture(
  capture: LodObservationCapture | undefined,
  observation: LodOcclusionReceiptObservation,
): boolean {
  if (capture === undefined)
    return (
      observation.status === 'unavailable' &&
      observation.reason === 'not-captured' &&
      observation.views.length === 0
    );
  if (capture.views.length !== observation.views.length) return false;
  return capture.views.every((view, index) => {
    const row = observation.views[index];
    if (
      row === undefined ||
      row.viewKey !== view.viewKey ||
      row.entityKey !== view.entityKey ||
      row.eye !== view.eye ||
      row.attachmentId !== view.attachmentId ||
      row.viewGeneration !== view.viewGeneration ||
      row.graphGeneration !== view.graphGeneration ||
      row.state !== view.state
    )
      return false;
    if (view.state === 'held') return row.lodOcclusion === undefined;
    if (row.lodOcclusion === undefined) return observation.status === 'unavailable';
    return view.system.lodOcclusionInspection === row.lodOcclusion;
  });
}

function ownerInspectionMatchesCapture(
  view: LodObservationViewCapture,
  capture: LodObservationCapture,
  receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration'>,
  inspection: LodOcclusionInspection,
): boolean {
  return (
    inspection.submit.frameId === receipt.frameId &&
    inspection.submit.deviceGeneration === receipt.deviceGeneration &&
    inspection.view.cameraEntity === view.entityKey &&
    inspection.view.viewGeneration === view.viewGeneration &&
    inspection.view.attachmentId === view.attachmentId &&
    inspection.worlds.every((world) =>
      capture.leases.some((lease) => lease.worldIdentity === world.attachmentId),
    )
  );
}

function hasUnsupportedLodLane(system: RenderSystem): boolean {
  return system.gpuDrivenInspection.channels.some(
    (channel) =>
      channel.viewPass === 'main' &&
      channel.lane === 'blocked' &&
      (channel.reason === 'unsupported' || channel.reason === 'capability'),
  );
}

function validateCapture(
  capture: LodObservationCapture,
  validity: LodObservationCaptureValidity,
): LodOcclusionReceiptUnavailableReason | undefined {
  const captureFailure = currentCaptureFailure(capture, validity);
  if (captureFailure !== undefined) return captureFailure;
  for (const lease of capture.leases) {
    if (!validity.isLeaseAttached(lease)) return 'lease-detached';
  }
  for (const view of capture.views) {
    if (view.state === 'held') continue;
    if (view.attachmentId === 'none') return 'attachment-unavailable';
    if (!capture.leases.some((lease) => lease.worldIdentity === view.attachmentId))
      return 'attachment-unavailable';
    if (view.inspection === undefined) return 'lod-readback-unavailable';
    if (view.system.lodOcclusionInspection !== view.inspection) return 'lod-readback-unavailable';
    if (
      view.inspection.submit.frameId !== capture.frameId ||
      view.inspection.submit.deviceGeneration !== capture.deviceGeneration
    )
      return 'lod-readback-unavailable';
    if (
      view.inspection.view.cameraEntity !== view.entityKey ||
      view.inspection.view.viewGeneration !== view.viewGeneration
    )
      return 'camera-generation-mismatch';
    if (view.inspection.view.attachmentId !== view.attachmentId) return 'attachment-unavailable';
    if (!graphMatchesCapture(view)) return 'graph-generation-mismatch';
  }
  return undefined;
}

function currentCaptureFailure(
  capture: LodObservationCapture,
  validity: LodObservationCaptureValidity,
): LodOcclusionReceiptUnavailableReason | undefined {
  if (!validity.isLatest()) return 'superseded';
  if (capture.leases.some((lease) => !validity.isLeaseAttached(lease))) return 'lease-detached';
  if (capture.views.some((view) => !graphMatchesCapture(view))) return 'graph-generation-mismatch';
  if (capture.views.some((view) => !validity.isViewCurrent(view))) return 'view-retired';
  return undefined;
}

function graphMatchesCapture(view: LodObservationViewCapture): boolean {
  const graphInfo = view.system.perFrameGraphInfo;
  return (
    view.graphIncarnation !== undefined &&
    view.system.perFrameGraphIncarnation === view.graphIncarnation &&
    graphInfo !== undefined &&
    graphInfo.generation === view.graphGeneration
  );
}

function roster(
  captures: readonly LodObservationViewCapture[],
): readonly LodOcclusionReceiptViewObservation[] {
  return Object.freeze(
    captures.map((capture) =>
      projectView(capture, capture.state === 'rendered' ? capture.inspection : undefined),
    ),
  );
}

function projectView(
  capture: LodObservationViewCapture,
  inspection: LodOcclusionInspection | undefined,
): LodOcclusionReceiptViewObservation {
  return Object.freeze({
    viewKey: capture.viewKey,
    entityKey: capture.entityKey,
    ...(capture.eye === undefined ? {} : { eye: capture.eye }),
    attachmentId: capture.attachmentId,
    viewGeneration: capture.viewGeneration,
    graphGeneration: capture.graphGeneration,
    state: capture.state,
    ...(inspection === undefined ? {} : { lodOcclusion: inspection }),
  });
}

function fitReceiptObservation(
  observation: LodOcclusionReceiptObservation,
): LodOcclusionReceiptObservation {
  const size = new TextEncoder().encode(JSON.stringify(observation)).byteLength;
  if (size <= MAX_RECEIPT_OBSERVATION_BYTES) return observation;
  const views = observation.views.map((view) =>
    Object.freeze({
      viewKey: view.viewKey,
      entityKey: view.entityKey,
      ...('eye' in view ? { eye: view.eye } : {}),
      attachmentId: view.attachmentId,
      viewGeneration: view.viewGeneration,
      graphGeneration: view.graphGeneration,
      state: view.state,
    }),
  );
  const bounded: LodOcclusionReceiptObservation = Object.freeze({
    status: 'unavailable',
    reason: 'snapshot-too-large',
    views: Object.freeze(views),
  });
  if (new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= MAX_RECEIPT_OBSERVATION_BYTES)
    return bounded;
  return Object.freeze({
    status: 'unavailable',
    reason: 'snapshot-too-large',
    views: Object.freeze([]),
  });
}
