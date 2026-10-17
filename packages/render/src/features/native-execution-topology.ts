import type {
  PreparedGraphicsResolvedResource,
  PreparedGraphicsResolvedSnapshot,
} from '../prepare/prepared-graphics-resolver';
import { sceneDataTargetOwner } from '../temporal/scene-data';
import type { RenderFeaturePlanExecution, RenderFeaturePlanExecutionPass } from './host';
import type {
  RenderFeatureComputeTarget,
  RenderFeatureGpuComputePassDescriptor,
  RenderFeatureResolvedGpuBuffer,
  RenderFeatureResolvedGpuComputePass,
} from './prepared-gpu-work';
import type {
  RenderFeatureDrawRecord,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedRef,
} from './prepared-graphics';

function sameOrdered<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  same: (left: T, right: T) => boolean,
): boolean {
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  for (let index = 0; index < (left?.length ?? 0); index++)
    if (!same((left as readonly T[])[index] as T, (right as readonly T[])[index] as T))
      return false;
  return true;
}

function sameTarget(left: RenderFeatureComputeTarget, right: RenderFeatureComputeTarget): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'scene-data' && right.kind === 'scene-data') {
    const leftOwner = sceneDataTargetOwner(left);
    const rightOwner = sceneDataTargetOwner(right);
    return (
      leftOwner !== undefined &&
      rightOwner !== undefined &&
      leftOwner.featureIdentity === rightOwner.featureIdentity &&
      leftOwner.planIdentity === rightOwner.planIdentity &&
      leftOwner.generation === rightOwner.generation &&
      left.schema === right.schema &&
      left.access === right.access &&
      left.format === right.format &&
      left.sampleCount === right.sampleCount &&
      left.extent === right.extent
    );
  }
  // Pipeline targets are semantic handles, recreated for each extracted view.
  return (
    left.kind !== 'scene-data' &&
    right.kind !== 'scene-data' &&
    left.name === right.name &&
    left.format === right.format &&
    left.sampleCount === right.sampleCount
  );
}

function sameBuffer(
  left: RenderFeatureResolvedGpuBuffer | undefined,
  right: RenderFeatureResolvedGpuBuffer | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.buffer === right.buffer &&
    left.size === right.size &&
    left.physicalUsage === right.physicalUsage
  );
}

function sameComputeDescriptor(
  left: RenderFeatureGpuComputePassDescriptor,
  right: RenderFeatureGpuComputePassDescriptor,
): boolean {
  return (
    left.program === right.program &&
    left.bindings === right.bindings &&
    sameOrdered(left.dispatches, right.dispatches, (a, b) => {
      if (a.entryPoint !== b.entryPoint || a.bindings !== b.bindings) return false;
      if (a.indirect === undefined || b.indirect === undefined) return a.indirect === b.indirect;
      return a.indirect.buffer === b.indirect.buffer && a.indirect.offset === b.indirect.offset;
    })
  );
}

function sameResolvedCompute(
  left: RenderFeatureResolvedGpuComputePass,
  right: RenderFeatureResolvedGpuComputePass,
): boolean {
  // Zero direct counts remove resolved dispatches. The unfiltered descriptor
  // above supplies dispatch topology; closures and current XYZ counts do not.
  return (
    sameOrdered(
      left.buffers,
      right.buffers,
      (a, b) => a.name === b.name && a.access === b.access && sameBuffer(a, b),
    ) &&
    sameOrdered(left.sampledTargets, right.sampledTargets, sameTarget) &&
    sameOrdered(left.storageTargets, right.storageTargets, sameTarget)
  );
}

