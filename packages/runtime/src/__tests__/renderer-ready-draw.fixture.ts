import type { FrameReceipt } from '@forgeax/engine-render';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';

/** The statistics consume every declared pixel; invalid records remain failures. */
export function requireValidReflectionSignal(signal: Float32Array, pixels: number, label: string) {
  let invalidPixels = 0;
  let nonfiniteValues = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    if (signal[pixel * 4 + 3] !== 1) invalidPixels++;
    for (let channel = 0; channel < 4; channel++) {
      if (!Number.isFinite(signal[pixel * 4 + channel])) nonfiniteValues++;
    }
  }
  if (signal.length !== pixels * 4 || invalidPixels > 0 || nonfiniteValues > 0)
    throw new Error(`${label}: reflection signal is not valid for statistics`, {
      cause: {
        code: 'fixture-reflection-signal-invalid',
        label,
        expectedValues: pixels * 4,
        actualValues: signal.length,
        invalidPixels,
        nonfiniteValues,
      },
    });
}

/** Advance once, then let the ready-frame owner resubmit the unchanged scene. */
export async function completeFixturePicture(
  submitPicture: () => FrameReceipt | Promise<FrameReceipt>,
  submitPrepared: () => FrameReceipt | Promise<FrameReceipt>,
) {
  let firstSubmission = true;
  return completeReadyFrame(() => {
    if (!firstSubmission) return submitPrepared();
    firstSubmission = false;
    return submitPicture();
  });
}
