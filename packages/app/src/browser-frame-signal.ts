/**
 * Browser-visible render progress owned by the App frame loop.
 *
 * The Renderer already emits `frame-submitted` after its sole queue-submit
 * boundary. The canvas snapshot retains the latest submitted and completed
 * facts for late readers; events only notify current subscribers.
 */

import { freezeBarrelDistortionMapping } from '@forgeax/engine-render';
import { loadTimelineNow, recordLoadTimeline } from '@forgeax/engine-types';

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
  /**
   * Always-on Render Worker stall accounting (Render Worker clock, 0.01 ms).
   * The draw interval decomposes as previous turn (previous
   * `renderDrawCpuMs` plus its post-submit tail) + `renderAwaitMs` +
   * `renderQueuedMs`. All are absent for in-process execution.
   *
   * `renderDrawCpuMs`: draw start to queue submission of this frame.
   */
  readonly renderDrawCpuMs?: number;
  /**
   * Idle time waiting for this draw message: its arrival minus the end of the
   * previous draw turn; 0 when it arrived while that turn was still running.
   */
  readonly renderAwaitMs?: number;
  /** Draw start minus max(arrival, previous turn end): wait behind the serial drain. */
  readonly renderQueuedMs?: number;
  /** Engine Worker `world.update` milliseconds for the published frame. */
  readonly engineUpdateMs?: number;
  /** Engine Worker milliseconds waiting for publication credit before that update (0 = none). */
  readonly engineCreditWaitMs?: number;
  /** Render graphs compiled during this draw turn. */
  readonly renderGraphCompiles?: number;
  /** Native WebGPU pipelines created (sync + async) during this draw turn; 0 on other backends. */
  readonly renderPipelineCreations?: number;
  /**
   * Largest contributor to this frame's draw interval: `render-cpu` (previous
   * turn), `credit` / `simulation` (Engine credit wait / World update share of
   * the await), `publication` (rest of the await: Host admission, vsync,
   * transport) or `queue` (`renderQueuedMs`). Absent on the first draw.
   */
  readonly renderStallReason?: 'render-cpu' | 'credit' | 'simulation' | 'publication' | 'queue';
  /**
   * Render Worker RHI commands encoded since the previous submitted frame
   * (draws, pipeline and bind group sets, bundle replays, buffer and texture
   * writes and bytes, resource creation). CPU-side call counts, identical with
   * the WebGPU stub and a real GPU. Absent for the first draw of a session and
   * for in-process execution.
   */
  readonly rhiCommands?: import('@forgeax/engine-rhi-webgpu').RhiCommandCounts;
  /**
   * Bytes of the publication this frame drew: frame columns and transferred
   * asset buffers (see `renderPublicationBytes`). Absent for in-process execution.
   */
  readonly publicationBytes?: { readonly columns: number; readonly assets: number };
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

/**
 * Load timeline milestones per canvas and World: the first submitted frame
 * starts the span, the first completed frame and the first presented (`ready`)
 * frame end one each. A rebuilt World records its own milestones.
 */
interface FrameMilestones {
  world: string;
  firstSubmitted?: number;
  completed: boolean;
  presented: boolean;
}
const frameMilestones = new WeakMap<HTMLCanvasElement, FrameMilestones>();

function milestonesFor(canvas: HTMLCanvasElement, world: string | undefined): FrameMilestones {
  const key = world ?? '';
  let current = frameMilestones.get(canvas);
  if (current === undefined || current.world !== key) {
    current = { world: key, completed: false, presented: false };
    frameMilestones.set(canvas, current);
  }
  return current;
}

function recordFrameMilestone(canvas: HTMLCanvasElement, event: BrowserFrameCompleted): void {
  const milestones = milestonesFor(canvas, event.worldIdentity);
  const presented = event.presentation === 'ready';
  if (milestones.completed && (milestones.presented || !presented)) return;
  const end = loadTimelineNow();
  const start = milestones.firstSubmitted ?? end;
  const detail = { frameId: event.frameId, world: milestones.world };
  if (!milestones.completed) {
    milestones.completed = true;
    recordLoadTimeline('frame', 'first-completed-frame', start, end, undefined, detail);
  }
  if (presented && !milestones.presented) {
    milestones.presented = true;
    recordLoadTimeline('frame', 'first-presented-frame', start, end, undefined, detail);
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
  const milestones = milestonesFor(canvas, event.worldIdentity);
  milestones.firstSubmitted ??= loadTimelineNow();
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
  recordFrameMilestone(canvas, event);
  if (typeof CustomEvent === 'function' && typeof canvas.dispatchEvent === 'function') {
    canvas.dispatchEvent(
      new CustomEvent(FORGEAX_FRAME_COMPLETED_EVENT, {
        detail: published,
      }),
    );
  }
}
