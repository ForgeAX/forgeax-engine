import type { FrameReceipt, Renderer, RenderFrameInput } from '@forgeax/engine-render';

export interface ReadyFrameOptions {
  /** Total settlement budget (default 90 s). Submission, pending/steady GPU and
   * default compilation waits retain 15 s bounds. After signalled pipeline
   * preparation, the first ready GPU completion uses the remaining owner budget. */
  readonly timeoutMs?: number;
  /** Consume a completed physical receipt before retry/return (at most 15 s). */
  readonly onCompleted?: (receipt: FrameReceipt) => void | Promise<void>;
}

/** Await Engine preparation, GPU completion and one ready scene submission.
 * The caller retains World/time ownership; pending observations recycle before retry. */
export function drawReadyFrame(
  renderer: Pick<Renderer, 'draw' | 'requestObservation' | 'observe'>,
  request: RenderFrameInput,
  observation?: Parameters<NonNullable<Renderer['requestObservation']>>[0],
  options?: ReadyFrameOptions,
): Promise<FrameReceipt>;

/** Submitters retain publication ownership and never advance World on retry. */
export function completeReadyFrame(
  submit: () => FrameReceipt | Promise<FrameReceipt>,
  options?: ReadyFrameOptions,
): Promise<FrameReceipt>;

/** App retains simulation time; only ready submissions count toward acceptance. */
export function driveReadyAppFrames(
  renderer: Pick<Renderer, 'subscribe'>,
  tick: () => boolean | void | Promise<boolean | void>,
  count?: number,
): Promise<number>;
