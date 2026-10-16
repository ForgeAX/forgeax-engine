// @forgeax/engine-rhi-debug/src/frame-model -- v7 structural tape projection.

/// <reference types="@webgpu/types" />

import { type BindingAccess, layoutEntryAccess, wgslBindingAccess } from './binding-access';
import { type UnseededResource, unseededResources } from './initial-contents';
import {
  EVENT_SEMANTICS,
  type EventCategory,
  isWorkEvent,
  resourceKindForEvent,
} from './protocol/event-semantics';
import type { TapeWorkEntry } from './protocol/tape-index';
import { buildTapeIndex } from './protocol/tape-index';
import type { Tape as V7Tape } from './protocol/types';
import { computeTextureLayout } from './texel-layout';
import type { HandleId, RecordedTlasInstance, RhiCallEvent } from './types';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandEntry {
  readonly eventIndex: number;
  readonly passIndex: number;
  readonly kind: string;
  readonly category: EventCategory;
  readonly isWork: boolean;
  readonly params: JsonValue;
  readonly group: readonly string[];
  readonly marker?: string;
}

export interface FramePass {
  readonly passIndex: number;
  readonly kind: 'render' | 'compute';
  readonly beginEventIndex: number;
  readonly endEventIndex: number | null;
  readonly workIndices: readonly number[];
  readonly commandIndices: readonly number[];
  colorAttachmentViewHandleIds: readonly string[];
  /**
   * MSAA resolve target per color attachment, index-aligned with
   * `colorAttachmentViewHandleIds`; `null` for a single-sample attachment.
   */
  colorAttachmentResolveViewHandleIds: readonly (string | null)[];
  /** `3d` attachment depth slice per color attachment, index-aligned; `null` otherwise. */
  colorAttachmentDepthSlices: readonly (number | null)[];
  depthStencilViewHandleId: string | null;
}

export interface ResourceConsumer {
  readonly eventIndex: number;
  readonly workIndex: number | null;
  readonly access: 'read' | 'write';
}

export interface ResourceEntry {
  readonly resourceId: string;
  readonly kind: string;
  readonly origin: 'bootstrap' | 'frame';
  readonly createEventIndex: number | null;
  readonly destroyEventIndex: number | null;
  readonly descriptor: JsonValue | null;
  consumers: readonly ResourceConsumer[];
  readonly lifecycle: {
    readonly state: 'live' | 'destroyed' | 'unavailable';
    readonly byteEstimate: ResourceByteEstimate | null;
  };
}

export interface WorkBinding {
  readonly groupIndex: number;
  readonly binding: number;
  readonly bindGroupId: string;
  readonly resourceId: string | null;
  readonly resourceKind: string | null;
  readonly bufferOffset: number | null;
  readonly bufferSize: number | null;
  /** Offset applied by `setBindGroup` dynamic offsets; null for a static binding. */
  readonly dynamicOffset: number | null;
  /** From the explicit layout entry, else the pipeline's WGSL declaration. */
  readonly access: BindingAccess;
  /** Present for an acceleration-structure entry: the bound TLAS as of this work. */
  readonly accelerationStructure?: WorkAccelerationStructure;
}

export interface WorkAccelerationStructure {
  readonly tlasHandleId: string;
  readonly label: string | null;
  readonly status: 'built' | 'unbuilt';
  /** Instance count of the last build; 0 while unbuilt. */
  readonly instanceCount: number;
  /** BLAS handle ids referenced by the last build's instances, deduplicated in order. */
  readonly blasHandleIds: readonly string[];
}

export interface WorkPipeline {
  readonly status: 'available' | 'unavailable';
  readonly pipelineHandleId?: string;
  readonly kind?: 'render' | 'compute';
  readonly descriptor?: JsonValue;
  readonly shaders: readonly {
    readonly stage: 'vertex' | 'fragment' | 'compute';
    readonly moduleHandleId: string;
    readonly entryPoint: string | null;
    readonly source: string | null;
  }[];
  readonly reason?: 'pipeline-not-bound' | 'descriptor-unavailable';
}

