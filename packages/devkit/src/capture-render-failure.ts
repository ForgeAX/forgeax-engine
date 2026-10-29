// One verdict for "does this captured frame show a rendered canvas", shared by
// browser capture, `dev capture` and `project play`.
import type { BrowserCaptureRecord } from './browser-capture.js';

/**
 * The latest Engine renderer failure (GPU validation, submit, device loss) seen
 * by the generated development host, from `__forgeaxGameInspection.renderer()`.
 * The game loop and DOM HUD keep running while the canvas stops presenting.
 */
export interface CaptureRendererError {
  readonly code: string;
  readonly message: string;
  /** Completed Engine frame when the latest error was dispatched. */
  readonly frame: number;
  /** Completed frames since then, at capture time. */
  readonly framesAgo: number;
  /** Renderer errors since the App started. */
  readonly count: number;
}

/** A renderer error at most this many completed frames old fails the capture. */
export const RENDERER_ERROR_RECENT_FRAMES = 60;

export interface CaptureRenderFailure {
  readonly reason: 'renderer-error' | 'flat-canvas';
  /** One line for the agent: what failed and where to look next. */
  readonly hint: string;
}

/** Why a captured frame does not show a rendered canvas; `undefined` when it does. */
export function captureRenderFailure(
  record: Pick<BrowserCaptureRecord, 'pixels' | 'runtime'>,
): CaptureRenderFailure | undefined {
  const error = record.runtime.rendererError;
  if (error != null && error.framesAgo <= RENDERER_ERROR_RECENT_FRAMES) {
    const what = error.code === 'queue-submit-failed' ? 'GPU submit failed' : 'Renderer error';
    const message = error.message.replace(/\s+/g, ' ').trim();
    return {
      reason: 'renderer-error',
      hint: `${what}; the canvas is not presented (${error.code} at frame ${error.frame}, ${error.count} since start): ${message.length > 160 ? `${message.slice(0, 159)}…` : message} See skills/forgeax-engine-rhi-debug.`,
    };
  }
  if (!record.pixels.rendered)
    return {
      reason: 'flat-canvas',
      hint: 'The canvas is one uniform color; check the camera and visible content, or a black render.',
    };
  return undefined;
}
