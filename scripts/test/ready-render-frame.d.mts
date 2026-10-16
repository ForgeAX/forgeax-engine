import type { FrameReceipt, Renderer, RenderFrameInput } from '@forgeax/engine-render';

/** Wait for one ready scene submission; the caller retains World/time ownership. */
export function drawReadyFrame(
  renderer: Pick<Renderer, 'draw' | 'requestObservation'>,
  request: RenderFrameInput,
  observation?: Parameters<NonNullable<Renderer['requestObservation']>>[0],
): Promise<FrameReceipt>;

/** Submitters retain publication ownership and never advance World on retry. */
export function completeReadyFrame(
  submit: () => FrameReceipt | Promise<FrameReceipt>,
): Promise<FrameReceipt>;

/** App retains simulation time; only ready submissions count toward acceptance. */
export function driveReadyAppFrames(
  renderer: Pick<Renderer, 'subscribe'>,
  tick: () => boolean | void | Promise<boolean | void>,
  count?: number,
): Promise<number>;
