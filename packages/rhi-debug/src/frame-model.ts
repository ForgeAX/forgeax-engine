// @forgeax/engine-rhi-debug/src/frame-model -- v7 structural tape projection.

/// <reference types="@webgpu/types" />

import { type BindingAccess, layoutEntryAccess, wgslBindingAccess } from './binding-access';
import { type UnseededResource, unseededResources } from './initial-contents';
import {
  categoryFor,
  createdHandles,
  type EventCategory,
  handleAccess,
  isWorkEvent,
  resourceKindForEvent,
} from './protocol/event-semantics';
import type { TapePassEntry, TapeWorkEntry } from './protocol/tape-index';
import { buildTapeIndex } from './protocol/tape-index';
import type { Tape as V7Tape } from './protocol/types';
import { computeTextureLayout, projectTextureExtent } from './texel-layout';
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

export interface FramePass extends Omit<TapePassEntry, 'endEventIndex'> {
  readonly endEventIndex: number | null;
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

export type WorkPipeline =
  | {
      readonly status: 'available';
      readonly pipelineHandleId: string;
      readonly kind: 'render' | 'compute';
      readonly descriptor: JsonValue;
      readonly shaders: readonly {
        readonly stage: 'vertex' | 'fragment' | 'compute';
        readonly moduleHandleId: string;
        readonly entryPoint: string | null;
        readonly source: string | null;
      }[];
      readonly reason?: never;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'pipeline-not-bound' | 'descriptor-unavailable';
      readonly shaders: readonly [];
      readonly pipelineHandleId?: never;
      readonly kind?: never;
      readonly descriptor?: never;
    };

type PipelineEvent = Extract<
  RhiCallEvent,
  { kind: 'createRenderPipeline' | 'createComputePipeline' }
>;
type ShaderEvent = Extract<RhiCallEvent, { kind: 'createShaderModule' }>;

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
  pipelineEvents: ReadonlyMap<string, PipelineEvent>,
  shaderEvents: ReadonlyMap<string, ShaderEvent>,
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
          ['vertex', event.vertexShaderModuleHandleId, event.desc.vertex?.entryPoint] as const,
          [
            'fragment',
            event.fragmentShaderModuleHandleId,
            event.desc.fragment?.entryPoint,
          ] as const,
        ]
      : [['compute', event.computeShaderModuleHandleId, event.desc.compute.entryPoint] as const];
  for (const [stage, moduleId, entryPoint] of shaderRefs) {
    if (typeof moduleId !== 'string') continue;
    const shader = shaderEvents.get(moduleId);
    shaders.push({
      stage,
      moduleHandleId: moduleId,
      entryPoint: typeof entryPoint === 'string' ? entryPoint : null,
      source: shader?.wgslCode ?? null,
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

type BindGroupEvent = Extract<RhiCallEvent, { kind: 'createBindGroup' }>;
type BindGroupLayoutEvent = Extract<RhiCallEvent, { kind: 'createBindGroupLayout' }>;
type TapeIndex = ReturnType<typeof buildTapeIndex>;

function renderPassAttachments(
  pass: TapePassEntry,
  begin: Extract<RhiCallEvent, { kind: 'beginRenderPass' }>,
): FramePass {
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
  return {
    ...emptyFramePass(pass),
    colorAttachmentViewHandleIds: color,
    colorAttachmentResolveViewHandleIds: resolve,
    colorAttachmentDepthSlices: slices,
    depthStencilViewHandleId: begin.depthStencilViewHandleId ?? null,
  };
}

function emptyFramePass(pass: TapePassEntry): FramePass {
  return {
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
  };
}

/** Attachment views per pass, keyed by pass index; only render passes bind attachments. */
function passAttachments(
  index: TapeIndex,
  events: readonly RhiCallEvent[],
): Map<number, FramePass> {
  const byPass = new Map<number, FramePass>();
  for (const pass of index.passes) {
    const begin = events[pass.beginEventIndex];
    byPass.set(
      pass.passIndex,
      begin?.kind === 'beginRenderPass' ? renderPassAttachments(pass, begin) : emptyFramePass(pass),
    );
  }
  return byPass;
}

function frameCommands(
  index: TapeIndex,
  events: readonly RhiCallEvent[],
): { readonly commands: CommandEntry[]; readonly passCommandIndices: number[][] } {
  const passCommandIndices = index.passes.map(() => [] as number[]);
  const commands: CommandEntry[] = [];
  const groupPath: string[] = [];
  for (const [eventIndex, event] of events.entries()) {
    const passIndex = index.passIndexByEvent[eventIndex] ?? -1;
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
      category: categoryFor(event.kind),
      isWork: isWorkEvent(event.kind),
      params: eventDescriptor(event),
      group,
      ...(marker === undefined ? {} : { marker }),
    });
    if (passIndex >= 0) passCommandIndices[passIndex]?.push(commandIndex);
    if (isPush) groupPath.push(event.groupLabel);
    if (isPop) groupPath.pop();
  }
  return { commands, passCommandIndices };
}

/** Bootstrap creates and in-frame creates feed the same handle indexes. */
class CreatedHandleIndex {
  readonly pipelines = new Map<string, PipelineEvent>();
  readonly shaders = new Map<string, ShaderEvent>();
  readonly bindGroups = new Map<string, BindGroupEvent>();
  readonly bindGroupLayouts = new Map<string, BindGroupLayoutEvent>();

  add(event: RhiCallEvent): void {
    if (event.kind === 'createRenderPipeline' || event.kind === 'createComputePipeline')
      this.pipelines.set(event.handleId, event);
    if (event.kind === 'createShaderModule') this.shaders.set(event.handleId, event);
    if (event.kind === 'createBindGroup') this.bindGroups.set(event.handleId, event);
    if (event.kind === 'createBindGroupLayout') this.bindGroupLayouts.set(event.handleId, event);
  }

  layoutOf(bindGroup: BindGroupEvent | undefined): BindGroupLayoutEvent | undefined {
    return bindGroup === undefined
      ? undefined
      : this.bindGroupLayouts.get(bindGroup.layoutHandleId);
  }
}

/** TLAS build state as of the event cursor; bootstrap creates seed it. */
class TlasStates {
  readonly states = new Map<string, WorkAccelerationStructure>();

  apply(event: RhiCallEvent): void {
    if (event.kind === 'createTlas') {
      this.states.set(
        event.handleId,
        tlasState(event.handleId, event.desc.label ?? null, event.build?.instances),
      );
    }
    if (event.kind === 'buildAccelerationStructures')
      for (const { tlasHandleId, instances } of event.tlas)
        this.states.set(
          tlasHandleId,
          tlasState(tlasHandleId, this.states.get(tlasHandleId)?.label ?? null, instances),
        );
  }
}

function unavailableResource(
  resourceId: string,
  kind: string,
  origin: ResourceEntry['origin'],
  createEventIndex: number | null,
  descriptor: JsonValue,
): ResourceEntry {
  return {
    resourceId,
    kind,
    origin,
    createEventIndex,
    destroyEventIndex: null,
    descriptor,
    consumers: [],
    lifecycle: { state: 'unavailable', byteEstimate: null },
  };
}

function frameResources(
  tape: V7Tape,
  handles: CreatedHandleIndex,
  tlas: TlasStates,
): Map<string, ResourceEntry> {
  const resources = new Map<string, ResourceEntry>();
  for (const bootstrap of tape.bootstrap) {
    // Strict v7 decoding validates each bootstrap create record against the same
    // RhiCallEvent union before FrameModel construction.
    const create = bootstrap.create as unknown as RhiCallEvent;
    handles.add(create);
    tlas.apply(create);
    resources.set(
      bootstrap.handleId,
      unavailableResource(
        bootstrap.handleId,
        bootstrap.kind,
        'bootstrap',
        null,
        jsonValue(bootstrap.create),
      ),
    );
  }
  for (const [eventIndex, event] of tape.events.entries()) {
    handles.add(event);
    const kind = resourceKindForEvent(event.kind);
    if (kind === undefined) continue;
    for (const handleId of createdHandles(event))
      resources.set(
        handleId,
        unavailableResource(handleId, kind, 'frame', eventIndex, eventDescriptor(event)),
      );
  }
  return resources;
}

function applyResourceLifecycle(
  resources: Map<string, ResourceEntry>,
  lifecycle: ResourceLifecycleSummary,
): void {
  for (const record of lifecycle.resources) {
    const resource = resources.get(record.handleId);
    if (resource === undefined) continue;
    resources.set(record.handleId, {
      ...resource,
      destroyEventIndex: record.destroyedEventIndex ?? null,
      lifecycle: { state: record.state, byteEstimate: record.byteEstimate },
    });
  }
}

function appendConsumer(
  resources: ReadonlyMap<string, ResourceEntry>,
  resourceId: string,
  consumer: ResourceConsumer,
): void {
  const resource = resources.get(resourceId);
  if (resource !== undefined) resource.consumers = [...resource.consumers, consumer];
}

function recordConsumers(
  resources: ReadonlyMap<string, ResourceEntry>,
  index: TapeIndex,
  events: readonly RhiCallEvent[],
): void {
  const workByEvent = new Map<number, number>();
  for (const work of index.works) workByEvent.set(work.eventIndex, work.workIndex);
  for (const [eventIndex, event] of events.entries()) {
    const workIndex = workByEvent.get(eventIndex) ?? null;
    const access = handleAccess(event);
    for (const resourceId of access.read)
      appendConsumer(resources, resourceId, { eventIndex, workIndex, access: 'read' });
    for (const resourceId of access.written)
      appendConsumer(resources, resourceId, { eventIndex, workIndex, access: 'write' });
  }
}

interface BoundBindGroup {
  readonly bindGroupId: string;
  readonly dynamicOffsets: readonly number[];
}

interface BoundVertexBuffer {
  readonly bufferHandleId: string;
  readonly offset: number;
  readonly size: number | null;
}

/** Pipeline, vertex/index buffers and bind groups currently set on each pass encoder. */
class PassBindingState {
  readonly #pipeline = new Map<string, string>();
  readonly #vertexBuffers = new Map<string, Map<number, BoundVertexBuffer>>();
  readonly #indexBuffers = new Map<string, WorkEntry['indexBuffer']>();
  readonly #bindGroups = new Map<string, Map<number, BoundBindGroup>>();

  apply(event: RhiCallEvent, passHandleId: string): void {
    if (event.kind === 'resetRenderState') {
      this.#pipeline.delete(passHandleId);
      this.#vertexBuffers.delete(passHandleId);
      this.#indexBuffers.delete(passHandleId);
      this.#bindGroups.delete(passHandleId);
    }
    if (event.kind === 'setPipeline' || event.kind === 'setComputePipeline')
      this.#pipeline.set(passHandleId, event.pipelineHandleId);
    if (event.kind === 'setVertexBuffer') {
      const buffers = this.#vertexBuffers.get(passHandleId) ?? new Map();
      buffers.set(event.slot, {
        bufferHandleId: event.bufferHandleId,
        offset: event.offset ?? 0,
        size: event.size ?? null,
      });
      this.#vertexBuffers.set(passHandleId, buffers);
    }
    if (event.kind === 'setIndexBuffer')
      this.#indexBuffers.set(passHandleId, {
        bufferHandleId: event.bufferHandleId,
        format: event.format,
        offset: event.offset ?? 0,
        size: event.size ?? null,
      });
    if (event.kind === 'setBindGroup') {
      const groups = this.#bindGroups.get(passHandleId) ?? new Map();
      groups.set(event.index, {
        bindGroupId: event.bindGroupHandleId,
        dynamicOffsets: event.dynamicOffsets ?? [],
      });
      this.#bindGroups.set(passHandleId, groups);
    }
  }

  pipeline(passHandleId: string): string | undefined {
    return this.#pipeline.get(passHandleId);
  }

  bindGroups(passHandleId: string): ReadonlyMap<number, BoundBindGroup> {
    return this.#bindGroups.get(passHandleId) ?? new Map();
  }

  vertexBuffers(passHandleId: string): WorkEntry['vertexBuffers'] {
    return [...(this.#vertexBuffers.get(passHandleId)?.entries() ?? [])].map(([slot, buffer]) => ({
      slot,
      ...buffer,
    }));
  }

  indexBuffer(passHandleId: string): WorkEntry['indexBuffer'] {
    return this.#indexBuffers.get(passHandleId) ?? null;
  }
}

