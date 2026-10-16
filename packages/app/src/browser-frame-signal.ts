/**
 * Browser-visible render progress owned by the App frame loop.
 *
 * The Renderer already emits `frame-submitted` after its sole queue-submit
 * boundary. This adapter projects that event onto the document without
 * exposing a renderer handle or creating a second readiness registry. DevKit
 * capture waits on the same projection, then verifies compositor pixels.
 */

import { freezeBarrelDistortionMapping } from '@forgeax/engine-render';

export const FORGEAX_FRAME_SUBMITTED_DATASET = 'forgeaxFrameSubmitted';
export const FORGEAX_FRAME_SUBMITTED_EVENT = 'forgeax:frame-submitted';
export const FORGEAX_FRAME_COMPLETED_DATASET = 'forgeaxFrameCompleted';
export const FORGEAX_FRAME_COMPLETED_EVENT = 'forgeax:frame-completed';

export interface BrowserFrameSubmitted {
  readonly frameId: number;
  readonly deviceGeneration: number;
  /** Compiled graph identity paired with this submitted picture. */
  readonly graphGeneration?: number;
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
  readonly frameId: number;
  readonly deviceGeneration: number;
  /** World/session identity owned by the active App execution. */
  readonly worldIdentity?: string;
  readonly presentation: import('@forgeax/engine-render').FramePresentation;
}

const submittedFrame = Symbol('forgeax.submitted-frame');
type FrameCanvas = HTMLCanvasElement & { [submittedFrame]?: BrowserFrameSubmitted };

/** Read the canvas owner's accepted frame; reset invalidates this baseline. */
export function readBrowserFrameSubmitted(
  canvas: HTMLCanvasElement,
): BrowserFrameSubmitted | undefined {
  return (canvas as FrameCanvas)[submittedFrame];
}

export function resetBrowserFrameSubmitted(canvas: HTMLCanvasElement): void {
  delete (canvas as FrameCanvas)[submittedFrame];
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    delete documentElement.dataset[FORGEAX_FRAME_SUBMITTED_DATASET];
    delete documentElement.dataset[FORGEAX_FRAME_COMPLETED_DATASET];
  }
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
  (canvas as FrameCanvas)[submittedFrame] = published;
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    documentElement.dataset[FORGEAX_FRAME_SUBMITTED_DATASET] = String(published.frameId);
  }
  // Dawn-node smoke canvases intentionally expose only the drawing-buffer
  // surface; they are not DOM EventTargets. Keep the document projection
  // above useful for those hosts, while dispatching the browser event only
  // when the host actually provides the optional EventTarget capability.
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
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    documentElement.dataset[FORGEAX_FRAME_COMPLETED_DATASET] = String(event.frameId);
  }
  if (typeof CustomEvent === 'function' && typeof canvas.dispatchEvent === 'function') {
    canvas.dispatchEvent(
      new CustomEvent(FORGEAX_FRAME_COMPLETED_EVENT, {
        detail: Object.freeze({ ...event }),
      }),
    );
  }
}
