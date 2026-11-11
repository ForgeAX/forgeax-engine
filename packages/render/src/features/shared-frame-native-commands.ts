import {
  type CompiledRenderGraph,
  type GraphBufferAccess,
  RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import type { Buffer, RhiCaps, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import type { RenderError } from '../errors/render';
import {
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
  type RenderFeatureFrameResult,
  type RenderFeaturePlanExecution,
  type RenderFeaturePlanExecutionPass,
} from './host';
import type { RenderFeatureResourceDeclaration } from './plan';
import { encodeRenderFeatureGpuComputePass } from './prepared-gpu-work';
import { throwFeatureRecordingFailure } from './recording-failure';
import { visitRenderFeatureComputeSequence } from './render-graph-compute';

// This is a conservative admission subset, not a replacement graph validator.
// Anything outside it retains the original compile-time error authority.
const computeBufferUsage: Partial<Record<GraphBufferAccess, number>> = {
  'uniform-read': 0x0040,
  'storage-read': 0x0080,
  'storage-write': 0x0080,
  'storage-read-write': 0x0080,
  'indirect-read': 0x0100,
};

export interface SharedFeatureCommandFrame {
  readonly encoder: RhiCommandEncoder;
  readonly featureExecutions?: readonly RenderFeaturePlanExecution[] | undefined;
  readonly nativePassNames?: string[] | undefined;
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

function copyPass(pass: RenderFeaturePlanExecutionPass): RenderGraphNativePass {
  return {
    kind: 'copy',
    name: pass.name,
    encode: (encoder) => {
      for (const copy of pass.resolvedGpuCopies ?? []) {
        if (copy.enabled === false) continue;
        encoder.copyBufferToBuffer(
          copy.source.buffer,
          copy.sourceOffset,
          copy.destination.buffer,
          copy.destinationOffset,
          copy.size,
        );
      }
    },
  };
}

function computePass(
  passes: readonly RenderFeaturePlanExecutionPass[],
  reportError: SharedFeatureCommandFrame['reportError'],
): RenderGraphNativePass {
  return {
    kind: 'compute',
    name: passes[0]?.name ?? 'shared-feature-compute',
    encode: (encoder) => {
      for (const pass of passes) {
        if (pass.enabled === false) continue;
        try {
          // Admission checked this exact current frame's complete pass list.
          if (pass.resolvedGpuCompute === undefined)
            throw new Error('Missing admitted compute work');
          encodeRenderFeatureGpuComputePass(encoder, pass.resolvedGpuCompute);
        } catch (cause) {
          throwFeatureRecordingFailure(
            cause,
            pass.featureIdentity,
            pass.order,
            pass.name,
            'bindings',
            reportError,
          );
        }
      }
    },
  };
}

class NativeCommandFailure extends Error {
  constructor(readonly error: RenderGraphError) {
    super('Shared Feature native command failed');
  }
}

/** The shell is not the failing logical pass; retain the original graph error shape. */
export function sharedFrameNativeFailure(error: RenderGraphError): RenderGraphError {
  const detail = error.detail;
  return error.code === 'pass-encode-failed' &&
    detail !== undefined &&
    'cause' in detail &&
    detail.cause instanceof NativeCommandFailure
    ? detail.cause.error
    : error;
}

/** Re-evaluate physical alias and usage grouping for every current submission. */
function encodeFrame(frame: SharedFeatureCommandFrame, run: (pass: RenderGraphNativePass) => void) {
  if (frame.featureExecutions === undefined) throw new Error('Missing current shared Feature work');
  const execute = (pass: RenderGraphNativePass) => {
    try {
      run(pass);
    } catch (cause) {
      throw new NativeCommandFailure(
        new RenderGraphError({
          code: 'pass-encode-failed',
          expected: `pass '${pass.name}' encodes without throwing`,
          hint: 'inspect detail.cause and repair the pass-owned RHI command',
          detail: { passName: pass.name, passKind: pass.kind, cause },
        }),
      );
    }
    frame.nativePassNames?.push(pass.name);
  };
  for (const execution of frame.featureExecutions) {
    const visited = visitRenderFeatureComputeSequence(execution.passes, {
      copy: (pass) => {
        if (pass.enabled !== false) execute(copyPass(pass));
        return ok(undefined);
      },
      compute: (passes) => {
        if (passes.some((pass) => pass.enabled !== false))
          execute(computePass(passes, frame.reportError));
        return ok(undefined);
      },
    });
    if (!visited.ok) throw visited.error;
  }
}

/** Own only a zero-resource shell; no frame, plan, binding, or Buffer is retained. */
export class SharedFrameNativeCommands {
  private graph: CompiledRenderGraph<SharedFeatureCommandFrame> | undefined;
  private closed = false;

  constructor(
    readonly scope: DeviceScope,
    readonly device: RhiDevice,
  ) {
    scope._adopt('feature', this, (owner) => owner.dispose());
  }

  current(scope: DeviceScope, device: RhiDevice): boolean {
    return !this.closed && this.scope === scope && this.device === device && scope.isAlive();
  }

  prepare(): {
    readonly graph: CompiledRenderGraph<SharedFeatureCommandFrame>;
    readonly built: boolean;
  } {
    if (this.closed || !this.scope.isAlive())
      throw new Error('Shared Feature device scope retired');
    if (this.graph !== undefined) return { graph: this.graph, built: false };
    const builder = new RenderGraphBuilder<SharedFeatureCommandFrame>();
    const added = builder.addSubgraphPass('shared-feature-native-commands', {
      accesses: [],
      commands: ({ frame, execute }) => encodeFrame(frame, execute),
    });
    if (!added.ok) throw added.error;
    const compiled = builder.compile({ device: this.device, surfaceSize: { width: 1, height: 1 } });
    if (!compiled.ok) throw compiled.error;
    this.graph = compiled.value;
    return { graph: compiled.value, built: true };
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const graph = this.graph;
    this.graph = undefined;
    if (graph !== undefined) await graph.retire();
  }
}
