import type {
  BindGroupDescriptor,
  BlasBuildEntry,
  Buffer,
  CommandBuffer,
  PipelineLayout,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RhiBindingResource,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiQueue,
  RhiRenderPipelineOps,
  TlasBuildEntry,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import type { RhiCallEvent, Tape } from '../protocol/types';
import type { RecordedBlasBuild, RecordedTlasBuild } from '../types';
import {
  blob,
  clearBuffer,
  commandEncoderCall,
  endPass,
  eventFailure,
  eventRecord,
  finish,
  missingResource,
  passCall,
  requireResource,
  seedInitialData,
  unsupportedEvent,
} from './execute-support';
import {
  destroyReplayResource,
  type ReplayResource,
  type ReplayResourceValues,
  type ResourceTable,
} from './resources';
import { isDepthTextureFormat } from './texture-format';

export { eventFailure } from './execute-support';

export interface ReplayExecutionContext {
  readonly device: RhiDevice;
  readonly queue: RhiQueue;
  readonly tape: Tape;
  readonly table: ResourceTable;
  readonly createShaderModule: (
    device: RhiDevice,
    desc: { readonly code: string; readonly label?: string | undefined },
  ) => Promise<Result<import('@forgeax/engine-rhi').ShaderModule, RhiError>>;
}

export async function executeEvent(
  context: ReplayExecutionContext,
  event: RhiCallEvent,
  eventIndex: number,
): Promise<Result<void, RhiDebugError>> {
  try {
    switch (event.kind) {
      case 'frameMark':
        return ok(undefined);
      case 'createBuffer':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createBuffer(event.desc),
          'buffer',
        );
      case 'createTexture':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createTexture(replayTextureDescriptor(event.desc) as never),
          'texture',
        );
      case 'createQuerySet':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createQuerySet(event.desc),
          'query-set',
        );
      case 'createBlas':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createBlas(event.desc),
          'blas',
        );
      case 'createTlas':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createTlas(event.desc),
          'tlas',
        );
      case 'destroyBlas':
      case 'destroyTlas':
        return destroyAccelerationStructure(context, event, eventIndex);
      case 'buildAccelerationStructures':
        return buildAccelerationStructures(context, event, eventIndex);
      case 'destroyBuffer':
        return destroyResource(context, eventIndex, event, 'buffer');
      case 'destroyTexture':
        return destroyResource(context, eventIndex, event, 'texture');
      case 'destroyQuerySet':
        return destroyResource(context, eventIndex, event, 'query-set');
      case 'createTextureView':
        return createTextureView(context, event, eventIndex);
      case 'createSampler':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createSampler(event.desc),
          'sampler',
        );
      case 'createBindGroupLayout':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createBindGroupLayout(event.desc as never),
          'bind-group-layout',
        );
      case 'getBindGroupLayout':
        return getBindGroupLayout(context, event, eventIndex);
      case 'createBindGroup':
        return createBindGroup(context, event, eventIndex);
      case 'createPipelineLayout':
        return createPipelineLayout(context, event, eventIndex);
      case 'createRenderPipeline':
        return createRenderPipeline(context, event, eventIndex);
      case 'createComputePipeline':
        return createComputePipeline(context, event, eventIndex);
      case 'createShaderModule':
        return createShaderModule(context, event, eventIndex);
      case 'createCommandEncoder':
        return createResource(
          context,
          eventIndex,
          event,
          context.device.createCommandEncoder(event.desc),
          'command',
          event.cmdHandleId,
        );
      case 'writeBuffer':
        return writeBuffer(context, event, eventIndex);
      case 'writeTexture':
        return writeTexture(context, event, eventIndex);
      case 'copyExternalImageToTexture':
        return unsupportedEvent(eventIndex, event, 'external image sources are not self-contained');
      case 'submit':
        return submit(context, event, eventIndex);
      case 'beginRenderPass':
        return beginRenderPass(context, event, eventIndex);
      case 'beginComputePass':
        return beginComputePass(context, event, eventIndex);
      case 'resolveQuerySet':
        return resolveQuerySet(context, event, eventIndex);
      case 'beginOcclusionQuery':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const result = pass.beginOcclusionQuery(event.queryIndex);
          return result.ok
            ? ok(undefined)
            : eventFailure(eventIndex, event, 'encode', result.error);
        });
      case 'endOcclusionQuery':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const result = pass.endOcclusionQuery();
          return result.ok
            ? ok(undefined)
            : eventFailure(eventIndex, event, 'encode', result.error);
        });
      case 'copyBufferToBuffer':
        return copyBufferToBuffer(context, event, eventIndex);
      case 'copyBufferToTexture':
        return copyBufferToTexture(context, event, eventIndex);
      case 'copyTextureToBuffer':
        return copyTextureToBuffer(context, event, eventIndex);
      case 'copyTextureToTexture':
        return copyTextureToTexture(context, event, eventIndex);
      case 'clearBuffer':
        return clearBuffer(context, event, eventIndex);
      case 'pushDebugGroup':
        return commandEncoderCall(context, event, eventIndex, (encoder) =>
          encoder.pushDebugGroup(event.groupLabel),
        );
      case 'popDebugGroup':
        return commandEncoderCall(context, event, eventIndex, (encoder) => encoder.popDebugGroup());
      case 'insertDebugMarker':
        return commandEncoderCall(context, event, eventIndex, (encoder) =>
          encoder.insertDebugMarker(event.markerLabel),
        );
      case 'finish':
        return finish(context, event, eventIndex);
      case 'setPipeline':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const pipeline = requireResource(
            context,
            event.pipelineHandleId,
            'render-pipeline',
            eventIndex,
            event.kind,
          );
          if (!pipeline.ok) return pipeline;
          pass.setPipeline(pipeline.value);
          return ok(undefined);
        });
      case 'setVertexBuffer':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource(
            context,
            event.bufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.setVertexBuffer(event.slot, buffer.value, event.offset, event.size);
          return ok(undefined);
        });
      case 'setIndexBuffer':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource(
            context,
            event.bufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.setIndexBuffer(buffer.value, event.format, event.offset, event.size);
          return ok(undefined);
        });
      case 'setBindGroup':
        return passCall(context, event, eventIndex, 'pass', (pass) => {
          const bindGroup = requireResource(
            context,
            event.bindGroupHandleId,
            'bind-group',
            eventIndex,
            event.kind,
          );
          if (!bindGroup.ok) return bindGroup;
          pass.setBindGroup(event.index, bindGroup.value, event.dynamicOffsets);
          return ok(undefined);
        });
      case 'draw':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.draw(event.vertexCount, event.instanceCount, event.firstVertex, event.firstInstance);
          return ok(undefined);
        });
      case 'drawIndexed':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.drawIndexed(
            event.indexCount,
            event.instanceCount,
            event.firstIndex,
            event.baseVertex,
            event.firstInstance,
          );
          return ok(undefined);
        });
      case 'setViewport':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setViewport(event.x, event.y, event.w, event.h, event.minDepth, event.maxDepth);
          return ok(undefined);
        });
      case 'setScissorRect':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setScissorRect(event.x, event.y, event.w, event.h);
          return ok(undefined);
        });
      case 'setStencilReference':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setStencilReference(event.reference);
          return ok(undefined);
        });
      case 'resetRenderState':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const result = pass.executeBundles([]);
          return result.ok
            ? ok(undefined)
            : eventFailure(eventIndex, event, 'encode', result.error);
        });
      case 'endRenderPass':
        return endPass(context, event, eventIndex, 'render-pass');
      case 'setBlendConstant':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.setBlendConstant(event.color);
          return ok(undefined);
        });
      case 'drawIndirect':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource(
            context,
            event.indirectBufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.drawIndirect(buffer.value, event.indirectOffset);
          return ok(undefined);
        });
      case 'drawIndexedIndirect':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          const buffer = requireResource(
            context,
            event.indirectBufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.drawIndexedIndirect(buffer.value, event.indirectOffset);
          return ok(undefined);
        });
      case 'passPushDebugGroup':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.pushDebugGroup(event.groupLabel);
          return ok(undefined);
        });
      case 'passPopDebugGroup':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.popDebugGroup();
          return ok(undefined);
        });
      case 'passInsertDebugMarker':
        return passCall(context, event, eventIndex, 'render-pass', (pass) => {
          pass.insertDebugMarker(event.markerLabel);
          return ok(undefined);
        });
      case 'setComputePipeline':
        return passCall(context, event, eventIndex, 'compute-pass', (pass) => {
          const pipeline = requireResource(
            context,
            event.pipelineHandleId,
            'compute-pipeline',
            eventIndex,
            event.kind,
          );
          if (!pipeline.ok) return pipeline;
          pass.setPipeline(pipeline.value);
          return ok(undefined);
        });
      case 'dispatchWorkgroups':
        return passCall(context, event, eventIndex, 'compute-pass', (pass) => {
          pass.dispatchWorkgroups(event.x, event.y, event.z);
          return ok(undefined);
        });
      case 'dispatchWorkgroupsIndirect':
        return passCall(context, event, eventIndex, 'compute-pass', (pass) => {
          const buffer = requireResource(
            context,
            event.indirectBufferHandleId,
            'buffer',
            eventIndex,
            event.kind,
          );
          if (!buffer.ok) return buffer;
          pass.dispatchWorkgroupsIndirect(buffer.value, event.indirectOffset);
          return ok(undefined);
        });
      case 'endComputePass':
        return endPass(context, event, eventIndex, 'compute-pass');
      case 'initialData':
        return seedInitialData(context, event, eventIndex);
      default:
        return unsupportedEvent(eventIndex, event, 'event kind has no replay executor');
    }
  } catch (cause) {
    return eventFailure(eventIndex, event, 'encode', cause);
  }
}