export interface WorkEntry extends TapeWorkEntry {
  readonly commandIndex: number;
  readonly drawCall: JsonValue;
  readonly pipeline: WorkPipeline;
  readonly bindings: readonly WorkBinding[];
  readonly vertexBuffers: readonly {
    readonly slot: number;
    readonly bufferHandleId: string;
    readonly offset: number;
    readonly size: number | null;
  }[];
  readonly indexBuffer: {
    readonly bufferHandleId: string;
    readonly format: string;
    readonly offset: number;
    readonly size: number | null;
  } | null;
  readonly attachments: {
    readonly colorViewHandleIds: readonly string[];
    /** Index-aligned with `colorViewHandleIds`; `null` without a resolve target. */
    readonly colorResolveViewHandleIds: readonly (string | null)[];
    /** Index-aligned with `colorViewHandleIds`; the written `3d` slice or `null`. */
    readonly colorDepthSlices: readonly (number | null)[];
    readonly depthStencilViewHandleId: string | null;
  } | null;
}

export interface FrameModel {
  readonly unseededResources: readonly UnseededResource[];
  readonly commands: readonly CommandEntry[];
  readonly passes: readonly FramePass[];
  readonly resources: readonly ResourceEntry[];
  readonly resourceLifecycle: ResourceLifecycleSummary;
  readonly works: readonly WorkEntry[];
}

function tlasState(
  tlasHandleId: string,
  label: string | null,
  instances: readonly RecordedTlasInstance[] | undefined,
): WorkAccelerationStructure {
  return {
    tlasHandleId,
    label,
    status: instances === undefined ? 'unbuilt' : 'built',
    instanceCount: instances?.length ?? 0,
    blasHandleIds: [...new Set(instances?.map((instance) => instance.blasHandleId))],
  };
}

function accelerationStructureBinding(
  resourceKind: string | undefined,
  resourceId: string | null | undefined,
  tlasStates: ReadonlyMap<string, WorkAccelerationStructure>,
): { readonly accelerationStructure?: WorkAccelerationStructure } {
  if (resourceKind !== 'accelerationStructure' || resourceId == null) return {};
  return {
    accelerationStructure: tlasStates.get(resourceId) ?? tlasState(resourceId, null, undefined),
  };
}

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (ArrayBuffer.isView(value))
    return Array.from(value as unknown as ArrayLike<unknown>, jsonValue);
  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) output[key] = jsonValue(child);
    }
    return output;
  }
  return String(value);
}

function eventDescriptor(event: RhiCallEvent): JsonValue {
  return jsonValue(event);
}

// WebGPU consumes dynamic offsets in ascending binding order across the layout
// entries that declare `hasDynamicOffset`.
function dynamicOffsetsByBinding(
  layout: Extract<RhiCallEvent, { kind: 'createBindGroupLayout' }> | undefined,
  dynamicOffsets: readonly number[],
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  if (layout === undefined || dynamicOffsets.length === 0) return result;
  const dynamicBindings = [...layout.desc.entries]
    .filter((entry) => entry.buffer?.hasDynamicOffset === true)
    .map((entry) => entry.binding)
    .sort((a, b) => a - b);
  for (const [index, binding] of dynamicBindings.entries()) {
    const offset = dynamicOffsets[index];
    if (offset !== undefined) result.set(binding, offset);
  }
  return result;
}

function bindingAccess(
  layout: Extract<RhiCallEvent, { kind: 'createBindGroupLayout' }> | undefined,
  binding: number,
  declared: () => BindingAccess | undefined,
): BindingAccess {
  const entry =
    layout === undefined
      ? undefined
      : [...layout.desc.entries].find((candidate) => candidate.binding === binding);
  return entry === undefined ? (declared() ?? 'unknown') : layoutEntryAccess(entry);
}

function workPipeline(
  pipelineId: string | undefined,
  pipelineEvents: ReadonlyMap<string, RhiCallEvent>,
  shaderEvents: ReadonlyMap<string, RhiCallEvent>,
): WorkPipeline {
  if (pipelineId === undefined)
    return { status: 'unavailable', shaders: [], reason: 'pipeline-not-bound' };
  const event = pipelineEvents.get(pipelineId);
  if (event === undefined)
    return { status: 'unavailable', shaders: [], reason: 'descriptor-unavailable' };
  const shaders: WorkPipeline['shaders'][number][] = [];
  const shaderRefs =
    event.kind === 'createRenderPipeline'
      ? [
          ['vertex', event.vertexShaderModuleHandleId, event.desc.vertex?.entryPoint],
          ['fragment', event.fragmentShaderModuleHandleId, event.desc.fragment?.entryPoint],
        ]
      : event.kind === 'createComputePipeline'
        ? [['compute', event.computeShaderModuleHandleId, event.desc.compute.entryPoint]]
        : [];
  for (const [stage, moduleId, entryPoint] of shaderRefs) {
    if (typeof moduleId !== 'string') continue;
    const shader = shaderEvents.get(moduleId);
    shaders.push({
      stage: stage as 'vertex' | 'fragment' | 'compute',
      moduleHandleId: moduleId,
      entryPoint: typeof entryPoint === 'string' ? entryPoint : null,
      source: shader?.kind === 'createShaderModule' ? shader.wgslCode : null,
    });
  }
  return {
    status: 'available',
    pipelineHandleId: pipelineId,
    kind: event.kind === 'createRenderPipeline' ? 'render' : 'compute',
    descriptor: eventDescriptor(event),
    shaders,
  };
}

