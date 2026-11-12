import type { GpuPassTimingError } from '../record/gpu-pass-timing/errors.js';
import type {
  GpuPassTimingCapture,
  GpuPassTimingObservation,
} from '../record/gpu-pass-timing/index.js';

export async function projectGpuPassTimingCapture(
  capture: GpuPassTimingCapture,
  failed: (error: GpuPassTimingError) => GpuPassTimingObservation,
): Promise<GpuPassTimingObservation> {
  const observed = await capture.observe();
  if (!observed.ok) return failed(observed.error);
  const frame = observed.value;
  const unmeasured = frame.passes.find((pass) => pass.status === 'unmeasured');
  if (unmeasured !== undefined) {
    return { status: 'partial', frame, reason: unmeasured.reason };
  }
  if (frame.droppedPassCount > 0) {
    return {
      status: 'partial',
      frame,
      reason: {
        code: 'query-budget-exceeded',
        expected: 'all executed passes fit within the bounded query budget',
        hint: 'increase maxPassesPerFrame or simplify the pass graph',
        detail: { droppedPassCount: frame.droppedPassCount },
      },
    };
  }
  return { status: 'complete', frame };
}