function replayTextureDescriptor(
  descriptor: Extract<RhiCallEvent, { kind: 'createTexture' }>['desc'],
): Extract<RhiCallEvent, { kind: 'createTexture' }>['desc'] {
  if (!isDepthTextureFormat(descriptor.format)) return descriptor;
  return {
    ...descriptor,
    // Depth readback uses a package-owned depth-to-color blit and thus
    // needs the source texture to be bindable on a fresh replay device.
    usage: (descriptor.usage ?? 0) | 0x04,
  };
}

function createResource<K extends ReplayResource['kind']>(
  context: ReplayExecutionContext,
  eventIndex: number,
  event: RhiCallEvent,
  result: Result<NoInfer<ReplayResourceValues[K]>, RhiError>,
  kind: K,
  resourceId?: string,
): Result<void, RhiDebugError> {
  if (!result.ok) return eventFailure(eventIndex, event, 'create', result.error);
  const id = resourceId ?? ('handleId' in event ? event.handleId : undefined);
  if (id === undefined)
    return eventFailure(eventIndex, event, 'lookup', 'created resource has no handle id');
  const stored = context.table.set(
    id,
    { kind, value: result.value } as ReplayResource,
    eventRecord(event),
  );
  return stored.ok ? ok(undefined) : stored;
}