function sameDraw(left: RenderFeatureDrawRecord, right: RenderFeatureDrawRecord): boolean {
  if (
    left.kind !== right.kind ||
    left.pipeline !== right.pipeline ||
    left.vertexLayout !== right.vertexLayout ||
    !sameOrdered(left.bindings, right.bindings, (a, b) => a === b) ||
    !sameOrdered(
      left.vertexData,
      right.vertexData,
      (a, b) => a.slot === b.slot && a.resource === b.resource,
    ) ||
    (left.indexData === undefined) !== (right.indexData === undefined) ||
    (left.indexData !== undefined &&
      right.indexData !== undefined &&
      (left.indexData.resource !== right.indexData.resource ||
        left.indexData.format !== right.indexData.format))
  )
    return false;
  if (left.kind === 'draw' && right.kind === 'draw') {
    return (
      left.command.vertexCount === right.command.vertexCount &&
      left.command.instanceCount === right.command.instanceCount &&
      left.command.firstVertex === right.command.firstVertex &&
      left.command.firstInstance === right.command.firstInstance
    );
  }
  if (left.kind === 'draw-indexed' && right.kind === 'draw-indexed') {
    return (
      left.command.indexCount === right.command.indexCount &&
      left.command.instanceCount === right.command.instanceCount &&
      left.command.firstIndex === right.command.firstIndex &&
      left.command.baseVertex === right.command.baseVertex &&
      left.command.firstInstance === right.command.firstInstance
    );
  }
  return (
    (left.kind === 'draw-indirect' || left.kind === 'draw-indexed-indirect') &&
    (right.kind === 'draw-indirect' || right.kind === 'draw-indexed-indirect') &&
    left.command.buffer === right.command.buffer &&
    left.command.offset === right.command.offset
  );
}

function sameGraphics(
  left: RenderFeatureGraphicsPassDescriptor,
  right: RenderFeatureGraphicsPassDescriptor,
): boolean {
  const a = left.attachments.depthStencil;
  const b = right.attachments.depthStencil;
  return (
    left.sceneDepth === right.sceneDepth &&
    sameOrdered(left.sampledTargets, right.sampledTargets, sameTarget) &&
    sameOrdered(
      left.attachments.colors,
      right.attachments.colors,
      (a, b) =>
        sameTarget(a.resource, b.resource) &&
        a.format === b.format &&
        a.loadOp === b.loadOp &&
        a.storeOp === b.storeOp,
    ) &&
    (a === undefined || b === undefined
      ? a === b
      : sameTarget(a.resource, b.resource) &&
        a.format === b.format &&
        a.depthLoadOp === b.depthLoadOp &&
        a.depthStoreOp === b.depthStoreOp) &&
    sameOrdered(left.draws, right.draws, sameDraw)
  );
}

function sameResolvedReference(
  left: PreparedGraphicsResolvedSnapshot,
  right: PreparedGraphicsResolvedSnapshot,
  reference: RenderFeaturePreparedRef,
): boolean {
  const a = left.resolve(reference);
  const b = right.resolve(reference);
  if (
    a === undefined ||
    b === undefined ||
    a.kind !== b.kind ||
    a.reference !== reference ||
    b.reference !== reference
  )
    return false;
  if (a.kind === 'pipeline' && b.kind === 'pipeline') {
    return (
      a.handle === b.handle &&
      a.standardLighting === b.standardLighting &&
      a.writesDepth === b.writesDepth &&
      a.fogComposition === b.fogComposition
    );
  }
  if (a.kind === 'bindings' && b.kind === 'bindings') {
    if (a.fogComposition !== b.fogComposition) return false;
    const buffers = (value: Extract<PreparedGraphicsResolvedResource, { kind: 'bindings' }>) =>
      value.descriptor?.values.storageBuffers;
    const namesA = buffers(a),
      namesB = buffers(b);
    if (namesA === undefined || namesB === undefined) return namesA === namesB;
    if (!Array.isArray(namesA) || !Array.isArray(namesB)) return false;
    return sameOrdered(
      namesA,
      namesB,
      (nameA, nameB) =>
        typeof nameA === 'string' &&
        nameA === nameB &&
        sameBuffer(left.resolveGpuResource?.(nameA), right.resolveGpuResource?.(nameA)),
    );
  }
  return (
    (a.kind === 'vertex-data' || a.kind === 'index-data') &&
    (b.kind === 'vertex-data' || b.kind === 'index-data') &&
    a.handle === b.handle &&
    a.size === b.size &&
    a.physicalUsage === b.physicalUsage &&
    a.byteOffset === b.byteOffset &&
    a.byteLength === b.byteLength
  );
}

