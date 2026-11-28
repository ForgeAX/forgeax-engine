import type { RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { MotionBlurExecutionReceipt } from '../../inspection-types';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderFeatureResolvedGpuComputePass } from '../prepared-gpu-work';

export const MOTION_BLUR_FEATURE_IDENTITY = 'forgeax.motion-blur';

type Workgroups = readonly [number, number, number];
type MotionBlurEntry = 'tile_summary' | 'reconstruct';

export interface StagedMotionBlurExecution {
  readonly summary?: Workgroups;
  readonly receipt: MotionBlurExecutionReceipt | undefined;
}

export const EMPTY_MOTION_BLUR_EXECUTION: StagedMotionBlurExecution = { receipt: undefined };

export interface MotionBlurExecutionFrame extends RenderGraphFrame {
  readonly motionBlurEvidence?: RenderFrameState | undefined;
  readonly motionBlurDeviceGeneration?: number | undefined;
}

/** Record only direct dispatches on the live encoder. Replays have no evidence sink. */
export function recordMotionBlurDispatch(
  frame: RenderGraphFrame,
  entryPoint: MotionBlurEntry,
  workgroups: Workgroups,
): void {
  const { motionBlurEvidence: frameState, motionBlurDeviceGeneration } =
    frame as MotionBlurExecutionFrame;
  if (frameState === undefined || workgroups[0] * workgroups[1] * workgroups[2] === 0) return;
  if (entryPoint === 'tile_summary') {
    frameState.stagedMotionBlurExecution = { summary: workgroups, receipt: undefined };
    return;
  }
  const summary = frameState.stagedMotionBlurExecution?.summary;
  if (summary === undefined || motionBlurDeviceGeneration === undefined) return;
  frameState.stagedMotionBlurExecution = {
    receipt: {
      frameId: frameState.frameNumber,
      deviceGeneration: motionBlurDeviceGeneration,
      graphGeneration: frameState.graphGeneration,
      program: 'motion-blur-compute',
      outputFormat: 'rgba16float',
      passes: [
        {
          name: 'motion-blur-tile-summary',
          kind: 'compute',
          entryPoint: 'tile_summary',
          workgroups: summary,
        },
        { name: 'motion-blur', kind: 'compute', entryPoint, workgroups },
      ],
    },
  };
}

/** The built-in feature's two direct passes share an rgba16float storage layout. */
export function motionBlurFeatureEntry(
  identity: string,
  name: string,
): MotionBlurEntry | undefined {
  if (identity !== MOTION_BLUR_FEATURE_IDENTITY) return undefined;
  if (name === 'motion-blur-tile-summary') return 'tile_summary';
  if (name === 'motion-blur') return 'reconstruct';
  return undefined;
}

export function recordMotionBlurFeatureDispatch(
  frame: RenderGraphFrame,
  entry: MotionBlurEntry,
  work: RenderFeatureResolvedGpuComputePass,
): void {
  const dispatch = work.dispatches[0];
  if (dispatch !== undefined && 'workgroups' in dispatch)
    recordMotionBlurDispatch(frame, entry, dispatch.workgroups);
}