function destroyResource(
  context: ReplayExecutionContext,
  eventIndex: number,
  event: Extract<RhiCallEvent, { kind: 'destroyBuffer' | 'destroyTexture' | 'destroyQuerySet' }>,
  kind: 'buffer' | 'texture' | 'query-set',
): Result<void, RhiDebugError> {
  const entry = context.table.get(event.handleId);
  if (entry === undefined || entry.resource.kind !== kind)
    return missingResource(eventIndex, event, event.handleId, kind);
  const result = destroyReplayResource(context.device, entry.resource);
  if (result !== undefined && !result.ok)
    return eventFailure(eventIndex, event, 'create', result.error);
  context.table.delete(event.handleId);
  return ok(undefined);
}

function resolveQuerySet(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'resolveQuerySet' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  const querySet = requireResource(
    context,
    event.querySetHandleId,
    'query-set',
    eventIndex,
    event.kind,
  );
  const destination = requireResource(
    context,
    event.destinationHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!querySet.ok) return querySet;
  if (!destination.ok) return destination;
  const result = encoder.value.resolveQuerySet(
    querySet.value,
    event.firstQuery,
    event.queryCount,
    destination.value,
    event.destinationOffset,
  );
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'encode', result.error);
}

function destroyAccelerationStructure(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'destroyBlas' | 'destroyTlas' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const kind = event.kind === 'destroyBlas' ? 'blas' : 'tlas';
  const resource = context.table.get(event.handleId)?.resource;
  if (resource === undefined || resource.kind !== kind)
    return missingResource(eventIndex, event, event.handleId, kind);
  const result =
    resource.kind === 'blas'
      ? context.device.destroyBlas(resource.value)
      : context.device.destroyTlas(resource.value);
  if (!result.ok) return eventFailure(eventIndex, event, 'create', result.error);
  context.table.delete(event.handleId);
  return ok(undefined);
}

