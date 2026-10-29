import type { FrameReceipt } from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';

export type DarkGradientPhase = 'none' | 'fxaa';

/** Collect a completed ready sample window before arming its receipt-bound picture. */
export function createDarkGradientSampler(frameCount: number) {
  const counts = { none: 0, fxaa: 0 };
  const captures: Partial<Record<DarkGradientPhase, number>> = {};
  return {
    arm(phase: DarkGradientPhase, frameId: number): boolean {
      if (counts[phase] < frameCount || captures[phase] !== undefined) return false;
      captures[phase] = frameId;
      return true;
    },
    async complete(phase: DarkGradientPhase, receipt: FrameReceipt) {
      const completed = await receipt.completed;
      if (!completed.ok) return err(completed.error);
      if (receipt.presentation !== 'ready') {
        if (captures[phase] === receipt.frameId) delete captures[phase];
        return ok(false);
      }
      counts[phase] = Math.min(frameCount, counts[phase] + 1);
      return ok(captures[phase] === receipt.frameId);
    },
  };
}
