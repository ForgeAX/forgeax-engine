import { getRenderFeaturePlanExecutionProjection } from '../features/host';
import type { RenderFeaturePlannedFrame } from '../features/plan';
import type { MotionBlurExecutionPass, MotionBlurExecutionReceipt } from '../inspection-types';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

/**
 * Project one accepted Motion Blur compute execution from the same graph and
 * resolved dispatch objects used by the encoder. A plan/capability candidate
 * without both executed passes deliberately returns no receipt.
 */
export function deriveMotionBlurExecutionReceipt(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  plans: readonly RenderFeaturePlannedFrame[],
): MotionBlurExecutionReceipt | undefined {
  const graph = frameState.compiledFrameGraph?.graph ?? null;
  const deviceGeneration = internals.deviceScope?.generation;
  if (graph === null || deviceGeneration === undefined) return undefined;
  const info = graph.inspect();
  const graphPasses = new Map(info.passes.map((pass) => [pass.name, pass]));
  const summaryGraphPass = graphPasses.get('motion-blur-tile-summary');
  const reconstructGraphPass = graphPasses.get('motion-blur');
  if (summaryGraphPass?.kind !== 'compute' || reconstructGraphPass?.kind !== 'compute') {
    return undefined;
  }
  const planned = plans.find((candidate) => candidate.featureIdentity === 'forgeax.motion-blur');
  const execution =
    planned === undefined ? undefined : getRenderFeaturePlanExecutionProjection(planned);
  if (execution === undefined || execution.featureIdentity !== 'forgeax.motion-blur') {
    return undefined;
  }
  const executionPass = (name: 'motion-blur-tile-summary' | 'motion-blur') =>
    execution.passes.find((pass) => pass.name === name);
  const summary = executionPass('motion-blur-tile-summary');
  const reconstruct = executionPass('motion-blur');
  if (
    summary?.gpuCompute === undefined ||
    reconstruct?.gpuCompute === undefined ||
    summary.resolvedGpuCompute === undefined ||
    reconstruct.resolvedGpuCompute === undefined
  ) {
    return undefined;
  }
  const directWorkgroups = (
    pass: NonNullable<typeof summary.resolvedGpuCompute>,
  ): readonly [number, number, number] | undefined => {
    const dispatch = pass.dispatches[0];
    if (dispatch === undefined || !('workgroups' in dispatch)) return undefined;
    return dispatch.workgroups;
  };
  const summaryWorkgroups = directWorkgroups(summary.resolvedGpuCompute);
  const reconstructWorkgroups = directWorkgroups(reconstruct.resolvedGpuCompute);
  if (summaryWorkgroups === undefined || reconstructWorkgroups === undefined) return undefined;
  const outputResource = info.resources.find(
    (resource) =>
      resource.label === 'motion-blurred-color' ||
      reconstructGraphPass.accesses.some(
        (access) => access.resource === resource.label && access.usage === 'storage-write',
      ),
  );
  if (
    outputResource?.descriptor.kind !== 'texture' ||
    outputResource.descriptor.format !== 'rgba16float'
  ) {
    return undefined;
  }
  const summaryReceipt: MotionBlurExecutionPass = {
    name: 'motion-blur-tile-summary',
    kind: 'compute',
    entryPoint: 'tile_summary',
    workgroups: summaryWorkgroups,
  };
  const reconstructReceipt: MotionBlurExecutionPass = {
    name: 'motion-blur',
    kind: 'compute',
    entryPoint: 'reconstruct',
    workgroups: reconstructWorkgroups,
  };
  return Object.freeze({
    frameId: frameState.frameNumber,
    deviceGeneration,
    // RenderGraphBuilder generations are process-global. The renderer's
    // frame-state generation is the identity used by inspection and by the
    // same-frame admission check below, so retain that owner-scoped value.
    graphGeneration: frameState.graphGeneration,
    program: 'motion-blur-compute' as const,
    outputFormat: 'rgba16float' as const,
    passes: [summaryReceipt, reconstructReceipt] as const,
  });
}