function buildAccelerationStructures(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'buildAccelerationStructures' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  return encodeAccelerationStructureBuild(
    context,
    encoder.value,
    event.blas,
    event.tlas,
    event,
    eventIndex,
  );
}

/**
 * Encode recorded BLAS/TLAS builds with replay-device objects. Bootstrap
 * acceleration structures reuse it to rebuild their capture-start state.
 */
export function encodeAccelerationStructureBuild(
  context: ReplayExecutionContext,
  encoder: RhiCommandEncoder,
  blasBuilds: readonly RecordedBlasBuild[],
  tlasBuilds: readonly RecordedTlasBuild[],
  event: RhiCallEvent,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const lookup = <K extends ReplayResource['kind']>(id: string, kind: K) =>
    requireResource(context, id, kind, eventIndex, event.kind);
  const blas: BlasBuildEntry[] = [];
  for (const build of blasBuilds) {
    const target = lookup(build.blasHandleId, 'blas');
    if (!target.ok) return target;
    const geometries: BlasBuildEntry['geometries'][number][] = [];
    for (const geometry of build.geometries) {
      const vertexBuffer = lookup(geometry.vertexBufferHandleId, 'buffer');
      if (!vertexBuffer.ok) return vertexBuffer;
      let index: { buffer: Buffer; firstIndex?: number } | undefined;
      if (geometry.index !== undefined && geometry.index !== null) {
        const indexBuffer = lookup(geometry.index.bufferHandleId, 'buffer');
        if (!indexBuffer.ok) return indexBuffer;
        index = {
          buffer: indexBuffer.value,
          ...(geometry.index.firstIndex === undefined || geometry.index.firstIndex === null
            ? {}
            : { firstIndex: geometry.index.firstIndex }),
        };
      }
      geometries.push({
        vertexBuffer: vertexBuffer.value,
        vertexStride: geometry.vertexStride,
        ...(geometry.firstVertex === undefined || geometry.firstVertex === null
          ? {}
          : { firstVertex: geometry.firstVertex }),
        ...(index === undefined ? {} : { index }),
      });
    }
    blas.push({ blas: target.value, geometries });
  }
  const tlas: TlasBuildEntry[] = [];
  for (const build of tlasBuilds) {
    const target = lookup(build.tlasHandleId, 'tlas');
    if (!target.ok) return target;
    const instances: TlasBuildEntry['instances'][number][] = [];
    for (const instance of build.instances) {
      const instanceBlas = lookup(instance.blasHandleId, 'blas');
      if (!instanceBlas.ok) return instanceBlas;
      instances.push({
        blas: instanceBlas.value,
        transform: instance.transform,
        customIndex: instance.customIndex,
        mask: instance.mask,
      });
    }
    tlas.push({ tlas: target.value, instances });
  }
  const result = encoder.buildAccelerationStructures(blas, tlas);
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'encode', result.error);
}

async function createShaderModule(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createShaderModule' }>,
  eventIndex: number,
): Promise<Result<void, RhiDebugError>> {
  const result = await context.createShaderModule(context.device, { code: event.wgslCode });
  return createResource(context, eventIndex, event, result, 'shader-module');
}

function createTextureView(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createTextureView' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const texture = requireResource(context, event.sourceHandleId, 'texture', eventIndex, event.kind);
  if (!texture.ok) return texture;
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createTextureView(texture.value, event.desc),
    'texture-view',
    event.resultHandleId,
  );
}

