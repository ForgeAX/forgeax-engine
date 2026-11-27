import {
  encodeNativeRenderPass,
  type GraphBufferAccess,
  type RenderGraphFrame,
  type RenderGraphNativePass,
  type RenderGraphPassInstrumentation,
} from '@forgeax/engine-render-graph';
import type { Buffer, RhiCaps } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import {
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
  type RenderFeatureFrameResult,
  type RenderFeaturePlanExecution,
  type RenderFeaturePlanExecutionPass,
} from './host';
import type { RenderFeatureResourceDeclaration } from './plan';
import { issueFeatureComputeCommands } from './render-graph-compute';

// This is a conservative admission subset, not a replacement graph validator.
// Anything outside it retains the original compile-time error authority.
const computeBufferUsage: Partial<Record<GraphBufferAccess, number>> = {
  'uniform-read': 0x0040,
  'storage-read': 0x0080,
  'storage-write': 0x0080,
  'storage-read-write': 0x0080,
  'indirect-read': 0x0100,
};

export interface SharedFeatureCommandFrame extends RenderGraphFrame {
  readonly reportError?: ((error: RenderError) => void) | undefined;
}

function bufferResource(resource: RenderFeatureResourceDeclaration): boolean {
  return (
    resource.kind === 'buffer' ||
    resource.kind === 'compute-program' ||
    resource.kind === 'compute-bindings' ||
    (resource.kind === 'prepared-gpu-resource' &&
      resource.resource.kind === 'buffer' &&
      resource.logicalTarget === undefined)
  );
}

function bufferPass(pass: RenderFeaturePlanExecutionPass): boolean {
  if (
    pass.temporal !== undefined ||
    pass.shadowCaster ||
    pass.graphics !== undefined ||
    pass.graphicsState !== undefined ||
    pass.resolvedGraphics !== undefined
  )
    return false;
  if (pass.resolvedGpuCopies !== undefined) return pass.resolvedGpuCompute === undefined;
  const work = pass.resolvedGpuCompute;
  return (
    pass.gpuCompute !== undefined &&
    work !== undefined &&
    (work.sampledTargets?.length ?? 0) === 0 &&
    (work.storageTargets?.length ?? 0) === 0
  );
}

class NativeBatchAdmission {
  private readonly names = new Set<string>();
  private readonly buffers = new Map<
    Buffer,
    { readonly size: number; readonly physicalUsage: number }
  >();

  constructor(private readonly caps: RhiCaps) {}

  private buffer(buffer: Buffer, size: number, physicalUsage: number): boolean {
    if (!Number.isSafeInteger(size) || size <= 0) return false;
    const previous = this.buffers.get(buffer);
    if (previous !== undefined)
      return previous.size === size && previous.physicalUsage === physicalUsage;
    this.buffers.set(buffer, { size, physicalUsage });
    return true;
  }

  pass(pass: RenderFeaturePlanExecutionPass): boolean {
    if (!bufferPass(pass) || this.names.has(pass.name)) return false;
    this.names.add(pass.name);
    const accesses = new Map<Buffer, GraphBufferAccess>();
    const accept = (buffer: Buffer, access: GraphBufferAccess): boolean => {
      const prior = accesses.get(buffer);
      if (prior !== undefined && prior !== access) return false;
      accesses.set(buffer, access);
      return true;
    };
    if (pass.resolvedGpuCopies !== undefined) {
      for (const copy of pass.resolvedGpuCopies) {
        for (const resource of [copy.source, copy.destination])
          if (!this.buffer(resource.buffer, resource.size, resource.physicalUsage)) return false;
        if (!accept(copy.source.buffer, 'copy-src') || !accept(copy.destination.buffer, 'copy-dst'))
          return false;
      }
      return true;
    }
    if (!this.caps.compute) return false;
    for (const resource of pass.resolvedGpuCompute?.buffers ?? []) {
      const usage = computeBufferUsage[resource.access];
      if (
        usage === undefined ||
        (resource.physicalUsage & usage) !== usage ||
        (usage === 0x0080 && !this.caps.storageBuffer) ||
        (usage === 0x0100 && !this.caps.indirectDrawing) ||
        !this.buffer(resource.buffer, resource.size, resource.physicalUsage) ||
        !accept(resource.buffer, resource.access)
      )
        return false;
    }
    return true;
  }
}

/** Admit the complete shared batch, never an identity-selected fraction of it. */
export function sharedFrameNativeExecutions(
  result: RenderFeatureFrameResult,
  caps: RhiCaps,
): readonly RenderFeaturePlanExecution[] | undefined {
  if (result.preparationPending === true || result.errors.length !== 0) return undefined;
  const executions: RenderFeaturePlanExecution[] = [];
  const admission = new NativeBatchAdmission(caps);
  for (const planned of result.plans) {
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    if (planned.scope !== 'frame' || execution?.scope !== 'frame') return undefined;
    // Fullscreen registrations have no shared commands, even though their
    // Host-owned empty projection accompanies native simulation every frame.
    // Keep every plan in the receipt without inspecting raw declarations.
    if (
      execution.passes.length !== 0 &&
      (!hasNativeRenderFeatureExecutionSignature(planned) ||
        !planned.plan.resources.every(bufferResource) ||
        !execution.passes.every((pass) => admission.pass(pass)))
    )
      return undefined;
    executions.push(execution);
  }
  return executions;
}

/** The submission owns the current passes and the encoder. No graph or GPU resources
 * belong to this command sequence. Failed batches publish no completed pass names. */
export function encodeSharedFrameCommands<F extends SharedFeatureCommandFrame>(
  frame: F,
  executions: readonly RenderFeaturePlanExecution[],
  instrumentation: RenderGraphPassInstrumentation<F> | undefined,
): void {
  let executionIndex = 0;
  const execute = (pass: RenderGraphNativePass) => {
    encodeNativeRenderPass(frame, pass, executionIndex++, instrumentation);
  };
  for (const execution of executions) {
    issueFeatureComputeCommands(
      execution.passes,
      0,
      execution.passes.length,
      execute,
      frame.reportError,
    );
  }
}
