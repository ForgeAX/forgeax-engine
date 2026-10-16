import type { RecordedBlasBuild } from '../types';
import type { EventKind, ResourceKind, RhiCallEvent } from './types';

export type EventCategory = 'resource' | 'pass' | 'state' | 'work' | 'copy' | 'submit' | 'marker';

export interface EventSemantics {
  readonly category: EventCategory;
  /** Handles the event declares, including transient encoder and pass handles. */
  readonly created: (event: RhiCallEvent) => readonly string[];
  readonly read: (event: RhiCallEvent) => readonly string[];
  readonly written: (event: RhiCallEvent) => readonly string[];
  /** Handles the event retires, including pass handles closed by end*Pass. */
  readonly destroyed: (event: RhiCallEvent) => readonly string[];
}

export const eventKinds = [
  'frameMark',
  'createBuffer',
  'createTexture',
  'createQuerySet',
  'destroyBuffer',
  'destroyTexture',
  'destroyQuerySet',
  'createBlas',
  'createTlas',
  'destroyBlas',
  'destroyTlas',
  'createTextureView',
  'createSampler',
  'createBindGroupLayout',
  'getBindGroupLayout',
  'createBindGroup',
  'createPipelineLayout',
  'createRenderPipeline',
  'createComputePipeline',
  'createShaderModule',
  'createCommandEncoder',
  'writeBuffer',
  'writeTexture',
  'copyExternalImageToTexture',
  'submit',
  'beginRenderPass',
  'beginOcclusionQuery',
  'endOcclusionQuery',
  'beginComputePass',
  'copyBufferToBuffer',
  'copyBufferToTexture',
  'copyTextureToBuffer',
  'copyTextureToTexture',
  'clearBuffer',
  'resolveQuerySet',
  'buildAccelerationStructures',
  'pushDebugGroup',
  'popDebugGroup',
  'insertDebugMarker',
  'finish',
  'setPipeline',
  'setVertexBuffer',
  'setIndexBuffer',
  'setBindGroup',
  'draw',
  'drawIndexed',
  'setViewport',
  'setScissorRect',
  'setStencilReference',
  'endRenderPass',
  'resetRenderState',
  'setBlendConstant',
  'drawIndirect',
  'drawIndexedIndirect',
  'passPushDebugGroup',
  'passPopDebugGroup',
  'passInsertDebugMarker',
  'setComputePipeline',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
  'endComputePass',
  'initialData',
] as const satisfies readonly EventKind[];

export const workEventKinds = [
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
] as const satisfies readonly EventKind[];

export function isWorkEvent(kind: EventKind): boolean {
  return (workEventKinds as readonly string[]).includes(kind);
}

export const EVENT_SEMANTICS: Readonly<Record<EventKind, EventSemantics>> = Object.fromEntries(
  eventKinds.map((kind) => [kind, semanticsFor(kind)]),
) as Record<EventKind, EventSemantics>;

export function resourceKindForEvent(kind: EventKind): ResourceKind | undefined {
  switch (kind) {
    case 'createBuffer':
      return 'buffer';
    case 'createTexture':
      return 'texture';
    case 'createQuerySet':
      return 'query-set';
    case 'createBlas':
    case 'createTlas':
      return 'acceleration-structure';
    case 'createTextureView':
      return 'texture-view';
    case 'createSampler':
      return 'sampler';
    case 'createShaderModule':
      return 'shader-module';
    case 'createRenderPipeline':
    case 'createComputePipeline':
      return 'pipeline';
    case 'createBindGroup':
    case 'createBindGroupLayout':
    case 'getBindGroupLayout':
    case 'createPipelineLayout':
      return 'binding';
    case 'createCommandEncoder':
      return 'encoder';
    default:
      return undefined;
  }
}

function semanticsFor(kind: EventKind): EventSemantics {
  const category = categoryFor(kind);
  return {
    category,
    created: (event) => createdHandles(event),
    read: (event) => handleAccess(event).read,
    written: (event) => handleAccess(event).written,
    destroyed: (event) => retiredHandles(event),
  };
}

function categoryFor(kind: EventKind): EventCategory {
  if (isWorkEvent(kind)) return 'work';
  if (
    kind.startsWith('create') ||
    kind.startsWith('destroy') ||
    kind === 'initialData' ||
    kind === 'getBindGroupLayout'
  )
    return 'resource';
  if (kind.includes('Pass')) return 'pass';
  if (
    kind.startsWith('copy') ||
    kind === 'clearBuffer' ||
    kind.startsWith('write') ||
    kind === 'buildAccelerationStructures'
  )
    return 'copy';
  if (kind === 'submit' || kind === 'finish') return 'submit';
  if (kind.includes('Debug')) return 'marker';
  return 'state';
}

