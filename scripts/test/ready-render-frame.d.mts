import type {
  FrameReceipt,
  Renderer,
  RenderFrameInput,
  RenderWorldLease,
} from '@forgeax/engine-render';

export interface ReadyFrameOptions {
  /** Total settlement budget (default 90 s). Submission, pending/steady GPU and
   * default compilation waits retain 15 s bounds. After signalled pipeline
   * preparation, the first ready GPU completion uses the remaining owner budget. */
  readonly timeoutMs?: number;
  /** Existing archive startup signal; the helper consumes only success or failure. */
  readonly preparationCompleted?: PromiseLike<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  >;
  /** Consume a completed physical receipt before retry/return (at most 15 s). */
  readonly onCompleted?: (receipt: FrameReceipt) => void | Promise<void>;
}

/** Submit one ready scene picture while the caller retains its lease and World. */
export function drawSceneFrame(
  renderer: Parameters<typeof drawReadyFrame>[0],
  scene: RenderWorldLease,
): Promise<FrameReceipt>;

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