export function buildFrameModel(tape: V7Tape): FrameModel {
  const index = buildTapeIndex(tape);
  const events = tape.events;
  const passCommandIndices = index.passes.map(() => [] as number[]);
  const commands: CommandEntry[] = [];
  const groupPath: string[] = [];
  const currentPassByEvent = index.passIndexByEvent;
  const passAttachmentByIndex = new Map<number, FramePass>();

  for (const pass of index.passes) {
    passAttachmentByIndex.set(pass.passIndex, {
      passIndex: pass.passIndex,
      kind: pass.kind,
      beginEventIndex: pass.beginEventIndex,
      endEventIndex: pass.endEventIndex ?? null,
      workIndices: pass.workIndices,
      commandIndices: [],
      colorAttachmentViewHandleIds: [],
      colorAttachmentResolveViewHandleIds: [],
      colorAttachmentDepthSlices: [],
      depthStencilViewHandleId: null,
    });
    const begin = events[pass.beginEventIndex];
    if (begin?.kind === 'beginRenderPass') {
      const attachment = passAttachmentByIndex.get(pass.passIndex);
      if (attachment !== undefined) {
        const color: string[] = [];
        const resolve: (string | null)[] = [];
        const slices: (number | null)[] = [];
        const descriptors = Array.from(begin.desc.colorAttachments);
        for (const [slot, id] of begin.colorAttachmentViewHandleIds.entries()) {
          if (typeof id !== 'string') continue;
          color.push(id);
          resolve.push(begin.colorAttachmentResolveTargetHandleIds?.[slot] ?? null);
          const depthSlice = descriptors[slot]?.depthSlice;
          slices.push(typeof depthSlice === 'number' ? depthSlice : null);
        }
        attachment.colorAttachmentViewHandleIds = color;
        attachment.colorAttachmentResolveViewHandleIds = resolve;
        attachment.colorAttachmentDepthSlices = slices;
        attachment.depthStencilViewHandleId = begin.depthStencilViewHandleId ?? null;
      }
    }
  }

  for (const [eventIndex, event] of events.entries()) {
    const passIndex = currentPassByEvent[eventIndex] ?? -1;
    const isPush = event.kind === 'pushDebugGroup' || event.kind === 'passPushDebugGroup';
    const isPop = event.kind === 'popDebugGroup' || event.kind === 'passPopDebugGroup';
    const group = isPush ? [...groupPath, event.groupLabel] : [...groupPath];
    const marker =
      event.kind === 'insertDebugMarker' || event.kind === 'passInsertDebugMarker'
        ? event.markerLabel
        : undefined;
    const commandIndex = commands.length;
    commands.push({
      eventIndex,
      passIndex,
      kind: event.kind,
      category: EVENT_SEMANTICS[event.kind].category,
      isWork: isWorkEvent(event.kind),
      params: eventDescriptor(event),
      group,
      ...(marker === undefined ? {} : { marker }),
    });
    if (passIndex >= 0) passCommandIndices[passIndex]?.push(commandIndex);
    if (isPush) groupPath.push(event.groupLabel);
    if (isPop) groupPath.pop();
  }

  const pipelineEvents = new Map<string, RhiCallEvent>();
  const shaderEvents = new Map<string, RhiCallEvent>();
  const bindGroups = new Map<string, Extract<RhiCallEvent, { kind: 'createBindGroup' }>>();
  const bindGroupLayouts = new Map<
    string,
    Extract<RhiCallEvent, { kind: 'createBindGroupLayout' }>
  >();
  const resourceRecords = new Map<string, ResourceEntry>();
  const workByEvent = new Map<number, number>();
  for (const work of index.works) workByEvent.set(work.eventIndex, work.workIndex);

  // Bootstrap creates and in-frame creates feed the same handle indexes.
  const indexCreateEvent = (event: RhiCallEvent): void => {
    if (event.kind === 'createRenderPipeline' || event.kind === 'createComputePipeline')
      pipelineEvents.set(event.handleId, event);
    if (event.kind === 'createShaderModule') shaderEvents.set(event.handleId, event);
    if (event.kind === 'createBindGroup') bindGroups.set(event.handleId, event);
    if (event.kind === 'createBindGroupLayout') bindGroupLayouts.set(event.handleId, event);
  };

  const tlasStates = new Map<string, WorkAccelerationStructure>();
  const indexTlasCreate = (event: RhiCallEvent): void => {
    if (event.kind !== 'createTlas') return;
    tlasStates.set(
      event.handleId,
      tlasState(event.handleId, event.desc.label ?? null, event.build?.instances),
    );
  };

  for (const bootstrap of tape.bootstrap) {
    // Strict v7 decoding validates each bootstrap create record against the same
    // RhiCallEvent union before FrameModel construction.
    const create = bootstrap.create as unknown as RhiCallEvent;
    indexCreateEvent(create);
    indexTlasCreate(create);
    resourceRecords.set(bootstrap.handleId, {
      resourceId: bootstrap.handleId,
      kind: bootstrap.kind,
      origin: 'bootstrap',
      createEventIndex: null,
      destroyEventIndex: null,
      descriptor: jsonValue(bootstrap.create),
      consumers: [],
      lifecycle: { state: 'unavailable', byteEstimate: null },
    });
  }
  for (const [eventIndex, event] of events.entries()) {
    indexCreateEvent(event);
    const kind = resourceKindForEvent(event.kind);
    if (kind === undefined) continue;
    for (const handleId of EVENT_SEMANTICS[event.kind].created(event)) {
      resourceRecords.set(handleId, {
        resourceId: handleId,
        kind,
        origin: 'frame',
        createEventIndex: eventIndex,
        destroyEventIndex: null,
        descriptor: eventDescriptor(event),
        consumers: [],
        lifecycle: { state: 'unavailable', byteEstimate: null },
      });
    }
  }

  const lifecycle = buildResourceLifecycle(tape);
  for (const record of lifecycle.resources) {
    const resource = resourceRecords.get(record.handleId);
    if (resource === undefined) continue;
    resourceRecords.set(record.handleId, {
      ...resource,
      destroyEventIndex: record.destroyedEventIndex ?? null,
      lifecycle: { state: record.state, byteEstimate: record.byteEstimate },
    });
  }
  for (const [eventIndex, event] of events.entries()) {
    const workIndex = workByEvent.get(eventIndex) ?? null;
    for (const resourceId of EVENT_SEMANTICS[event.kind].read(event)) {
      const resource = resourceRecords.get(resourceId);
      if (resource !== undefined)
        resource.consumers = [...resource.consumers, { eventIndex, workIndex, access: 'read' }];
    }
    for (const resourceId of EVENT_SEMANTICS[event.kind].written(event)) {
      const resource = resourceRecords.get(resourceId);
      if (resource !== undefined)
        resource.consumers = [...resource.consumers, { eventIndex, workIndex, access: 'write' }];
    }
  }

  const works: WorkEntry[] = [];
  const currentPipeline = new Map<string, string>();
  const currentVertexBuffers = new Map<
    string,
    Map<number, { bufferHandleId: string; offset: number; size: number | null }>
  >();
  const currentIndexBuffers = new Map<string, WorkEntry['indexBuffer']>();
  const currentBindGroups = new Map<
    string,
    Map<number, { bindGroupId: string; dynamicOffsets: readonly number[] }>
  >();
  const workByEventEntry = new Map(index.works.map((work) => [work.eventIndex, work]));
  for (const [eventIndex, event] of events.entries()) {
    if (event === undefined) continue;
    indexTlasCreate(event);
    if (event.kind === 'buildAccelerationStructures')
      for (const { tlasHandleId, instances } of event.tlas)
        tlasStates.set(
          tlasHandleId,
          tlasState(tlasHandleId, tlasStates.get(tlasHandleId)?.label ?? null, instances),
        );
    const passHandleId = 'passHandleId' in event ? event.passHandleId : '';
    if (event.kind === 'resetRenderState') {
      currentPipeline.delete(passHandleId);
      currentVertexBuffers.delete(passHandleId);
      currentIndexBuffers.delete(passHandleId);
      currentBindGroups.delete(passHandleId);
    }
    if (event.kind === 'setPipeline' || event.kind === 'setComputePipeline')
      currentPipeline.set(passHandleId, event.pipelineHandleId);
    if (event.kind === 'setVertexBuffer') {
      const buffers = currentVertexBuffers.get(passHandleId) ?? new Map();
      buffers.set(event.slot, {
        bufferHandleId: event.bufferHandleId,
        offset: event.offset ?? 0,
        size: event.size ?? null,
      });
      currentVertexBuffers.set(passHandleId, buffers);
    }
    if (event.kind === 'setIndexBuffer')
      currentIndexBuffers.set(passHandleId, {
        bufferHandleId: event.bufferHandleId,
        format: event.format,
        offset: event.offset ?? 0,
        size: event.size ?? null,
      });
    if (event.kind === 'setBindGroup') {
      const groups = currentBindGroups.get(passHandleId) ?? new Map();
      groups.set(event.index, {
        bindGroupId: event.bindGroupHandleId,
        dynamicOffsets: event.dynamicOffsets ?? [],
      });
      currentBindGroups.set(passHandleId, groups);
    }
    if (!isWorkEvent(event.kind)) continue;
    const work = workByEventEntry.get(eventIndex);
    if (work === undefined) continue;
    const pipelineId = currentPipeline.get(passHandleId);
    const groups = currentBindGroups.get(passHandleId) ?? new Map();
    const bindings: WorkBinding[] = [];
    const pipeline = workPipeline(pipelineId, pipelineEvents, shaderEvents);
    let declared: ReadonlyMap<string, BindingAccess> | undefined;
    for (const [groupIndex, { bindGroupId, dynamicOffsets }] of groups) {
      const bindGroup = bindGroups.get(bindGroupId);
      const layout =
        bindGroup === undefined ? undefined : bindGroupLayouts.get(bindGroup.layoutHandleId);
      const dynamicOffsetByBinding = dynamicOffsetsByBinding(layout, dynamicOffsets);
      for (const [entryIndex, resourceId] of bindGroup?.resourceHandleIds.entries() ?? []) {
        const entry = bindGroup?.entries[entryIndex];
        bindings.push({
          groupIndex,
          binding: entry?.binding ?? entryIndex,
          bindGroupId,
          resourceId: resourceId ?? null,
          resourceKind: entry?.resourceKind ?? null,
          bufferOffset: entry?.bufferOffset ?? null,
          bufferSize: entry?.bufferSize ?? null,
          dynamicOffset: dynamicOffsetByBinding.get(entry?.binding ?? entryIndex) ?? null,
          access: bindingAccess(layout, entry?.binding ?? entryIndex, () => {
            declared ??= wgslBindingAccess(pipeline.shaders.map((shader) => shader.source));
            return declared.get(`${groupIndex}:${entry?.binding ?? entryIndex}`);
          }),
          ...accelerationStructureBinding(entry?.resourceKind, resourceId, tlasStates),
        });
      }
    }
    const attachment = passAttachmentByIndex.get(work.passIndex);
    works.push({
      ...work,
      commandIndex: commands.findIndex((command) => command.eventIndex === work.eventIndex),
      drawCall: eventDescriptor(event),
      pipeline,
      bindings,
      vertexBuffers: [...(currentVertexBuffers.get(passHandleId)?.entries() ?? [])].map(
        ([slot, buffer]) => ({ slot, ...buffer }),
      ),
      indexBuffer: currentIndexBuffers.get(passHandleId) ?? null,
      attachments:
        attachment === undefined
          ? null
          : {
              colorViewHandleIds: attachment.colorAttachmentViewHandleIds,
              colorResolveViewHandleIds: attachment.colorAttachmentResolveViewHandleIds,
              colorDepthSlices: attachment.colorAttachmentDepthSlices,
              depthStencilViewHandleId: attachment.depthStencilViewHandleId,
            },
    });
  }

  const passes = index.passes.map((pass) => ({
    ...pass,
    endEventIndex: pass.endEventIndex ?? null,
    commandIndices: passCommandIndices[pass.passIndex] ?? [],
    colorAttachmentViewHandleIds:
      passAttachmentByIndex.get(pass.passIndex)?.colorAttachmentViewHandleIds ?? [],
    colorAttachmentResolveViewHandleIds:
      passAttachmentByIndex.get(pass.passIndex)?.colorAttachmentResolveViewHandleIds ?? [],
    colorAttachmentDepthSlices:
      passAttachmentByIndex.get(pass.passIndex)?.colorAttachmentDepthSlices ?? [],
    depthStencilViewHandleId:
      passAttachmentByIndex.get(pass.passIndex)?.depthStencilViewHandleId ?? null,
  }));
  return {
    unseededResources: unseededResources(tape),
    commands,
    passes,
    resources: [...resourceRecords.values()],
    resourceLifecycle: lifecycle,
    works,
  };
}