function getBindGroupLayout(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'getBindGroupLayout' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const pipeline = context.table.get(event.pipelineHandleId)?.resource;
  if (pipeline?.kind !== 'render-pipeline' && pipeline?.kind !== 'compute-pipeline')
    return missingResource(eventIndex, event, event.pipelineHandleId, 'pipeline');
  return createResource(
    context,
    eventIndex,
    event,
    ok(
      (pipeline.value as typeof pipeline.value & RhiRenderPipelineOps).getBindGroupLayout(
        event.index,
      ),
    ),
    'bind-group-layout',
  );
}

function createBindGroup(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createBindGroup' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layout = requireResource(
    context,
    event.layoutHandleId,
    'bind-group-layout',
    eventIndex,
    event.kind,
  );
  if (!layout.ok) return layout;
  const resources: RhiBindingResource[] = [];
  for (const [index, entry] of event.entries.entries()) {
    const resourceId = event.resourceHandleIds[index];
    if (resourceId === undefined)
      return eventFailure(eventIndex, event, 'lookup', 'bind group resource handle is missing');
    const resolved = context.table.get(resourceId);
    if (resolved === undefined)
      return missingResource(eventIndex, event, resourceId, entry.resourceKind);
    if (entry.resourceKind === 'buffer' && resolved.resource.kind === 'buffer') {
      resources.push({
        kind: 'buffer',
        value: {
          buffer: resolved.resource.value,
          ...(entry.bufferOffset === undefined ? {} : { offset: entry.bufferOffset }),
          ...(entry.bufferSize === undefined ? {} : { size: entry.bufferSize }),
        },
      });
    } else if (entry.resourceKind === 'sampler' && resolved.resource.kind === 'sampler') {
      resources.push({ kind: 'sampler', value: resolved.resource.value });
    } else if (entry.resourceKind === 'textureView' && resolved.resource.kind === 'texture-view') {
      resources.push({ kind: 'textureView', value: resolved.resource.value });
    } else if (
      entry.resourceKind === 'accelerationStructure' &&
      resolved.resource.kind === 'tlas'
    ) {
      resources.push({ kind: 'accelerationStructure', value: resolved.resource.value });
    } else {
      return missingResource(eventIndex, event, resourceId, entry.resourceKind);
    }
  }
  const descriptor: BindGroupDescriptor = {
    layout: layout.value,
    entries: event.entries.map((entry, index) => ({
      binding: entry.binding,
      resource: resources[index] as RhiBindingResource,
    })),
  };
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createBindGroup(descriptor),
    'bind-group',
  );
}

function createPipelineLayout(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createPipelineLayout' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layouts: import('@forgeax/engine-rhi').BindGroupLayout[] = [];
  for (const id of event.bglHandleIds) {
    const layout = requireResource(context, id, 'bind-group-layout', eventIndex, event.kind);
    if (!layout.ok) return layout;
    layouts.push(layout.value);
  }
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createPipelineLayout({ bindGroupLayouts: layouts }),
    'pipeline-layout',
  );
}

function createRenderPipeline(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createRenderPipeline' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layout = replayPipelineLayout(context, event, eventIndex);
  if (!layout.ok) return layout;
  const vertex = event.desc.vertex;
  const fragment = event.desc.fragment;
  const vertexShader =
    vertex === undefined ? undefined : shaderValue(context, event.vertexShaderModuleHandleId);
  const fragmentShader =
    fragment === undefined ? undefined : shaderValue(context, event.fragmentShaderModuleHandleId);
  const descriptor = {
    ...event.desc,
    layout: layout.value,
    ...(vertex === undefined ? {} : { vertex: { ...vertex, module: vertexShader } }),
    ...(fragment === undefined
      ? {}
      : {
          fragment: {
            ...fragment,
            module: fragmentShader,
          },
        }),
  };
  if (
    (vertex !== undefined && vertexShader === undefined) ||
    (fragment !== undefined && fragmentShader === undefined)
  ) {
    return eventFailure(
      eventIndex,
      event,
      'lookup',
      'render pipeline shader module handle is missing',
    );
  }
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createRenderPipeline(descriptor as never),
    'render-pipeline',
  );
}

