import type { FrameObservationRequest, FrameReceipt, Renderer } from '../render-contract';

const consume = (
  renderer: Renderer,
  receipt: FrameReceipt,
  request: FrameObservationRequest,
): Promise<boolean> => renderer.observe(receipt, request).then((result) => result.ok);
void consume;