function sameResolvedGraphics(
  left: PreparedGraphicsResolvedSnapshot,
  right: PreparedGraphicsResolvedSnapshot,
  descriptor: RenderFeatureGraphicsPassDescriptor,
): boolean {
  if (left.generation !== right.generation) return false;
  for (const draw of descriptor.draws) {
    if (!sameResolvedReference(left, right, draw.pipeline)) return false;
    for (const binding of draw.bindings)
      if (!sameResolvedReference(left, right, binding)) return false;
    for (const vertex of draw.vertexData)
      if (!sameResolvedReference(left, right, vertex.resource)) return false;
    if (
      draw.indexData !== undefined &&
      !sameResolvedReference(left, right, draw.indexData.resource)
    )
      return false;
    if (
      (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect') &&
      !sameBuffer(
        left.resolveGpuBuffer?.(draw.command.buffer),
        right.resolveGpuBuffer?.(draw.command.buffer),
      )
    )
      return false;
  }
  return true;
}

function samePass(
  left: RenderFeaturePlanExecutionPass,
  right: RenderFeaturePlanExecutionPass,
): boolean {
  if (
    left.featureIdentity !== right.featureIdentity ||
    left.order !== right.order ||
    left.name !== right.name ||
    left.shadowCaster !== right.shadowCaster ||
    (left.graphics === undefined) !== (right.graphics === undefined) ||
    (left.graphicsState === undefined) !== (right.graphicsState === undefined) ||
    (left.resolvedGraphics === undefined) !== (right.resolvedGraphics === undefined) ||
    (left.gpuCompute === undefined) !== (right.gpuCompute === undefined) ||
    (left.resolvedGpuCompute === undefined) !== (right.resolvedGpuCompute === undefined) ||
    (left.resolvedGpuCopies === undefined) !== (right.resolvedGpuCopies === undefined)
  )
    return false;
  if (
    left.graphics !== undefined &&
    right.graphics !== undefined &&
    !sameGraphics(left.graphics, right.graphics)
  )
    return false;
  if (
    left.graphicsState !== undefined &&
    right.graphicsState !== undefined &&
    (left.graphicsState.generation !== right.graphicsState.generation ||
      left.graphicsState.capabilityAvailable !== right.graphicsState.capabilityAvailable)
  )
    return false;
  if (
    left.resolvedGraphics !== undefined &&
    right.resolvedGraphics !== undefined &&
    (left.graphics === undefined ||
      !sameResolvedGraphics(left.resolvedGraphics, right.resolvedGraphics, left.graphics))
  )
    return false;
  if (
    left.gpuCompute !== undefined &&
    right.gpuCompute !== undefined &&
    !sameComputeDescriptor(left.gpuCompute, right.gpuCompute)
  )
    return false;
  if (
    left.resolvedGpuCompute !== undefined &&
    right.resolvedGpuCompute !== undefined &&
    (left.gpuCompute === undefined ||
      !sameResolvedCompute(left.resolvedGpuCompute, right.resolvedGpuCompute))
  )
    return false;
  return sameOrdered(
    left.resolvedGpuCopies,
    right.resolvedGpuCopies,
    (a, b) =>
      sameBuffer(a.source, b.source) &&
      sameBuffer(a.destination, b.destination) &&
      a.sourceOffset === b.sourceOffset &&
      a.destinationOffset === b.destinationOffset &&
      a.size === b.size,
  );
}

/** Compare already-admitted private execution, never borrowed public declarations.
 * Native snapshots must resolve captured physical facts without touching a live
 * preparation transaction. Preparation/leases still own unused resources.
 * Frame enablement, direct XYZ counts, snapshot closures and late-bound bind
 * groups are execution data. */
export function sameRenderFeatureNativeExecutionTopology(
  left: RenderFeaturePlanExecution,
  right: RenderFeaturePlanExecution,
): boolean {
  return (
    left.scope === right.scope &&
    left.featureIdentity === right.featureIdentity &&
    left.order === right.order &&
    left.placement === right.placement &&
    sameOrdered(left.passes, right.passes, samePass)
  );
}