function createComputePipeline(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createComputePipeline' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const layout = replayPipelineLayout(context, event, eventIndex);
  if (!layout.ok) return layout;
  const shader = shaderValue(context, event.computeShaderModuleHandleId);
  if (shader === undefined)
    return eventFailure(
      eventIndex,
      event,
      'lookup',
      'compute pipeline shader module handle is missing',
    );
  return createResource(
    context,
    eventIndex,
    event,
    context.device.createComputePipeline({
      ...event.desc,
      layout: layout.value,
      compute: { ...event.desc.compute, module: shader },
    } as never),
    'compute-pipeline',
  );
}

function replayPipelineLayout(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'createRenderPipeline' | 'createComputePipeline' }>,
  eventIndex: number,
): Result<PipelineLayout | 'auto', RhiDebugError> {
  if (event.layoutHandleId === 'layout:auto') return ok('auto');
  const layout = requireResource(
    context,
    event.layoutHandleId,
    'pipeline-layout',
    eventIndex,
    event.kind,
  );
  if (!layout.ok) return layout;
  return ok(layout.value);
}

function shaderValue(
  context: ReplayExecutionContext,
  id: string | undefined,
): import('@forgeax/engine-rhi').ShaderModule | undefined {
  if (id === undefined) return undefined;
  const entry = context.table.get(id);
  if (entry?.resource.kind !== 'shader-module') return undefined;
  return entry.resource.value;
}

function writeBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'writeBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const buffer = requireResource(context, event.handleId, 'buffer', eventIndex, event.kind);
  if (!buffer.ok) return buffer;
  const bytes = blob(context.tape, event.dataHash, event, eventIndex);
  if (!bytes.ok) return bytes;
  const result = context.queue.writeBuffer(
    buffer.value,
    event.bufferOffset,
    bytes.value,
    0,
    event.size,
  );
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'write', result.error);
}

function writeTexture(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'writeTexture' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const texture = requireResource(
    context,
    event.destination.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  if (!texture.ok) return texture;
  const bytes = blob(context.tape, event.dataHash, event, eventIndex);
  if (!bytes.ok) return bytes;
  const result = context.queue.writeTexture(
    {
      texture: texture.value,
      mipLevel: event.destination.mipLevel ?? 0,
      origin: event.destination.origin,
      aspect: event.destination.aspect,
    } as never,
    bytes.value,
    {
      offset: event.dataLayout.offset ?? 0,
      ...(event.dataLayout.bytesPerRow === undefined
        ? {}
        : { bytesPerRow: event.dataLayout.bytesPerRow }),
      ...(event.dataLayout.rowsPerImage === undefined
        ? {}
        : { rowsPerImage: event.dataLayout.rowsPerImage }),
    },
    event.size,
  );
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'write', result.error);
}

function submit(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'submit' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const commandBuffers: CommandBuffer[] = [];
  for (const id of event.cmdHandleIds) {
    const commandBuffer = requireResource(context, id, 'command-buffer', eventIndex, event.kind);
    if (!commandBuffer.ok) return commandBuffer;
    commandBuffers.push(commandBuffer.value);
  }
  const result = context.queue.submit(commandBuffers);
  return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'submit', result.error);
}

