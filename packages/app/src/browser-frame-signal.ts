/**
 * Browser-visible render progress owned by the App frame loop.
 *
 * The Renderer already emits `frame-submitted` after its sole queue-submit
 * boundary. The canvas snapshot retains the latest submitted and completed
 * facts for late readers; events only notify current subscribers.
 */

import { freezeBarrelDistortionMapping } from '@forgeax/engine-render';

export const FORGEAX_FRAME_SUBMITTED_EVENT = 'forgeax:frame-submitted';
export const FORGEAX_FRAME_COMPLETED_EVENT = 'forgeax:frame-completed';

export interface BrowserFrameSubmitted {
  readonly shadowWorkload?: import('@forgeax/engine-render').ShadowWorkloadObservation;
  readonly frameId: number;
  readonly deviceGeneration: number;
  /** Compiled graph identity paired with this submitted picture. */
  readonly graphGeneration?: number;
  /**
   * Render Worker cadence: milliseconds between the start of the previous
   * draw and this one on the Render Worker clock. Absent for the first draw
   * of a session and for in-process execution.
   */
  readonly renderDrawIntervalMs?: number;
  /** World/session identity owned by the active App execution. */
  readonly worldIdentity?: string;
  /**
   * Effective output mapping published with the accepted frame. `undefined`
   * means no accepted submitted display context is available; it is not an
   * identity mapping and display consumers must reject the query.
   */
  readonly barrelDistortion?: import('@forgeax/engine-render').BarrelDistortionMapping;
  /**
   * The in-process App loop forwards the exact receipt. Worker execution
   * transports the serializable mapping POD alongside frame identity because
   * a receipt's completion promise is not transferable; consumers must gate
   * receipt-bound work on the published frame.
   */
  readonly receipt?: import('@forgeax/engine-render').FrameReceipt;
}

export interface BrowserFrameCompleted {
  readonly shadowWorkload?: import('@forgeax/engine-render').ShadowWorkloadObservation;
  readonly frameId: number;
  readonly deviceGeneration: number;
  /** World/session identity owned by the active App execution. */
  readonly worldIdentity?: string;
  /** Output mapping of this completed receipt, independent of later canvas resizes. */
  readonly barrelDistortion?: import('@forgeax/engine-render').BarrelDistortionMapping;
  readonly presentation: import('@forgeax/engine-render').FramePresentation;
  readonly presentationPendingReason?: import('@forgeax/engine-render').FramePresentationPendingReason;
  /**
   * Render Worker milliseconds from queue submission to completion of this
   * frame (GPU completion plus in-order completion of earlier frames).
   * Absent for in-process execution.
   */
  readonly renderSubmitToCompleteMs?: number;
}

export interface BrowserFrameProgress {
  readonly submitted?: BrowserFrameSubmitted;
  readonly completed?: BrowserFrameCompleted;
}

declare global {
  interface HTMLCanvasElement {
    forgeaxFrameProgress?: BrowserFrameProgress;
  }
}

export function readBrowserFrameSubmitted(
  canvas: HTMLCanvasElement,
): BrowserFrameSubmitted | undefined {
  return canvas.forgeaxFrameProgress?.submitted;
}

export function resetBrowserFrameProgress(canvas: HTMLCanvasElement): void {
  delete canvas.forgeaxFrameProgress;
}

export function publishBrowserFrameSubmitted(
  canvas: HTMLCanvasElement,
  event: BrowserFrameSubmitted,
): void {
  const published = Object.freeze({
    ...event,
    ...(event.graphGeneration === undefined ? {} : { graphGeneration: event.graphGeneration }),
    ...(event.barrelDistortion === undefined
      ? {}
      : { barrelDistortion: freezeBarrelDistortionMapping(event.barrelDistortion) }),
  });
  canvas.forgeaxFrameProgress = Object.freeze({
    ...canvas.forgeaxFrameProgress,
    submitted: published,
  });
  // Dawn-node smoke canvases expose only the drawing-buffer surface; browser
  // event dispatch is optional there, while the internal snapshot remains.
  if (typeof CustomEvent === 'function' && typeof canvas.dispatchEvent === 'function') {
    canvas.dispatchEvent(
      new CustomEvent(FORGEAX_FRAME_SUBMITTED_EVENT, {
        detail: published,
      }),
    );
  }
}

/** Subscribe to immutable submitted-frame facts on a browser canvas. */
export function subscribeBrowserFrameSubmitted(
  canvas: HTMLCanvasElement,
  listener: (event: BrowserFrameSubmitted) => void,
): () => void {
  if (typeof canvas.addEventListener !== 'function') return () => undefined;
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<BrowserFrameSubmitted>).detail;
    if (detail === undefined) return;
    listener(detail);
  };
  canvas.addEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, handler);
  return () => canvas.removeEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, handler);
}

/** Publish only after the matching FrameReceipt completed successfully. */
export function publishBrowserFrameCompleted(
  canvas: HTMLCanvasElement,
  event: BrowserFrameCompleted,
): void {
  const published = Object.freeze({ ...event });
  canvas.forgeaxFrameProgress = Object.freeze({
    ...canvas.forgeaxFrameProgress,
    completed: published,
  });
  if (typeof CustomEvent === 'function' && typeof canvas.dispatchEvent === 'function') {
    canvas.dispatchEvent(
      new CustomEvent(FORGEAX_FRAME_COMPLETED_EVENT, {
        detail: published,
      }),
    );
  }
}