function createdHandles(event: RhiCallEvent): readonly string[] {
  if (event.kind === 'createTextureView') return [event.resultHandleId];
  if (event.kind === 'createCommandEncoder') return [event.cmdHandleId];
  if (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass')
    return [event.passHandleId];
  if (resourceKindForEvent(event.kind) !== undefined) return stringField(event, 'handleId');
  return [];
}

function retiredHandles(event: RhiCallEvent): readonly string[] {
  if (
    event.kind === 'destroyBuffer' ||
    event.kind === 'destroyTexture' ||
    event.kind === 'destroyQuerySet' ||
    event.kind === 'destroyBlas' ||
    event.kind === 'destroyTlas'
  )
    return [event.handleId];
  if (event.kind === 'endRenderPass' || event.kind === 'endComputePass')
    return [event.passHandleId];
  return [];
}

interface HandleAccess {
  readonly read: readonly string[];
  readonly written: readonly string[];
}

const NO_ACCESS: HandleAccess = { read: [], written: [] };

// Decoded tapes carry JSON: an absent attachment slot arrives as null, not undefined.
function reads(...ids: readonly unknown[]): HandleAccess {
  return { read: ids.filter((id): id is string => typeof id === 'string'), written: [] };
}

function writes(written: string, ...others: readonly unknown[]): HandleAccess {
  return { read: [...reads(...others).read, written], written: [written] };
}

function pipelineLayout(layoutHandleId: string): string | undefined {
  return layoutHandleId === 'layout:auto' ? undefined : layoutHandleId;
}

/**
 * Handles an event names, which must therefore be declared before it (`read`),
 * and the subset whose contents it changes (`written`). One table feeds tape
 * validation, the recorder's bootstrap closure and FrameModel consumers.
 */
function handleAccess(event: RhiCallEvent): HandleAccess {
  switch (event.kind) {
    case 'frameMark':
    case 'createBuffer':
    case 'createTexture':
    case 'createQuerySet':
    case 'createSampler':
    case 'createBindGroupLayout':
    case 'createShaderModule':
    case 'createCommandEncoder':
      return NO_ACCESS;
    case 'destroyBuffer':
    case 'destroyTexture':
    case 'destroyQuerySet':
    case 'destroyBlas':
    case 'destroyTlas':
      return reads(event.handleId);
    case 'createBlas':
      return reads(...(event.build === undefined ? [] : blasBuildInputs(event.build)));
    case 'createTlas':
      return reads(...(event.build?.instances.map((instance) => instance.blasHandleId) ?? []));
    case 'buildAccelerationStructures': {
      const written = [
        ...event.blas.map((entry) => entry.blasHandleId),
        ...event.tlas.map((entry) => entry.tlasHandleId),
      ];
      return {
        read: [
          event.cmdHandleId,
          ...event.blas.flatMap(blasBuildInputs),
          ...event.tlas.flatMap((entry) =>
            entry.instances.map((instance) => instance.blasHandleId),
          ),
          ...written,
        ],
        written,
      };
    }
    case 'createTextureView':
      return reads(event.sourceHandleId);
    case 'getBindGroupLayout':
      return reads(event.pipelineHandleId);
    case 'createBindGroup':
      return reads(event.layoutHandleId, ...event.resourceHandleIds);
    case 'createPipelineLayout':
      return reads(...event.bglHandleIds);
    case 'createRenderPipeline':
      return reads(
        pipelineLayout(event.layoutHandleId),
        event.vertexShaderModuleHandleId,
        event.fragmentShaderModuleHandleId,
      );
    case 'createComputePipeline':
      return reads(pipelineLayout(event.layoutHandleId), event.computeShaderModuleHandleId);
    case 'writeBuffer':
    case 'clearBuffer':
    case 'initialData':
      return writes(event.handleId);
    case 'writeTexture':
    case 'copyExternalImageToTexture':
      return writes(event.destination.textureHandleId);
    case 'copyBufferToBuffer':
      return writes(event.destinationHandleId, event.sourceHandleId);
    case 'copyBufferToTexture':
      return writes(event.destination.textureHandleId, event.source.bufferHandleId);
    case 'copyTextureToBuffer':
      return writes(event.destination.bufferHandleId, event.source.textureHandleId);
    case 'copyTextureToTexture':
      return writes(event.destination.textureHandleId, event.source.textureHandleId);
    case 'resolveQuerySet':
      return writes(event.destinationHandleId, event.cmdHandleId, event.querySetHandleId);
    case 'submit':
      return reads(...event.cmdHandleIds);
    case 'beginRenderPass':
      return reads(
        event.cmdHandleId,
        ...event.colorAttachmentViewHandleIds,
        ...(event.colorAttachmentResolveTargetHandleIds ?? []),
        event.depthStencilViewHandleId,
        event.occlusionQuerySetHandleId,
        event.timestampQuerySetHandleId,
      );
    case 'beginComputePass':
      return reads(event.cmdHandleId, event.timestampQuerySetHandleId);
    case 'pushDebugGroup':
    case 'popDebugGroup':
    case 'insertDebugMarker':
    case 'finish':
      return reads(event.cmdHandleId);
    case 'setPipeline':
    case 'setComputePipeline':
      return reads(event.passHandleId, event.pipelineHandleId);
    case 'setVertexBuffer':
    case 'setIndexBuffer':
      return reads(event.passHandleId, event.bufferHandleId);
    case 'setBindGroup':
      return reads(event.passHandleId, event.bindGroupHandleId);
    case 'drawIndirect':
    case 'drawIndexedIndirect':
    case 'dispatchWorkgroupsIndirect':
      return reads(event.passHandleId, event.indirectBufferHandleId);
    case 'draw':
    case 'drawIndexed':
    case 'dispatchWorkgroups':
    case 'setViewport':
    case 'setScissorRect':
    case 'setStencilReference':
    case 'setBlendConstant':
    case 'resetRenderState':
    case 'beginOcclusionQuery':
    case 'endOcclusionQuery':
    case 'passPushDebugGroup':
    case 'passPopDebugGroup':
    case 'passInsertDebugMarker':
    case 'endRenderPass':
    case 'endComputePass':
      return reads(event.passHandleId);
  }
}

function blasBuildInputs(build: Pick<RecordedBlasBuild, 'geometries'>): readonly string[] {
  return build.geometries.flatMap((geometry) =>
    geometry.index === undefined || geometry.index === null
      ? [geometry.vertexBufferHandleId]
      : [geometry.vertexBufferHandleId, geometry.index.bufferHandleId],
  );
}

function stringField(event: object, key: string): readonly string[] {
  const value = (event as Record<string, unknown>)[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}