function workBindings(
  groups: ReadonlyMap<number, BoundBindGroup>,
  pipeline: WorkPipeline,
  handles: CreatedHandleIndex,
  tlasStates: ReadonlyMap<string, WorkAccelerationStructure>,
): WorkBinding[] {
  const bindings: WorkBinding[] = [];
  let declared: ReadonlyMap<string, BindingAccess> | undefined;
  for (const [groupIndex, { bindGroupId, dynamicOffsets }] of groups) {
    const bindGroup = handles.bindGroups.get(bindGroupId);
    const layout = handles.layoutOf(bindGroup);
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
  return bindings;
}

function workAttachments(attachment: FramePass | undefined): WorkEntry['attachments'] {
  if (attachment === undefined) return null;
  return {
    colorViewHandleIds: attachment.colorAttachmentViewHandleIds,
    colorResolveViewHandleIds: attachment.colorAttachmentResolveViewHandleIds,
    colorDepthSlices: attachment.colorAttachmentDepthSlices,
    depthStencilViewHandleId: attachment.depthStencilViewHandleId,
  };
}

function frameWorks(
  index: TapeIndex,
  events: readonly RhiCallEvent[],
  commands: readonly CommandEntry[],
  handles: CreatedHandleIndex,
  tlas: TlasStates,
  attachments: ReadonlyMap<number, FramePass>,
): WorkEntry[] {
  const works: WorkEntry[] = [];
  const state = new PassBindingState();
  const workByEventEntry = new Map(index.works.map((work) => [work.eventIndex, work]));
  for (const [eventIndex, event] of events.entries()) {
    if (event === undefined) continue;
    tlas.apply(event);
    const passHandleId = 'passHandleId' in event ? event.passHandleId : '';
    state.apply(event, passHandleId);
    if (!isWorkEvent(event.kind)) continue;
    const work = workByEventEntry.get(eventIndex);
    if (work === undefined) continue;
    const pipeline = workPipeline(state.pipeline(passHandleId), handles.pipelines, handles.shaders);
    works.push({
      ...work,
      commandIndex: commands.findIndex((command) => command.eventIndex === work.eventIndex),
      drawCall: eventDescriptor(event),
      pipeline,
      bindings: workBindings(state.bindGroups(passHandleId), pipeline, handles, tlas.states),
      vertexBuffers: state.vertexBuffers(passHandleId),
      indexBuffer: state.indexBuffer(passHandleId),
      attachments: workAttachments(attachments.get(work.passIndex)),
    });
  }
  return works;
}

function framePass(
  pass: TapePassEntry,
  attachment: FramePass | undefined,
  commandIndices: readonly number[] | undefined,
): FramePass {
  return {
    ...pass,
    endEventIndex: pass.endEventIndex ?? null,
    commandIndices: commandIndices ?? [],
    colorAttachmentViewHandleIds: attachment?.colorAttachmentViewHandleIds ?? [],
    colorAttachmentResolveViewHandleIds: attachment?.colorAttachmentResolveViewHandleIds ?? [],
    colorAttachmentDepthSlices: attachment?.colorAttachmentDepthSlices ?? [],
    depthStencilViewHandleId: attachment?.depthStencilViewHandleId ?? null,
  };
}

export function buildFrameModel(tape: V7Tape): FrameModel {
  const index = buildTapeIndex(tape);
  const events = tape.events;
  const attachments = passAttachments(index, events);
  const { commands, passCommandIndices } = frameCommands(index, events);
  const handles = new CreatedHandleIndex();
  const tlas = new TlasStates();
  const resources = frameResources(tape, handles, tlas);
  const lifecycle = buildResourceLifecycle(tape);
  applyResourceLifecycle(resources, lifecycle);
  recordConsumers(resources, index, events);
  const works = frameWorks(index, events, commands, handles, tlas, attachments);
  const passes = index.passes.map((pass) =>
    framePass(pass, attachments.get(pass.passIndex), passCommandIndices[pass.passIndex]),
  );
  return {
    unseededResources: unseededResources(tape),
    commands,
    passes,
    resources: [...resources.values()],
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
  const size = projectTextureExtent(event.desc.size);
  if (size === undefined) return { status: 'unavailable', reason: 'invalid-texture-size' };
  const layers = dimension === '1d' ? 1 : size.layerCount;
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
  const [handleId] = createdHandles(event);
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