/** A byte estimate that distinguishes known descriptor size from unavailable GPU facts. */
export type ResourceByteEstimate =
  | {
      readonly status: 'known';
      readonly bytes: number;
      readonly basis: 'buffer-descriptor' | 'texture-tight-layout';
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'non-memory-resource'
        | 'unsupported-texture-dimension'
        | 'unsupported-texture-format'
        | 'invalid-texture-size';
    };

export type ResourceKind =
  | 'buffer'
  | 'texture'
  | 'texture-view'
  | 'sampler'
  | 'bind-group-layout'
  | 'bind-group'
  | 'pipeline-layout'
  | 'render-pipeline'
  | 'compute-pipeline'
  | 'shader-module';

export type ResourceOrigin = 'engine' | 'swapchain';

export interface ResourceLifecycleEntry {
  readonly handleId: HandleId;
  readonly kind: ResourceKind;
  readonly origin: ResourceOrigin;
  readonly state: 'live' | 'destroyed';
  readonly createdEventIndex: number | null;
  readonly destroyedEventIndex?: number;
  readonly byteEstimate: ResourceByteEstimate;
}

export interface ResourceLifecycleSummary {
  /** This is the resource closure represented by the tape, not the whole device heap. */
  readonly scope: 'captured-tape-resource-closure';
  readonly counts: {
    readonly created: number;
    readonly destroyed: number;
    readonly live: number;
    /** Maximum API-observed live resources within this captured closure. */
    readonly peakLive: number;
    readonly destroyEvents: number;
    readonly unknownDestroyEvents: number;
  };
  readonly bytes: {
    readonly knownCreated: number;
    readonly knownDestroyed: number;
    readonly knownLive: number;
    /** Maximum simultaneously live descriptor payload; excludes unknown driver bytes. */
    readonly knownPeak: number;
    readonly unavailableCreated: number;
    readonly unavailableDestroyed: number;
    readonly unavailableLive: number;
    readonly unavailablePeak: number;
  };
  readonly originBreakdown: Readonly<
    Record<
      ResourceOrigin,
      {
        readonly created: number;
        readonly destroyed: number;
        readonly live: number;
        readonly knownCreated: number;
        readonly knownDestroyed: number;
        readonly knownLive: number;
        readonly unavailableCreated: number;
        readonly unavailableDestroyed: number;
        readonly unavailableLive: number;
      }
    >
  >;
  readonly availability: {
    readonly destroy: 'observed-buffer-texture';
    readonly retire: 'unavailable';
    readonly driverAllocation: 'unavailable';
  };
  readonly resources: readonly ResourceLifecycleEntry[];
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeTextureSize(
  size: unknown,
):
  | { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number }
  | undefined {
  if (typeof size === 'number') {
    const width = asPositiveInteger(size);
    return width === undefined ? undefined : { width, height: 1, depthOrArrayLayers: 1 };
  }
  if (Array.isArray(size)) {
    const width = asPositiveInteger(size[0]);
    const height = asPositiveInteger(size[1] ?? 1);
    const depthOrArrayLayers = asPositiveInteger(size[2] ?? 1);
    return width === undefined || height === undefined || depthOrArrayLayers === undefined
      ? undefined
      : { width, height, depthOrArrayLayers };
  }
  if (size !== null && typeof size === 'object') {
    const raw = size as {
      readonly width?: unknown;
      readonly height?: unknown;
      readonly depthOrArrayLayers?: unknown;
    };
    const width = asPositiveInteger(raw.width);
    const height = asPositiveInteger(raw.height ?? 1);
    const depthOrArrayLayers = asPositiveInteger(raw.depthOrArrayLayers ?? 1);
    return width === undefined || height === undefined || depthOrArrayLayers === undefined
      ? undefined
      : { width, height, depthOrArrayLayers };
  }
  return undefined;
}

function estimateBytes(event: RhiCallEvent): ResourceByteEstimate {
  if (event.kind === 'createBuffer') {
    return { status: 'known', bytes: event.desc.size, basis: 'buffer-descriptor' };
  }
  if (event.kind !== 'createTexture') {
    return { status: 'unavailable', reason: 'non-memory-resource' };
  }

  const dimension = event.desc.dimension ?? '2d';
  if (dimension === '3d') {
    return { status: 'unavailable', reason: 'unsupported-texture-dimension' };
  }
  const size = normalizeTextureSize(event.desc.size);
  if (size === undefined) return { status: 'unavailable', reason: 'invalid-texture-size' };
  const layers = dimension === '1d' ? 1 : size.depthOrArrayLayers;
  const layout = computeTextureLayout(
    event.desc.format,
    size.width,
    size.height,
    layers,
    event.desc.mipLevelCount ?? 1,
  );
  if (layout === undefined) return { status: 'unavailable', reason: 'unsupported-texture-format' };
  return {
    status: 'known',
    bytes: layout.totalBytes * (event.desc.sampleCount ?? 1),
    basis: 'texture-tight-layout',
  };
}

function resourceIdentity(
  event: RhiCallEvent,
): { readonly kind: ResourceKind; readonly handleId: HandleId } | undefined {
  const kind = lifecycleResourceKind(event.kind);
  const [handleId] = EVENT_SEMANTICS[event.kind].created(event);
  return kind === undefined || handleId === undefined ? undefined : { kind, handleId };
}

function lifecycleResourceKind(kind: RhiCallEvent['kind']): ResourceKind | undefined {
  switch (kind) {
    case 'createBuffer':
      return 'buffer';
    case 'createTexture':
      return 'texture';
    case 'createTextureView':
      return 'texture-view';
    case 'createSampler':
      return 'sampler';
    case 'createBindGroupLayout':
      return 'bind-group-layout';
    case 'createBindGroup':
      return 'bind-group';
    case 'createPipelineLayout':
      return 'pipeline-layout';
    case 'createRenderPipeline':
      return 'render-pipeline';
    case 'createComputePipeline':
      return 'compute-pipeline';
    case 'createShaderModule':
      return 'shader-module';
    default:
      return undefined;
  }
}

function addBytes(
  bytes: { known: number; unavailable: number },
  estimate: ResourceByteEstimate,
): void {
  if (estimate.status === 'known') bytes.known += estimate.bytes;
  else bytes.unavailable++;
}

/** Join initial v7 ownership to frame events; bootstrap creation has no frame event index. */
export function buildResourceLifecycle(
  tape: Pick<V7Tape, 'bootstrap' | 'events'>,
): ResourceLifecycleSummary {
  const { events } = tape;
  const records = new Map<
    HandleId,
    {
      readonly kind: ResourceKind;
      readonly origin: ResourceOrigin;
      readonly createdEventIndex: number | null;
      readonly byteEstimate: ResourceByteEstimate;
      destroyedEventIndex?: number;
    }
  >();
  const origins = new Map<HandleId, ResourceOrigin>();
  let destroyEvents = 0;
  let unknownDestroyEvents = 0;
  let liveCount = 0;
  let peakLive = 0;
  let knownLive = 0;
  let knownPeak = 0;
  let unavailableLive = 0;
  let unavailablePeak = 0;

  const recordCreate = (event: RhiCallEvent, eventIndex: number | null): boolean => {
    const identity = resourceIdentity(event);
    if (identity === undefined) return false;
    const origin: ResourceOrigin =
      event.kind === 'createTexture' && event.origin === 'swapchain'
        ? 'swapchain'
        : event.kind === 'createTextureView'
          ? (origins.get(event.sourceHandleId) ?? 'engine')
          : 'engine';
    origins.set(identity.handleId, origin);
    const byteEstimate = estimateBytes(event);
    records.set(identity.handleId, {
      kind: identity.kind,
      origin,
      createdEventIndex: eventIndex,
      byteEstimate,
    });
    liveCount++;
    if (byteEstimate.status === 'known') knownLive += byteEstimate.bytes;
    else unavailableLive++;
    peakLive = Math.max(peakLive, liveCount);
    knownPeak = Math.max(knownPeak, knownLive);
    unavailablePeak = Math.max(unavailablePeak, unavailableLive);
    return true;
  };
  for (const resource of tape.bootstrap) {
    // The strict v7 decoder validates bootstrap creates against the RHI event union.
    recordCreate(resource.create as unknown as RhiCallEvent, null);
  }
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event === undefined || recordCreate(event, eventIndex)) continue;
    if (event.kind !== 'destroyBuffer' && event.kind !== 'destroyTexture') continue;
    destroyEvents++;
    const record = records.get(event.handleId);
    const expectedKind = event.kind === 'destroyBuffer' ? 'buffer' : 'texture';
    if (
      record === undefined ||
      record.kind !== expectedKind ||
      record.destroyedEventIndex !== undefined
    ) {
      unknownDestroyEvents++;
      continue;
    }
    record.destroyedEventIndex = eventIndex;
    liveCount--;
    if (record.byteEstimate.status === 'known') knownLive -= record.byteEstimate.bytes;
    else unavailableLive--;
  }

  const resources: ResourceLifecycleEntry[] = [];
  const createdBytes = { known: 0, unavailable: 0 };
  const destroyedBytes = { known: 0, unavailable: 0 };
  const liveBytes = { known: 0, unavailable: 0 };
  const originBreakdown: Record<
    ResourceOrigin,
    {
      created: number;
      destroyed: number;
      live: number;
      knownCreated: number;
      knownDestroyed: number;
      knownLive: number;
      unavailableCreated: number;
      unavailableDestroyed: number;
      unavailableLive: number;
    }
  > = {
    engine: {
      created: 0,
      destroyed: 0,
      live: 0,
      knownCreated: 0,
      knownDestroyed: 0,
      knownLive: 0,
      unavailableCreated: 0,
      unavailableDestroyed: 0,
      unavailableLive: 0,
    },
    swapchain: {
      created: 0,
      destroyed: 0,
      live: 0,
      knownCreated: 0,
      knownDestroyed: 0,
      knownLive: 0,
      unavailableCreated: 0,
      unavailableDestroyed: 0,
      unavailableLive: 0,
    },
  };
  let destroyed = 0;

  for (const [handleId, record] of records) {
    const state = record.destroyedEventIndex === undefined ? 'live' : 'destroyed';
    if (state === 'destroyed') destroyed++;
    addBytes(createdBytes, record.byteEstimate);
    addBytes(state === 'live' ? liveBytes : destroyedBytes, record.byteEstimate);
    const byOrigin = originBreakdown[record.origin];
    byOrigin.created++;
    if (state === 'destroyed') byOrigin.destroyed++;
    else byOrigin.live++;
    if (record.byteEstimate.status === 'known') {
      byOrigin.knownCreated += record.byteEstimate.bytes;
      if (state === 'destroyed') byOrigin.knownDestroyed += record.byteEstimate.bytes;
      else byOrigin.knownLive += record.byteEstimate.bytes;
    } else {
      byOrigin.unavailableCreated++;
      if (state === 'destroyed') byOrigin.unavailableDestroyed++;
      else byOrigin.unavailableLive++;
    }
    resources.push({
      handleId,
      kind: record.kind,
      origin: record.origin,
      state,
      createdEventIndex: record.createdEventIndex,
      ...(record.destroyedEventIndex === undefined
        ? {}
        : { destroyedEventIndex: record.destroyedEventIndex }),
      byteEstimate: record.byteEstimate,
    });
  }

  return {
    scope: 'captured-tape-resource-closure',
    counts: {
      created: resources.length,
      destroyed,
      live: resources.length - destroyed,
      peakLive,
      destroyEvents,
      unknownDestroyEvents,
    },
    bytes: {
      knownCreated: createdBytes.known,
      knownDestroyed: destroyedBytes.known,
      knownLive: liveBytes.known,
      knownPeak,
      unavailableCreated: createdBytes.unavailable,
      unavailableDestroyed: destroyedBytes.unavailable,
      unavailableLive: liveBytes.unavailable,
      unavailablePeak,
    },
    originBreakdown,
    availability: {
      destroy: 'observed-buffer-texture',
      retire: 'unavailable',
      driverAllocation: 'unavailable',
    },
    resources,
  };
}
