import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { compiledRenderGraphGeneration } from '@forgeax/engine-render-graph';
import type {
  LodOcclusionInspection,
  LodOcclusionReceiptObservation,
  LodOcclusionReceiptUnavailableReason,
  LodOcclusionReceiptViewObservation,
} from '../inspection-types';
import { MAX_INSPECTION_SAMPLES, MAX_RECEIPT_OBSERVATION_BYTES } from '../observation-budget';
import type { FrameReceipt } from '../render-contract';
import type { LodOcclusionInspectionCell } from '../render-system';
import type { ViewSettlementOwner } from '../world/view-settlement';

export type LodObservationSourceCapture =
  | {
      readonly kind: 'local';
      readonly lease: RenderReadLease;
      readonly worldIdentity: string;
      readonly generation: number;
    }
  | {
      readonly kind: 'publication';
      readonly worldIdentity: string;
      readonly resources: import('../publication/resource-scope').RenderResourceScope;
      readonly revision: number;
    };

export interface LodObservationViewCapture {
  readonly viewKey: string;
  readonly entityKey: number;
  readonly eye: 'left' | 'right' | undefined;
  readonly attachmentId: string;
  readonly viewGeneration: number;
  readonly graphGeneration: number;
  readonly graphIncarnation: object | undefined;
  readonly state: 'rendered' | 'held';
  /** The view's owner bag: its LOD cell, compiled graph and GPU-driven production. */
  readonly owner: ViewSettlementOwner;
  readonly viewRef: object | undefined;
  readonly primary: boolean;
  readonly inspection: LodOcclusionInspectionCell | undefined;
}

export interface LodObservationCapture {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly views: readonly LodObservationViewCapture[];
  readonly source: LodObservationSourceCapture | undefined;
}

export interface LodObservationCaptureValidity {
  readonly isLatest: () => boolean;
  readonly isViewCurrent: (view: LodObservationViewCapture) => boolean;
  readonly isSourceAttached: (source: LodObservationSourceCapture) => boolean;
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
    const cell = view.owner.lod.cell;
    if (cell !== view.inspection)
      return unavailableLodObservation('lod-readback-unavailable', roster(capture.views));
    const ownerInspection = await view.owner.lod.observe(
      view.owner.gpuDriven,
      view.owner.surfaceSubmission,
      { frameId: receipt.frameId, deviceGeneration: receipt.deviceGeneration },
    );
    const captureFailureAfterRead = currentCaptureFailure(capture, validity);
    if (captureFailureAfterRead !== undefined)
      return unavailableLodObservation(captureFailureAfterRead, roster(capture.views));
    const currentCell = view.owner.lod.cell;
    if (
      (ownerInspection === undefined && currentCell !== cell) ||
      (ownerInspection !== undefined &&
        (currentCell?.value() !== ownerInspection ||
          !ownerInspectionMatchesCapture(view, capture, receipt, ownerInspection)))
    )
      return unavailableLodObservation('lod-readback-unavailable', roster(capture.views));
  }

  const projected: LodOcclusionReceiptViewObservation[] = [];
  let unavailableReason: LodOcclusionReceiptUnavailableReason | undefined;
  for (const view of capture.views) {
    const currentInspection = view.state === 'rendered' ? view.owner.lod.cell?.value() : undefined;
    projected.push(projectView(view, currentInspection));
    if (view.state !== 'rendered') unavailableReason ??= 'held-view';
    if (!graphMatchesGeneration(view)) unavailableReason ??= 'graph-generation-mismatch';
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
      capture.source?.worldIdentity !== view.attachmentId
    ) {
      unavailableReason ??= 'attachment-unavailable';
      continue;
    }
    if (currentInspection.samples.length > MAX_INSPECTION_SAMPLES) {
      unavailableReason ??= 'snapshot-too-large';
      continue;
    }
    const attribution = currentInspection.attribution;
    const attributed =
      attribution.status === 'same-submit' &&
      attribution.submit.frameId === receipt.frameId &&
      attribution.submit.deviceGeneration === receipt.deviceGeneration &&
      attribution.submit.build === currentInspection.submit.build;
    if (!attributed)
      unavailableReason ??= hasUnsupportedLodLane(view.owner)
        ? 'unsupported-lod-lane'
        : 'lod-readback-unavailable';
    if (gpuDrivenInspectionOf(view.owner).overflow)
      unavailableReason ??= 'source-attribution-unavailable';
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
    return view.owner.lod.cell?.value() === row.lodOcclusion;
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
    capture.source?.worldIdentity === view.attachmentId
  );
}

function gpuDrivenInspectionOf(owner: ViewSettlementOwner) {
  return owner.gpuDriven.inspect(owner.skin.paletteUploadBytes);
}

function hasUnsupportedLodLane(owner: ViewSettlementOwner): boolean {
  return gpuDrivenInspectionOf(owner).channels.some(
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
  if (capture.source === undefined || !validity.isSourceAttached(capture.source))
    return 'lease-detached';
  for (const view of capture.views) {
    if (view.state === 'held') continue;
    if (view.attachmentId === 'none') return 'attachment-unavailable';
    if (capture.source?.worldIdentity !== view.attachmentId) return 'attachment-unavailable';
    if (view.inspection === undefined) return 'lod-readback-unavailable';
    if (view.owner.lod.cell !== view.inspection) return 'lod-readback-unavailable';
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
  if (capture.source === undefined || !validity.isSourceAttached(capture.source))
    return 'lease-detached';
  if (capture.views.some((view) => !graphMatchesCapture(view))) return 'graph-generation-mismatch';
  if (capture.views.some((view) => !validity.isViewCurrent(view))) return 'view-retired';
  return undefined;
}

/** The compiled-graph generation and incarnation a view's owner currently holds. */
export function graphFacts({ frameState }: ViewSettlementOwner) {
  const graph = frameState.compiledFrameGraph?.graph;
  return {
    generation: graph === undefined ? 0 : compiledRenderGraphGeneration(graph),
    incarnation: graph as object | undefined,
  };
}

function graphMatchesGeneration(view: LodObservationViewCapture): boolean {
  const graph = view.owner.frameState.compiledFrameGraph?.graph;
  return graph !== undefined && compiledRenderGraphGeneration(graph) === view.graphGeneration;
}

function graphMatchesCapture(view: LodObservationViewCapture): boolean {
  const graph = view.owner.frameState.compiledFrameGraph?.graph;
  return (
    view.graphIncarnation !== undefined &&
    graph === view.graphIncarnation &&
    compiledRenderGraphGeneration(graph) === view.graphGeneration
  );
}

function roster(
  captures: readonly LodObservationViewCapture[],
): readonly LodOcclusionReceiptViewObservation[] {
  return Object.freeze(
    captures.map((capture) =>
      projectView(capture, capture.state === 'rendered' ? capture.inspection?.value() : undefined),
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