function beginRenderPass(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'beginRenderPass' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  const colors = Array.from(event.desc.colorAttachments).map((attachment, index) => {
    if (attachment === null || attachment === undefined) return attachment;
    const viewId = event.colorAttachmentViewHandleIds[index];
    const view = viewId === undefined ? undefined : context.table.get(viewId)?.resource;
    if (view?.kind !== 'texture-view') throw new Error(`missing color attachment view ${viewId}`);
    const resolveId = event.colorAttachmentResolveTargetHandleIds?.[index];
    const resolve = resolveId === undefined ? undefined : context.table.get(resolveId)?.resource;
    return {
      ...attachment,
      view: view.value,
      ...(resolve?.kind === 'texture-view' ? { resolveTarget: resolve.value } : {}),
    } as RenderPassColorAttachment;
  });
  const depth =
    event.depthStencilViewHandleId === undefined
      ? undefined
      : context.table.get(event.depthStencilViewHandleId)?.resource;
  const querySet =
    event.occlusionQuerySetHandleId === undefined
      ? undefined
      : context.table.get(event.occlusionQuerySetHandleId)?.resource;
  if (event.occlusionQuerySetHandleId !== undefined && querySet?.kind !== 'query-set') {
    return missingResource(eventIndex, event, event.occlusionQuerySetHandleId, 'query-set');
  }
  const timestamp = replayTimestampWrites(context, event, eventIndex);
  if (!timestamp.ok) return timestamp;
  const descriptor = {
    ...event.desc,
    ...(timestamp.value === undefined ? {} : { timestampWrites: timestamp.value }),
    colorAttachments: colors,
    ...(depth?.kind === 'texture-view'
      ? {
          depthStencilAttachment: {
            ...event.desc.depthStencilAttachment,
            view: depth.value,
          } as RenderPassDepthStencilAttachment,
        }
      : {}),
    ...(querySet?.kind === 'query-set' ? { occlusionQuerySet: querySet.value } : {}),
  };
  const pass = encoder.value.beginRenderPass(descriptor as never);
  return context.table.set(
    event.passHandleId,
    { kind: 'render-pass', value: pass },
    eventRecord(event),
  );
}

function replayTimestampWrites(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>,
  eventIndex: number,
): Result<import('@forgeax/engine-rhi').RenderPassTimestampWrites | undefined, RhiDebugError> {
  if (event.desc?.timestampWrites === undefined) return ok(undefined);
  const handle = event.timestampQuerySetHandleId;
  if (handle === undefined)
    return missingResource(eventIndex, event, 'timestamp-query-set', 'query-set');
  const query = requireResource(context, handle, 'query-set', eventIndex, event.kind);
  if (!query.ok) return query;
  return ok({
    ...event.desc.timestampWrites,
    querySet: query.value,
  });
}

function beginComputePass(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'beginComputePass' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  const timestamp = replayTimestampWrites(context, event, eventIndex);
  if (!timestamp.ok) return timestamp;
  const pass = encoder.value.beginComputePass({
    ...(event.desc?.label === undefined ? {} : { label: event.desc.label }),
    ...(timestamp.value === undefined ? {} : { timestampWrites: timestamp.value }),
  });
  return context.table.set(
    event.passHandleId,
    { kind: 'compute-pass', value: pass },
    eventRecord(event),
  );
}

function copyBufferToBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyBufferToBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  const source = requireResource(context, event.sourceHandleId, 'buffer', eventIndex, event.kind);
  const destination = requireResource(
    context,
    event.destinationHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!source.ok) return source;
  if (!destination.ok) return destination;
  encoder.value.copyBufferToBuffer(
    source.value,
    event.sourceOffset,
    destination.value,
    event.destinationOffset,
    event.size,
  );
  return ok(undefined);
}

function copyBufferToTexture(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyBufferToTexture' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  const buffer = requireResource(
    context,
    event.source.bufferHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  const texture = requireResource(
    context,
    event.destination.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!buffer.ok) return buffer;
  if (!texture.ok) return texture;
  encoder.value.copyBufferToTexture(
    { ...event.source, buffer: buffer.value },
    { ...event.destination, texture: texture.value },
    event.copySize,
  );
  return ok(undefined);
}

function copyTextureToBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyTextureToBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  const texture = requireResource(
    context,
    event.source.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  const buffer = requireResource(
    context,
    event.destination.bufferHandleId,
    'buffer',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!texture.ok) return texture;
  if (!buffer.ok) return buffer;
  encoder.value.copyTextureToBuffer(
    { ...event.source, texture: texture.value },
    { ...event.destination, buffer: buffer.value },
    event.copySize,
  );
  return ok(undefined);
}

function copyTextureToTexture(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'copyTextureToTexture' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  const source = requireResource(
    context,
    event.source.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  const destination = requireResource(
    context,
    event.destination.textureHandleId,
    'texture',
    eventIndex,
    event.kind,
  );
  if (!encoder.ok) return encoder;
  if (!source.ok) return source;
  if (!destination.ok) return destination;
  encoder.value.copyTextureToTexture(
    { ...event.source, texture: source.value },
    { ...event.destination, texture: destination.value },
    event.copySize,
  );
  return ok(undefined);
}
