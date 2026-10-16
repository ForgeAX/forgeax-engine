import type { GraphBufferAccess } from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  RhiBindingResource,
  RhiComputePassEncoder,
  RhiComputePipelineOps,
  RhiDevice,
  Sampler,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { type BindGroupLayoutDescriptor, err, ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import { type RenderError, RenderFeaturePreparationFailedError } from '../errors/render';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { SceneDataTarget } from '../temporal/scene-data';
import type { RenderFeatureTargetHandle } from './targets';
import type { RenderFeatureShaderModuleMode } from './types';

/** A graph target that can be late-bound at encode time. */
export type RenderFeatureComputeTarget = string | RenderFeatureTargetHandle | SceneDataTarget;

declare const RenderFeatureGpuProgramBrand: unique symbol;
export interface RenderFeatureGpuProgramRef {
  readonly [RenderFeatureGpuProgramBrand]: void;
  readonly generation: number;
}

declare const RenderFeatureGpuBufferBrand: unique symbol;
export interface RenderFeatureGpuBufferRef {
  readonly [RenderFeatureGpuBufferBrand]: void;
  readonly name: string;
  readonly generation: number;
}

declare const RenderFeatureGpuTextureViewBrand: unique symbol;
export interface RenderFeatureGpuTextureViewRef {
  readonly [RenderFeatureGpuTextureViewBrand]: void;
  readonly name: string;
  readonly generation: number;
}

declare const RenderFeatureGpuSamplerBrand: unique symbol;
export interface RenderFeatureGpuSamplerRef {
  readonly [RenderFeatureGpuSamplerBrand]: void;
  readonly name: string;
  readonly generation: number;
}

export type RenderFeatureGpuPreparedResourceRef =
  | { readonly kind: 'buffer'; readonly reference: RenderFeatureGpuBufferRef }
  | { readonly kind: 'texture-view'; readonly reference: RenderFeatureGpuTextureViewRef }
  | { readonly kind: 'sampler'; readonly reference: RenderFeatureGpuSamplerRef };

declare const RenderFeatureGpuBindingsBrand: unique symbol;
export interface RenderFeatureGpuBindingsRef {
  readonly [RenderFeatureGpuBindingsBrand]: void;
  readonly generation: number;
}

export type RenderFeatureGpuBufferUsage =
  | 'storage'
  | 'uniform'
  | 'indirect'
  | 'vertex'
  | 'index'
  | 'copy-src';

export interface RenderFeatureGpuProgramDescriptor {
  readonly wgsl: string;
  readonly entryPoints: readonly string[];
  readonly bindings?: readonly BindGroupLayoutDescriptor[];
}

export interface RenderFeatureGpuBufferDescriptor {
  readonly size: number;
  readonly usage: readonly RenderFeatureGpuBufferUsage[];
  readonly data?: ArrayBufferView;
}

export interface RenderFeatureGpuBindingsDescriptor {
  readonly program: RenderFeatureGpuProgramRef;
  readonly entries: readonly (
    | { readonly binding: number; readonly buffer: RenderFeatureGpuBufferRef }
    | { readonly binding: number; readonly resource: RenderFeatureGpuPreparedResourceRef }
  )[];
}

export interface RenderFeatureGpuPrepare {
  retainBindings(references: readonly RenderFeatureGpuBindingsRef[]): Result<void, RenderError>;
  prepareProgram(
    name: string,
    descriptor: RenderFeatureGpuProgramDescriptor,
  ): Result<RenderFeatureGpuProgramRef, RenderError>;
  prepareBuffer(
    name: string,
    descriptor: RenderFeatureGpuBufferDescriptor,
  ): Result<RenderFeatureGpuBufferRef, RenderError>;
  /** Adopt a provider-owned resident buffer without taking destruction ownership. */
  prepareBufferResource(
    name: string,
    resource: Buffer,
    descriptor: Pick<RenderFeatureGpuBufferDescriptor, 'size' | 'usage'>,
  ): Result<RenderFeatureGpuBufferRef, RenderError>;
  prepareTextureView(
    name: string,
    resource: TextureView | undefined,
    logicalTarget?: RenderFeatureComputeTarget,
  ): Result<RenderFeatureGpuTextureViewRef, RenderError>;
  prepareSampler(name: string, resource: Sampler): Result<RenderFeatureGpuSamplerRef, RenderError>;
  prepareBindings(
    name: string,
    descriptor: RenderFeatureGpuBindingsDescriptor,
  ): Result<RenderFeatureGpuBindingsRef, RenderError>;
}

interface RenderFeatureGpuDispatchBase {
  readonly entryPoint: string;
  readonly bindings?: RenderFeatureGpuBindingsRef;
}

export type RenderFeatureGpuDispatch = RenderFeatureGpuDispatchBase &
  (
    | {
        readonly workgroups: readonly [number, number?, number?];
        readonly indirect?: never;
      }
    | {
        readonly workgroups?: never;
        readonly indirect: {
          readonly buffer: RenderFeatureGpuBufferRef;
          readonly offset: number;
        };
      }
  );

/** Direct counts are unsigned frame data; omitted Y/Z axes default to one. */
export function validRenderFeatureWorkgroups(
  workgroups: readonly (number | undefined)[],
  limit = 0xffff_ffff,
): boolean {
  if (!Array.isArray(workgroups) || workgroups.length < 1 || workgroups.length > 3) return false;
  const maximum = Math.min(limit, 0xffff_ffff);
  for (let axis = 0; axis < workgroups.length; axis += 1) {
    const count = workgroups[axis];
    if (axis !== 0 && count === undefined) continue;
    if (count === undefined || !Number.isInteger(count) || count < 0 || count > maximum)
      return false;
  }
  return true;
}

export interface RenderFeatureGpuComputePassDescriptor {
  readonly program: RenderFeatureGpuProgramRef;
  readonly bindings: RenderFeatureGpuBindingsRef;
  readonly dispatches: readonly RenderFeatureGpuDispatch[];
}

export interface RenderFeatureResolvedGpuComputePass {
  readonly sampledTargets?: readonly RenderFeatureComputeTarget[];
  readonly storageTargets?: readonly RenderFeatureComputeTarget[];
  readonly buffers: readonly {
    readonly name: string;
    readonly buffer: Buffer;
    readonly size: number;
    readonly physicalUsage: number;
    readonly access: GraphBufferAccess;
  }[];
  readonly dispatches: readonly (
    | {
        readonly pipeline: ComputePipeline;
        readonly bindGroup: BindGroup;
        readonly resolveBindGroup?: (
          resolve: (target: RenderFeatureComputeTarget) => TextureView,
        ) => BindGroup;
        readonly workgroups: readonly [number, number, number];
      }
    | {
        readonly pipeline: ComputePipeline;
        readonly bindGroup: BindGroup;
        readonly resolveBindGroup?: (
          resolve: (target: RenderFeatureComputeTarget) => TextureView,
        ) => BindGroup;
        readonly indirectBuffer: Buffer;
        readonly indirectOffset: number;
      }
  )[];
}

export interface RenderFeatureResolvedGpuBuffer {
  readonly buffer: Buffer;
  readonly size: number;
  readonly physicalUsage: number;
}

export function encodeRenderFeatureGpuComputePass(
  pass: RhiComputePassEncoder,
  work: RenderFeatureResolvedGpuComputePass,
  resolveTarget?: (target: RenderFeatureComputeTarget) => TextureView,
): void {
  for (const dispatch of work.dispatches) {
    pass.setPipeline(dispatch.pipeline);
    if (dispatch.resolveBindGroup !== undefined && resolveTarget === undefined) {
      throw new Error('Graph texture resolver required for sampled compute work');
    }
    pass.setBindGroup(
      0,
      dispatch.resolveBindGroup !== undefined && resolveTarget !== undefined
        ? dispatch.resolveBindGroup(resolveTarget)
        : dispatch.bindGroup,
    );
    if ('workgroups' in dispatch) pass.dispatchWorkgroups(...dispatch.workgroups);
    else pass.dispatchWorkgroupsIndirect(dispatch.indirectBuffer, dispatch.indirectOffset);
  }
}

export interface RenderFeatureGpuPrepareSession extends RenderFeatureGpuPrepare {
  beginFrame(): void;
  readonly changedResourceNames: ReadonlySet<string>;
  retainResources(matches: (name: string) => boolean): void;
  resolveComputePass(
    featureIdentity: string,
    descriptor: RenderFeatureGpuComputePassDescriptor,
  ): Result<RenderFeatureResolvedGpuComputePass, RenderError>;
  resolveBuffer(reference: RenderFeatureGpuBufferRef): RenderFeatureResolvedGpuBuffer | undefined;
  commitFrame(): readonly PreparedGraphicsResourceLease[];
  abortFrame(): Result<void, RenderError>;
  dispose(): Result<void, RenderError>;
}

export interface PreparedGraphicsResourceLease {
  release(): Result<void, RenderError>;
}

interface ProgramItem {
  readonly name: string;
  /** Detached descriptor used for exact warm-frame equality checks. */
  readonly descriptor: RenderFeatureGpuProgramDescriptor;
  readonly reference: RenderFeatureGpuProgramRef;
  readonly module: ShaderModule;
  readonly pipelines: ReadonlyMap<string, ComputePipeline>;
  readonly bindGroupLayout?: BindGroupLayout;
  readonly bindingLayouts: ReadonlyMap<number, GPUBufferBindingType>;
  readonly textureBindings: ReadonlyMap<
    number,
    'sampled' | 'storage-write' | 'storage-read' | 'storage-read-write'
  >;
}

interface BufferItem {
  readonly name: string;
  readonly signature: string;
  readonly reference: RenderFeatureGpuBufferRef;
  readonly buffer: Buffer;
  readonly size: number;
  readonly physicalUsage: number;
  readonly owned: boolean;
}

interface TextureViewItem {
  readonly logicalTarget?: RenderFeatureComputeTarget;
  readonly name: string;
  readonly resource: TextureView | undefined;
  readonly reference: RenderFeatureGpuTextureViewRef;
}

interface SamplerItem {
  readonly name: string;
  readonly resource: Sampler;
  readonly reference: RenderFeatureGpuSamplerRef;
}

interface BindingResourceItem {
  readonly binding: number;
  readonly resource?: RhiBindingResource;
  readonly buffer?: BufferItem;
  readonly textureView?: TextureViewItem;
  readonly sampler?: SamplerItem;
}

interface BindingsItem {
  readonly name: string;
  readonly reference: RenderFeatureGpuBindingsRef;
  readonly program: ProgramItem;
  readonly entries: readonly BindingResourceItem[];
  readonly buffers: readonly { readonly binding: number; readonly item: BufferItem }[];
  readonly bindGroup: BindGroup;
}

/**
 * VFX fixed-tick queues can briefly shrink when the host consumes one tick
 * earlier than the next one is published. Keep those named allocations warm
 * for a bounded window so a q-slot oscillation does not create/destroy a GPU
 * buffer on every frame. The parking policy is deliberately scoped to the
 * native VFX feature; generic feature resources retain the old immediate
 * retirement contract until they publish the same lifetime proof.
 */
const VFX_PARKED_RESOURCE_FRAME_LIMIT = 8;
const VFX_PARKED_RESOURCE_LIMIT = 256;
const COMPILED_PROGRAM_CACHE_LIMIT = 64;

const BUFFER_USAGE = {
  storage: 0x0080,
  uniform: 0x0040,
  indirect: 0x0100,
  vertex: 0x0020,
  index: 0x0010,
  'copy-src': 0x0004,
} as const;
const COPY_DST = 0x0008;

function alignedSize(size: number): number {
  return Math.max(4, Math.ceil(size / 4) * 4);
}

function graphAccess(type: GPUBufferBindingType): GraphBufferAccess {
  switch (type) {
    case 'uniform':
      return 'uniform-read';
    case 'read-only-storage':
      return 'storage-read';
    case 'storage':
      return 'storage-read-write';
  }
}

function bytes(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function failure(
  featureIdentity: string,
  operation: string,
  kind: string,
  name: string,
  reason: string,
): RenderFeaturePreparationFailedError {
  const recovery = reason.startsWith('rhi-not-available:') ? 'next-frame' : 'renderer-recover';
  return new RenderFeaturePreparationFailedError(
    featureIdentity,
    -1,
    operation,
    kind as never,
    name,
    reason,
    recovery,
  );
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      // Descriptor keys are canonicalized by code unit, not locale.  These
      // descriptors are generated every frame; avoiding locale collation
      // keeps the stable spelling deterministic and removes a per-call
      // ICU-backed comparator from the prepared-resource hot path.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${key}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare prepared-program declarations without reserializing the WGSL and
 * bind-group layout on every warm frame.  This is intentionally a structural
 * comparison: callers may reuse and mutate their declaration objects, so an
 * object-identity fast path would make a stale pipeline appear valid.
 */
function equalDescriptorValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    if (left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    for (let index = 0; index < leftBytes.length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) return false;
    }
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!equalDescriptorValue(left[index], right[index])) return false;
    }
    return true;
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(rightRecord, key)) return false;
      if (!equalDescriptorValue(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}

function cloneDescriptorValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((child) => cloneDescriptorValue(child)));
  }
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          cloneDescriptorValue(child),
        ]),
      ),
    );
  }
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(source);
  }
  return value;
}

function cloneProgramDescriptor(
  descriptor: RenderFeatureGpuProgramDescriptor,
): RenderFeatureGpuProgramDescriptor {
  if (isOwnedRenderFeatureProgramData(descriptor)) return descriptor;
  return cloneDescriptorValue(descriptor) as RenderFeatureGpuProgramDescriptor;
}

const ownedProgramData = new WeakSet<object>();
const ownedProgramKeys = new WeakMap<object, string>();

/** Detach cooked program data once; mutable declarations still use exact checks. */
export function ownRenderFeatureProgramData<T>(value: T): T {
  if (isOwnedRenderFeatureProgramData(value)) return value;
  const owned = cloneDescriptorValue(value) as T;
  const plainJson = (input: unknown): boolean => {
    if (input === null || input === undefined) return true;
    if (typeof input !== 'object') return ['string', 'number', 'boolean'].includes(typeof input);
    const array = Array.isArray(input),
      prototype = Object.getPrototypeOf(input);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(input).every((key) => {
      if (array && key === 'length') return true;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return (
        typeof key === 'string' &&
        descriptor?.enumerable === true &&
        'value' in descriptor &&
        plainJson(descriptor.value)
      );
    });
  };
  const immutableJson = (value: unknown): boolean => {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object') return ['string', 'number', 'boolean'].includes(typeof value);
    return Object.isFrozen(value) && Object.values(value).every(immutableJson);
  };
  if (owned !== null && typeof owned === 'object' && plainJson(value) && immutableJson(owned))
    ownedProgramData.add(owned);
  return owned;
}

export function isOwnedRenderFeatureProgramData(value: unknown): boolean {
  return value !== null && typeof value === 'object' && ownedProgramData.has(value);
}

function rhiReason(error: {
  readonly code: string;
  readonly hint: string;
  readonly detail?: unknown;
}): string {
  const detail = error.detail === undefined ? '' : `:${stable(error.detail)}`;
  return `${error.code}:${error.hint}${detail}`;
}

function createRenderFeatureGpuWorkSession(input: {
  readonly device: RhiDevice;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  readonly generation: number;
  readonly featureIdentity: string;
}): RenderFeatureGpuPrepareSession {
  const programs = new Map<string, ProgramItem>();
  // Program code/layout belongs to the device session; playback names own
  // separate references and buffers. Bound retention across idle generations.
  const compiledPrograms = new Map<string, ProgramItem>();
  const parkedPrograms = new Map<string, { readonly item: ProgramItem; readonly frame: number }>();
  const programRefs = new Map<object, ProgramItem>();
  const buffers = new Map<string, BufferItem>();
  const parkedBuffers = new Map<string, { readonly item: BufferItem; readonly frame: number }>();
  const bufferRefs = new Map<object, BufferItem>();
  const textureViews = new Map<string, TextureViewItem>();
  const textureViewRefs = new Map<object, TextureViewItem>();
  const samplers = new Map<string, SamplerItem>();
  const samplerRefs = new Map<object, SamplerItem>();
  const bindings = new Map<string, BindingsItem>();
  const parkedBindings = new Map<string, { readonly item: BindingsItem; readonly frame: number }>();
  const bindingRefs = new Map<object, BindingsItem>();
  const touchedPrograms = new Set<ProgramItem>();
  const touchedBuffers = new Set<BufferItem>();
  const touchedTextureViews = new Set<TextureViewItem>();
  const touchedSamplers = new Set<SamplerItem>();
  const touchedBindings = new Set<BindingsItem>();
  const parksUntouched = input.featureIdentity === 'forgeax.vfx-render.gpu-particles';
  let frameSerial = 0;

  const retiring = new Map<object, object>();
  const changedResourceNames = new Set<string>();
  const destroyedBuffers = new WeakSet<Buffer>();
  // Resource refs are freshly allocated opaque objects. Rollback needs only
  // this frame's additions; accepted index keys never need copying.
  const snapshotIndexes = () => ({
    programs: new Map(programs),
    buffers: new Map(buffers),
    bindings: new Map(bindings),
    textureViews: new Map(textureViews),
    samplers: new Map(samplers),
    parkedPrograms: new Map(parkedPrograms),
    parkedBuffers: new Map(parkedBuffers),
    parkedBindings: new Map(parkedBindings),
    addedProgramRefs: [] as object[],
    addedBufferRefs: [] as object[],
    addedBindingRefs: [] as object[],
    addedTextureViewRefs: [] as object[],
    addedSamplerRefs: [] as object[],
  });
  let candidate: ReturnType<typeof snapshotIndexes> | undefined;
  const restore = <K, V>(target: Map<K, V>, saved: ReadonlyMap<K, V>): void => {
    target.clear();
    for (const [key, value] of saved) target.set(key, value);
  };
  const destroyBuffers = (items: Iterable<BufferItem>): Result<void, RenderError> => {
    let first: RenderError | undefined;
    for (const item of items) {
      if (!item.owned || destroyedBuffers.has(item.buffer)) continue;
      destroyedBuffers.add(item.buffer);
      const result = input.device.destroyBuffer(item.buffer);
      if (!result.ok && first === undefined)
        first = failure(
          input.featureIdentity,
          'retire-gpu-buffer',
          'vertex-data',
          item.name,
          result.error.code,
        );
    }
    return first === undefined ? ok(undefined) : err(first);
  };
  const abortFrame = (): Result<void, RenderError> => {
    const previous = candidate;
    if (previous === undefined) return ok(undefined);
    candidate = undefined;
    const createdBuffers: BufferItem[] = [];
    for (const reference of previous.addedBufferRefs) {
      const item = bufferRefs.get(reference);
      if (item !== undefined) createdBuffers.push(item);
    }
    const discard = <T>(index: Map<object, T>, references: readonly object[]): void => {
      for (const reference of references) index.delete(reference);
    };
    restore(programs, previous.programs);
    restore(buffers, previous.buffers);
    restore(bindings, previous.bindings);
    restore(textureViews, previous.textureViews);
    restore(samplers, previous.samplers);
    restore(parkedPrograms, previous.parkedPrograms);
    restore(parkedBuffers, previous.parkedBuffers);
    restore(parkedBindings, previous.parkedBindings);
    discard(programRefs, previous.addedProgramRefs);
    discard(bufferRefs, previous.addedBufferRefs);
    discard(bindingRefs, previous.addedBindingRefs);
    discard(textureViewRefs, previous.addedTextureViewRefs);
    discard(samplerRefs, previous.addedSamplerRefs);
    return destroyBuffers(createdBuffers);
  };

  // A parked bind group must not retain a borrowed view, sampler, or buffer
  // whose producer may replace the underlying handle while this feature is
  // dormant. Owned buffers are generation-local and can safely be revived.
  const canParkBinding = (item: BindingsItem): boolean =>
    item.entries.every(
      (entry) =>
        entry.textureView === undefined &&
        entry.sampler === undefined &&
        (entry.buffer === undefined || entry.buffer.owned),
    );

  const activateProgram = (item: ProgramItem): void => {
    const current = programs.get(item.name);
    if (current === undefined || current === item) {
      parkedPrograms.delete(item.name);
      programs.set(item.name, item);
    }
  };
  const activateBuffer = (item: BufferItem): void => {
    const current = buffers.get(item.name);
    if (current === undefined || current === item) {
      parkedBuffers.delete(item.name);
      buffers.set(item.name, item);
    }
  };
  const activateBindings = (item: BindingsItem): void => {
    const current = bindings.get(item.name);
    if (current === undefined || current === item) {
      parkedBindings.delete(item.name);
      bindings.set(item.name, item);
    }
    activateProgram(item.program);
    for (const entry of item.buffers) activateBuffer(entry.item);
  };

  const touchProgram = (item: ProgramItem): void => {
    retiring.delete(item.reference);
    touchedPrograms.add(item);
  };
  const touchBuffer = (item: BufferItem): void => {
    retiring.delete(item.reference);
    touchedBuffers.add(item);
  };
  const touchTextureView = (item: TextureViewItem): void => {
    retiring.delete(item.reference);
    touchedTextureViews.add(item);
  };
  const touchSampler = (item: SamplerItem): void => {
    retiring.delete(item.reference);
    touchedSamplers.add(item);
  };
  const touchBindings = (item: BindingsItem): void => {
    retiring.delete(item.reference);
    touchedBindings.add(item);
    touchProgram(item.program);
    for (const entry of item.entries) {
      if (entry.buffer !== undefined) touchBuffer(entry.buffer);
      if (entry.textureView !== undefined) touchTextureView(entry.textureView);
      if (entry.sampler !== undefined) touchSampler(entry.sampler);
    }
  };

  const prepareProgram: RenderFeatureGpuPrepare['prepareProgram'] = (name, descriptor) => {
    const prior = programs.get(name) ?? parkedPrograms.get(name)?.item;
    if (prior !== undefined && equalDescriptorValue(prior.descriptor, descriptor)) {
      activateProgram(prior);
      touchProgram(prior);
      return ok(prior.reference);
    }
    if (name.length === 0 || descriptor.wgsl.length === 0 || descriptor.entryPoints.length === 0) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-program',
          'pipeline',
          name,
          'descriptor-invalid',
        ),
      );
    }
    let programKey = isOwnedRenderFeatureProgramData(descriptor)
      ? ownedProgramKeys.get(descriptor)
      : undefined;
    if (programKey === undefined) {
      programKey = stable(descriptor);
      if (isOwnedRenderFeatureProgramData(descriptor)) ownedProgramKeys.set(descriptor, programKey);
    }
    const compiled = compiledPrograms.get(programKey);
    if (compiled !== undefined) {
      compiledPrograms.delete(programKey);
      compiledPrograms.set(programKey, compiled);
      const item = {
        ...compiled,
        name,
        reference: Object.freeze({ generation: input.generation }) as RenderFeatureGpuProgramRef,
      };
      parkedPrograms.delete(name);
      programs.set(name, item);
      changedResourceNames.add(name);
      programRefs.set(item.reference, item);
      candidate?.addedProgramRefs.push(item.reference);
      touchProgram(item);
      return ok(item.reference);
    }
    const module = input.shaderModuleFactory.createShaderModule({
      label: name,
      code: descriptor.wgsl,
    });
    if (!module.ok) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-program',
          'pipeline',
          name,
          rhiReason(module.error),
        ),
      );
    }
    let bindGroupLayout: BindGroupLayout | undefined;
    let pipelineLayout: 'auto' | PipelineLayout = 'auto';
    if (descriptor.bindings !== undefined) {
      if (descriptor.bindings.length !== 1) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            'one-bind-group-required',
          ),
        );
      }
      const reflected = descriptor.bindings[0];
      if (reflected === undefined) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            'one-bind-group-required',
          ),
        );
      }
      const storageCount = reflected.entries.filter(
        (entry) =>
          (entry.visibility & 4) !== 0 &&
          (entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage'),
      ).length;
      const storageLimit = input.device.limits.maxStorageBuffersPerShaderStage;
      if (storageCount > storageLimit) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            `storage-buffer-binding-limit:${storageCount}>${storageLimit}`,
          ),
        );
      }
      const createdLayout = input.device.createBindGroupLayout({
        ...(reflected.label === undefined ? {} : { label: reflected.label }),
        entries: reflected.entries.map((entry) => ({
          binding: entry.binding,
          visibility: entry.visibility,
          ...(entry.buffer === undefined ? {} : { buffer: entry.buffer }),
          ...(entry.sampler === undefined ? {} : { sampler: entry.sampler }),
          ...(entry.texture === undefined ? {} : { texture: entry.texture }),
          ...(entry.storageTexture === undefined ? {} : { storageTexture: entry.storageTexture }),
        })),
      });
      if (!createdLayout.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            createdLayout.error.code,
          ),
        );
      }
      bindGroupLayout = createdLayout.value;
      const createdPipelineLayout = input.device.createPipelineLayout({
        label: `${name}.layout`,
        bindGroupLayouts: [bindGroupLayout],
      });
      if (!createdPipelineLayout.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            createdPipelineLayout.error.code,
          ),
        );
      }
      pipelineLayout = createdPipelineLayout.value;
    }
    const pipelineMap = new Map<string, ComputePipeline>();
    for (const entryPoint of descriptor.entryPoints) {
      const pipeline = input.device.createComputePipeline({
        label: `${name}.${entryPoint}`,
        layout: pipelineLayout,
        compute: { module: module.value, entryPoint },
      });
      if (!pipeline.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-program',
            'pipeline',
            name,
            pipeline.error.code,
          ),
        );
      }
      pipelineMap.set(entryPoint, pipeline.value);
    }
    const reference = Object.freeze({ generation: input.generation }) as RenderFeatureGpuProgramRef;
    const textureBindings = new Map<
      number,
      'sampled' | 'storage-write' | 'storage-read' | 'storage-read-write'
    >();
    for (const entry of descriptor.bindings?.[0]?.entries ?? []) {
      if (entry.texture !== undefined) {
        textureBindings.set(entry.binding, 'sampled');
      } else if (entry.storageTexture !== undefined) {
        textureBindings.set(
          entry.binding,
          entry.storageTexture.access === 'write-only'
            ? 'storage-write'
            : entry.storageTexture.access === 'read-only'
              ? 'storage-read'
              : 'storage-read-write',
        );
      }
    }
    const item = {
      name,
      descriptor: cloneProgramDescriptor(descriptor),
      reference,
      module: module.value,
      pipelines: pipelineMap,
      bindingLayouts: new Map(
        (descriptor.bindings?.[0]?.entries ?? []).flatMap((entry) =>
          entry.buffer === undefined
            ? []
            : [[entry.binding, entry.buffer.type ?? 'uniform'] as const],
        ),
      ),
      textureBindings,
      ...(bindGroupLayout === undefined ? {} : { bindGroupLayout }),
    };
    parkedPrograms.delete(name);
    programs.set(name, item);
    changedResourceNames.add(name);
    programRefs.set(reference, item);
    candidate?.addedProgramRefs.push(reference);
    compiledPrograms.set(programKey, item);
    if (compiledPrograms.size > COMPILED_PROGRAM_CACHE_LIMIT) {
      const oldest = compiledPrograms.keys().next().value;
      if (oldest !== undefined) compiledPrograms.delete(oldest);
    }
    touchProgram(item);
    return ok(reference);
  };

  const prepareBuffer: RenderFeatureGpuPrepare['prepareBuffer'] = (name, descriptor) => {
    if (
      !Number.isInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      descriptor.usage.length === 0
    ) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-buffer',
          'vertex-data',
          name,
          'descriptor-invalid',
        ),
      );
    }
    const signature = stable({ size: descriptor.size, usage: [...descriptor.usage].sort() });
    let item = buffers.get(name) ?? parkedBuffers.get(name)?.item;
    if (item !== undefined && (item.signature !== signature || !item.owned)) item = undefined;
    if (item === undefined) {
      const usage = descriptor.usage.reduce((bits, key) => bits | BUFFER_USAGE[key], COPY_DST);
      const created = input.device.createBuffer({
        label: name,
        size: alignedSize(descriptor.size),
        usage,
      });
      if (!created.ok) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-buffer',
            'vertex-data',
            name,
            created.error.code,
          ),
        );
      }
      const reference = Object.freeze({
        name,
        generation: input.generation,
      }) as RenderFeatureGpuBufferRef;
      item = {
        name,
        signature,
        reference,
        buffer: created.value,
        size: alignedSize(descriptor.size),
        physicalUsage: usage,
        owned: true,
      };
      parkedBuffers.delete(name);
      buffers.set(name, item);
      changedResourceNames.add(name);
      bufferRefs.set(reference, item);
      candidate?.addedBufferRefs.push(reference);
    }
    activateBuffer(item);
    touchBuffer(item);
    if (descriptor.data !== undefined) {
      if (descriptor.data.byteLength > descriptor.size) {
        return err(
          failure(
            input.featureIdentity,
            'write-gpu-buffer',
            'vertex-data',
            name,
            'data-exceeds-size',
          ),
        );
      }
      const written = input.device.queue.writeBuffer(item.buffer, 0, bytes(descriptor.data));
      if (!written.ok) {
        return err(
          failure(
            input.featureIdentity,
            'write-gpu-buffer',
            'vertex-data',
            name,
            written.error.code,
          ),
        );
      }
    }
    return ok(item.reference);
  };

  const prepareBufferResource: RenderFeatureGpuPrepare['prepareBufferResource'] = (
    name,
    resource,
    descriptor,
  ) => {
    if (
      name.length === 0 ||
      !Number.isInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      descriptor.usage.length === 0
    ) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-buffer-resource',
          'uniform-data',
          name,
          'descriptor-invalid',
        ),
      );
    }
    const size = alignedSize(descriptor.size);
    const usage = descriptor.usage.reduce((bits, key) => bits | BUFFER_USAGE[key], COPY_DST);
    const prior = buffers.get(name);
    if (
      prior !== undefined &&
      prior.buffer === resource &&
      prior.size === size &&
      prior.physicalUsage === usage &&
      !prior.owned
    ) {
      touchBuffer(prior);
      return ok(prior.reference);
    }
    const reference = Object.freeze({
      name,
      generation: input.generation,
    }) as RenderFeatureGpuBufferRef;
    const item: BufferItem = {
      name,
      signature: stable({ external: true, size, usage: [...descriptor.usage].sort() }),
      reference,
      buffer: resource,
      size,
      physicalUsage: usage,
      owned: false,
    };
    parkedBuffers.delete(name);
    buffers.set(name, item);
    changedResourceNames.add(name);
    bufferRefs.set(reference, item);
    candidate?.addedBufferRefs.push(reference);
    touchBuffer(item);
    return ok(reference);
  };

  const prepareTextureView: RenderFeatureGpuPrepare['prepareTextureView'] = (
    name,
    resource,
    logicalTarget,
  ) => {
    if (name.length === 0) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-texture-view',
          'texture-view',
          name,
          'descriptor-invalid',
        ),
      );
    }
    const prior = textureViews.get(name);
    if (
      prior !== undefined &&
      prior.resource === resource &&
      stable(prior.logicalTarget) === stable(logicalTarget)
    ) {
      touchTextureView(prior);
      return ok(prior.reference);
    }
    const reference = Object.freeze({
      name,
      generation: input.generation,
    }) as RenderFeatureGpuTextureViewRef;
    const item = {
      name,
      resource,
      reference,
      ...(logicalTarget === undefined ? {} : { logicalTarget }),
    };
    textureViews.set(name, item);
    changedResourceNames.add(name);
    textureViewRefs.set(reference, item);
    candidate?.addedTextureViewRefs.push(reference);
    touchTextureView(item);
    return ok(reference);
  };

  const prepareSampler: RenderFeatureGpuPrepare['prepareSampler'] = (name, resource) => {
    if (name.length === 0) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-sampler',
          'sampler',
          name,
          'descriptor-invalid',
        ),
      );
    }
    const prior = samplers.get(name);
    if (prior !== undefined && prior.resource === resource) {
      touchSampler(prior);
      return ok(prior.reference);
    }
    const reference = Object.freeze({
      name,
      generation: input.generation,
    }) as RenderFeatureGpuSamplerRef;
    const item = { name, resource, reference };
    samplers.set(name, item);
    changedResourceNames.add(name);
    samplerRefs.set(reference, item);
    candidate?.addedSamplerRefs.push(reference);
    touchSampler(item);
    return ok(reference);
  };

  const prepareBindings: RenderFeatureGpuPrepare['prepareBindings'] = (name, descriptor) => {
    const program = programRefs.get(descriptor.program as object);
    if (program === undefined || descriptor.program.generation !== input.generation) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          'program-unavailable',
        ),
      );
    }
    const entryItems: BindingResourceItem[] = [];
    for (const entry of descriptor.entries) {
      if ('buffer' in entry) {
        const item = bufferRefs.get(entry.buffer as object);
        if (item === undefined || entry.buffer.generation !== input.generation) {
          return err(
            failure(
              input.featureIdentity,
              'prepare-gpu-bindings',
              'bindings',
              name,
              'buffer-unavailable',
            ),
          );
        }
        entryItems.push({
          binding: entry.binding,
          resource: { kind: 'buffer', value: { buffer: item.buffer } },
          buffer: item,
        });
        continue;
      }
      const prepared = entry.resource;
      if (prepared.reference.generation !== input.generation) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-bindings',
            'bindings',
            name,
            'resource-generation-mismatch',
          ),
        );
      }
      if (prepared.kind === 'buffer') {
        const item = bufferRefs.get(prepared.reference as object);
        if (item === undefined) {
          return err(
            failure(
              input.featureIdentity,
              'prepare-gpu-bindings',
              'bindings',
              name,
              'buffer-unavailable',
            ),
          );
        }
        entryItems.push({
          binding: entry.binding,
          resource: { kind: 'buffer', value: { buffer: item.buffer } },
          buffer: item,
        });
        continue;
      }
      if (prepared.kind === 'texture-view') {
        const item = textureViewRefs.get(prepared.reference as object);
        if (item === undefined) {
          return err(
            failure(
              input.featureIdentity,
              'prepare-gpu-bindings',
              'bindings',
              name,
              'texture-view-unavailable',
            ),
          );
        }
        entryItems.push({
          binding: entry.binding,
          ...(item.resource === undefined
            ? {}
            : { resource: { kind: 'textureView' as const, value: item.resource } }),
          textureView: item,
        });
        continue;
      }
      const item = samplerRefs.get(prepared.reference as object);
      if (item === undefined) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-bindings',
            'bindings',
            name,
            'sampler-unavailable',
          ),
        );
      }
      entryItems.push({
        binding: entry.binding,
        resource: { kind: 'sampler', value: item.resource },
        sampler: item,
      });
    }
    const prior = bindings.get(name) ?? parkedBindings.get(name)?.item;
    if (
      prior !== undefined &&
      prior.program === program &&
      prior.entries.length === entryItems.length &&
      prior.entries.every((entry, index) => {
        const next = entryItems[index];
        return (
          next !== undefined &&
          entry.binding === next.binding &&
          entry.buffer === next.buffer &&
          entry.textureView === next.textureView &&
          entry.sampler === next.sampler
        );
      })
    ) {
      activateBindings(prior);
      touchBindings(prior);
      return ok(prior.reference);
    }
    const firstPipeline = program.pipelines.values().next().value as
      | (ComputePipeline & RhiComputePipelineOps)
      | undefined;
    const layout = program.bindGroupLayout ?? firstPipeline?.getBindGroupLayout(0);
    if (layout === undefined) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          'layout-unavailable',
        ),
      );
    }
    const hasLateTextures = entryItems.some(
      (entry) => entry.textureView?.logicalTarget !== undefined,
    );
    const hasMissingResource = entryItems.some((entry) => entry.resource === undefined);
    if (hasMissingResource && !hasLateTextures) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          'texture-view-unavailable',
        ),
      );
    }
    const created = hasLateTextures
      ? undefined
      : input.device.createBindGroup({
          label: name,
          layout,
          entries: entryItems.map((entry) => ({
            binding: entry.binding,
            resource: entry.resource as RhiBindingResource,
          })),
        });
    if (created !== undefined && !created.ok) {
      return err(
        failure(
          input.featureIdentity,
          'prepare-gpu-bindings',
          'bindings',
          name,
          created.error.code,
        ),
      );
    }
    const reference = Object.freeze({
      generation: input.generation,
    }) as RenderFeatureGpuBindingsRef;
    const item = {
      name,
      reference,
      program,
      entries: entryItems,
      buffers: entryItems.flatMap((entry) =>
        entry.buffer === undefined ? [] : [{ binding: entry.binding, item: entry.buffer }],
      ),
      // A bind group with semantic targets is created once the graph resolves
      // the current generation's physical views. The placeholder is never
      // encoded because resolveComputePass installs resolveBindGroup.
      bindGroup: created?.value as BindGroup,
    };
    parkedBindings.delete(name);
    bindings.set(name, item);
    changedResourceNames.add(name);
    bindingRefs.set(reference, item);
    candidate?.addedBindingRefs.push(reference);
    touchBindings(item);
    return ok(reference);
  };

  return {
    changedResourceNames,
    beginFrame: () => {
      if (candidate !== undefined)
        throw new Error('Feature GPU frame must commit or abort before beginning another frame');
      candidate = snapshotIndexes();
      changedResourceNames.clear();
      touchedPrograms.clear();
      touchedBuffers.clear();
      touchedTextureViews.clear();
      touchedSamplers.clear();
      touchedBindings.clear();
    },
    retainResources: (matches) => {
      for (const item of programs.values()) if (matches(item.name)) touchProgram(item);
      for (const item of buffers.values()) if (matches(item.name)) touchBuffer(item);
      for (const item of textureViews.values()) if (matches(item.name)) touchTextureView(item);
      for (const item of samplers.values()) if (matches(item.name)) touchSampler(item);
      for (const item of bindings.values()) if (matches(item.name)) touchBindings(item);
    },
    retainBindings: (references) => {
      for (const reference of references) {
        const item = bindingRefs.get(reference as object);
        if (item === undefined || reference.generation !== input.generation) {
          return err(
            failure(
              input.featureIdentity,
              'retain-gpu-bindings',
              'bindings',
              'persistent-bindings',
              'bindings-unavailable',
            ),
          );
        }
        activateBindings(item);
        touchBindings(item);
      }
      return ok(undefined);
    },
    prepareProgram,
    prepareBuffer,
    prepareBufferResource,
    prepareTextureView,
    prepareSampler,
    prepareBindings,
    resolveComputePass: (featureIdentity, descriptor) => {
      const program = programRefs.get(descriptor.program as object);
      const binding = bindingRefs.get(descriptor.bindings as object);
      const dispatchBindings = descriptor.dispatches.map((dispatch) =>
        dispatch.bindings === undefined ? binding : bindingRefs.get(dispatch.bindings as object),
      );
      if (
        program === undefined ||
        binding === undefined ||
        binding.program !== program ||
        dispatchBindings.some((item) => item === undefined) ||
        dispatchBindings.some((item) => item?.program !== program) ||
        descriptor.program.generation !== input.generation ||
        descriptor.bindings.generation !== input.generation
      ) {
        const reason =
          program === undefined
            ? 'program-unavailable'
            : binding === undefined
              ? 'bindings-unavailable'
              : binding.program !== program
                ? 'bindings-program-mismatch'
                : dispatchBindings.some((item) => item === undefined)
                  ? 'dispatch-bindings-unavailable'
                  : dispatchBindings.some((item) => item?.program !== program)
                    ? 'dispatch-bindings-program-mismatch'
                    : 'generation-mismatch';
        return err(
          failure(
            featureIdentity,
            'resolve-gpu-compute',
            'bindings',
            program?.name ?? 'program',
            reason,
          ),
        );
      }
      touchProgram(program);
      touchBindings(binding);
      for (const dispatchBinding of dispatchBindings) {
        if (dispatchBinding !== undefined) touchBindings(dispatchBinding);
      }
      const indirectItems = descriptor.dispatches.map((dispatch) =>
        dispatch.indirect === undefined
          ? undefined
          : bufferRefs.get(dispatch.indirect.buffer as object),
      );
      for (const [index, dispatch] of descriptor.dispatches.entries()) {
        const indirectItem = indirectItems[index];
        const invalidDirect =
          dispatch.workgroups !== undefined &&
          !validRenderFeatureWorkgroups(
            dispatch.workgroups,
            input.device.limits.maxComputeWorkgroupsPerDimension,
          );
        const invalidIndirect =
          dispatch.indirect !== undefined &&
          (indirectItem === undefined ||
            dispatch.indirect.buffer.generation !== input.generation ||
            (indirectItem.physicalUsage & BUFFER_USAGE.indirect) === 0 ||
            !Number.isInteger(dispatch.indirect.offset) ||
            dispatch.indirect.offset < 0 ||
            dispatch.indirect.offset % 4 !== 0 ||
            dispatch.indirect.offset + 12 > indirectItem.size);
        if (
          program.pipelines.get(dispatch.entryPoint) === undefined ||
          invalidDirect ||
          invalidIndirect
        ) {
          return err(
            failure(
              featureIdentity,
              'resolve-gpu-compute',
              'pipeline',
              dispatch.entryPoint,
              !program.pipelines.has(dispatch.entryPoint)
                ? 'entry-point-unavailable'
                : invalidDirect
                  ? 'workgroup-count-invalid'
                  : 'indirect-dispatch-invalid',
            ),
          );
        }
        if (indirectItem !== undefined) touchBuffer(indirectItem);
      }
      const resolvedDispatches: RenderFeatureResolvedGpuComputePass['dispatches'][number][] = [];
      let emptyDispatches = 0;
      for (const [index, dispatch] of descriptor.dispatches.entries()) {
        const pipeline = program.pipelines.get(dispatch.entryPoint);
        const dispatchBinding = dispatchBindings[index];
        if (pipeline === undefined || dispatchBinding === undefined) continue;
        // Validate the complete declaration above, then omit empty commands.
        // Bindings still contribute every resource/access below, preserving
        // graph topology and lifetime when a later frame becomes nonempty.
        if (dispatch.workgroups?.includes(0)) {
          emptyDispatches += 1;
          continue;
        }
        const lateBindings = dispatchBinding.entries.some(
          (entry) => entry.textureView?.logicalTarget !== undefined,
        )
          ? {
              resolveBindGroup: (resolve: (target: RenderFeatureComputeTarget) => TextureView) => {
                const layout =
                  program.bindGroupLayout ??
                  (pipeline as ComputePipeline & RhiComputePipelineOps).getBindGroupLayout(0);
                const created = input.device.createBindGroup({
                  label: dispatchBinding.name,
                  layout,
                  entries: dispatchBinding.entries.map((entry) => ({
                    binding: entry.binding,
                    resource:
                      entry.textureView?.logicalTarget === undefined
                        ? (entry.resource as RhiBindingResource)
                        : {
                            kind: 'textureView' as const,
                            value: resolve(entry.textureView.logicalTarget),
                          },
                  })),
                });
                if (!created.ok) throw created.error;
                return created.value;
              },
            }
          : {};

        if (dispatch.workgroups !== undefined) {
          resolvedDispatches.push({
            pipeline,
            bindGroup: dispatchBinding.bindGroup,
            ...lateBindings,
            workgroups: [
              dispatch.workgroups[0],
              dispatch.workgroups[1] ?? 1,
              dispatch.workgroups[2] ?? 1,
            ],
          });
          continue;
        }
        const indirectItem = indirectItems[index];
        if (indirectItem === undefined) continue;
        resolvedDispatches.push({
          pipeline,
          bindGroup: dispatchBinding.bindGroup,
          ...lateBindings,
          indirectBuffer: indirectItem.buffer,
          indirectOffset: dispatch.indirect.offset,
        });
      }
      if (resolvedDispatches.length + emptyDispatches !== descriptor.dispatches.length) {
        return err(
          failure(
            featureIdentity,
            'resolve-gpu-compute',
            'bindings',
            program.name,
            'resolved-resource-unavailable',
          ),
        );
      }
      const resolvedBuffers = new Map<BufferItem, Set<GraphBufferAccess>>();
      for (const item of dispatchBindings) {
        if (item === undefined) continue;
        for (const entry of item.buffers) {
          const access = program.bindingLayouts.get(entry.binding);
          if (access === undefined) {
            return err(
              failure(
                featureIdentity,
                'resolve-gpu-compute',
                'bindings',
                item.name,
                `buffer-layout-unavailable:${entry.binding}`,
              ),
            );
          }
          const derived = graphAccess(access);
          const prior = resolvedBuffers.get(entry.item) ?? new Set<GraphBufferAccess>();
          if (prior.size > 0 && !prior.has(derived)) {
            if (prior.has('storage-read-write') || derived === 'storage-read-write') {
              resolvedBuffers.set(entry.item, new Set(['storage-read-write']));
              continue;
            }
            return err(
              failure(
                featureIdentity,
                'resolve-gpu-compute',
                'bindings',
                item.name,
                `buffer-access-conflict:${entry.binding}`,
              ),
            );
          }
          prior.add(derived);
          resolvedBuffers.set(entry.item, prior);
        }
      }
      for (const item of indirectItems) {
        if (item === undefined) continue;
        const accesses = resolvedBuffers.get(item) ?? new Set<GraphBufferAccess>();
        accesses.add('indirect-read');
        resolvedBuffers.set(item, accesses);
      }
      const sampledTargets = new Set<RenderFeatureComputeTarget>();
      const storageTargets = new Set<RenderFeatureComputeTarget>();
      for (const item of dispatchBindings) {
        for (const entry of item?.entries ?? []) {
          const target = entry.textureView?.logicalTarget;
          if (target === undefined) continue;
          const role = program.textureBindings.get(entry.binding) ?? 'sampled';
          if (role === 'sampled') sampledTargets.add(target);
          else storageTargets.add(target);
        }
      }
      return ok({
        sampledTargets: [...sampledTargets],
        storageTargets: [...storageTargets],
        buffers: [...resolvedBuffers].flatMap(([item, accesses]) =>
          [...accesses].map((access) => ({
            name: item.name,
            buffer: item.buffer,
            size: item.size,
            physicalUsage: item.physicalUsage,
            access,
          })),
        ),
        dispatches: resolvedDispatches,
      });
    },
    resolveBuffer: (reference) => {
      const item = bufferRefs.get(reference as object);
      if (item !== undefined) {
        activateBuffer(item);
        touchBuffer(item);
      }
      return item === undefined
        ? undefined
        : { buffer: item.buffer, size: item.size, physicalUsage: item.physicalUsage };
    },
    abortFrame,
    commitFrame: () => {
      if (candidate === undefined) return [];
      candidate = undefined;
      frameSerial += 1;
      const park = <T extends { readonly name: string }>(
        active: Map<string, T>,
        parked: Map<string, { readonly item: T; readonly frame: number }>,
        touched: ReadonlySet<T>,
        canPark: (item: T) => boolean,
      ): void => {
        for (const [name, item] of active) {
          if (touched.has(item)) continue;
          active.delete(name);
          if (parksUntouched && canPark(item)) parked.set(name, { item, frame: frameSerial });
        }
      };
      park(bindings, parkedBindings, touchedBindings, canParkBinding);
      park(programs, parkedPrograms, touchedPrograms, () => true);
      park(buffers, parkedBuffers, touchedBuffers, (item) => item.owned);
      for (const [name, item] of textureViews)
        if (!touchedTextureViews.has(item)) textureViews.delete(name);
      for (const [name, item] of samplers) if (!touchedSamplers.has(item)) samplers.delete(name);
      const evict = <T>(
        parked: Map<string, { readonly item: T; readonly frame: number }>,
        removeDependencies: (item: T) => void,
      ): void => {
        for (const [name, entry] of parked) {
          if (
            entry.frame > frameSerial - VFX_PARKED_RESOURCE_FRAME_LIMIT &&
            parked.size <= VFX_PARKED_RESOURCE_LIMIT
          )
            break;
          parked.delete(name);
          removeDependencies(entry.item);
        }
      };
      evict(parkedBuffers, (item) => {
        for (const [name, entry] of parkedBindings)
          if (entry.item.buffers.some((buffer) => buffer.item === item))
            parkedBindings.delete(name);
      });
      evict(parkedPrograms, (item) => {
        for (const [name, entry] of parkedBindings)
          if (entry.item.program === item) parkedBindings.delete(name);
      });
      evict(parkedBindings, () => {});
      // References used by a retained graph remain resolvable until its queue fence.
      // Touching an old dependency preserves it without replacing a newer named descriptor.
      const active = <T>(
        named: ReadonlyMap<string, T>,
        parked: ReadonlyMap<string, { readonly item: T }>,
        touched: ReadonlySet<T>,
      ) =>
        new Set([
          ...named.values(),
          ...[...parked.values()].map((entry) => entry.item),
          ...touched,
        ]);
      const releases: (() => BufferItem | undefined)[] = [];
      const retire = <T extends { readonly reference: object }>(
        index: Map<object, T>,
        live: ReadonlySet<T>,
        buffer?: (item: T) => BufferItem,
      ): void => {
        for (const [reference, item] of index) {
          if (live.has(item) || retiring.has(reference)) continue;
          const ticket = {};
          retiring.set(reference, ticket);
          releases.push(() => {
            if (retiring.get(reference) !== ticket) return undefined;
            index.delete(reference);
            retiring.delete(reference);
            return buffer?.(item);
          });
        }
      };
      retire(programRefs, active(programs, parkedPrograms, touchedPrograms));
      retire(bufferRefs, active(buffers, parkedBuffers, touchedBuffers), (item) => item);
      retire(bindingRefs, active(bindings, parkedBindings, touchedBindings));
      retire(textureViewRefs, new Set([...textureViews.values(), ...touchedTextureViews]));
      retire(samplerRefs, new Set([...samplers.values(), ...touchedSamplers]));
      if (releases.length === 0) return [];
      let released = false;
      return [
        {
          release: () => {
            if (released) return ok(undefined);
            released = true;
            const retiredBuffers: BufferItem[] = [];
            for (const release of releases) {
              const item = release();
              if (item !== undefined) retiredBuffers.push(item);
            }
            return destroyBuffers(retiredBuffers);
          },
        },
      ];
    },
    dispose: () => {
      candidate = undefined;
      const destroyed = destroyBuffers(bufferRefs.values());
      programs.clear();
      parkedPrograms.clear();
      compiledPrograms.clear();
      buffers.clear();
      parkedBuffers.clear();
      bindings.clear();
      parkedBindings.clear();
      textureViews.clear();
      textureViewRefs.clear();
      samplers.clear();
      samplerRefs.clear();
      bufferRefs.clear();
      programRefs.clear();
      bindingRefs.clear();
      retiring.clear();
      return destroyed;
    },
  };
}

/**
 * RenderSystem's one owner for persistent feature GPU work.
 *
 * Sessions remain private to this module. The host asks for a session for the
 * current feature and generation, while this owner is the only place that
 * retains the per-feature prepared GPU state and recreates it after recovery.
 */
export interface RenderFeatureGpuWorkOwner {
  /** Candidate root carries this detached GPU-work owner itself. */
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
  beginFeature(
    featureIdentity: string,
    generation: number,
    shaderModuleMode?: RenderFeatureShaderModuleMode,
  ): RenderFeatureGpuPrepareSession;
  resolveBuffer(
    featureIdentity: string,
    reference: RenderFeatureGpuBufferRef,
  ): RenderFeatureResolvedGpuBuffer | undefined;
  dispose(): Result<void, RenderError>;
}

export function createRenderFeatureGpuWorkOwner(input: {
  readonly getDevice: () => RhiDevice;
  readonly getShaderModuleFactory: () => PipelineBuilderShaderModuleFactory;
  readonly getImmediateShaderModuleFactory?: () => PipelineBuilderShaderModuleFactory;
}): RenderFeatureGpuWorkOwner {
  const sessions = new Map<
    string,
    {
      generation: number;
      shaderModuleMode: RenderFeatureShaderModuleMode;
      session: RenderFeatureGpuPrepareSession;
    }
  >();
  let disposed = false;

  const owner: RenderFeatureGpuWorkOwner = {
    createRecoveryRoot: (scope) => ({
      kind: 'feature',
      create: () => {
        if (!scope.isAlive()) throw new Error('Feature GPU candidate scope is not active.');
        return owner;
      },
      cleanup: () => undefined,
    }),
    beginFeature: (featureIdentity, generation, requestedShaderModuleMode = 'validated') => {
      if (disposed) {
        throw new Error('Render feature GPU work owner is disposed.');
      }
      const shaderModuleMode = requestedShaderModuleMode;
      const existing = sessions.get(featureIdentity);
      if (existing?.generation === generation && existing.shaderModuleMode === shaderModuleMode) {
        existing.session.beginFrame();
        return existing.session;
      }
      if (existing !== undefined) existing.session.dispose();
      const shaderModuleFactory =
        shaderModuleMode === 'immediate'
          ? (input.getImmediateShaderModuleFactory?.() ?? input.getShaderModuleFactory())
          : input.getShaderModuleFactory();
      const session = createRenderFeatureGpuWorkSession({
        device: input.getDevice(),
        shaderModuleFactory,
        generation,
        featureIdentity,
      });
      sessions.set(featureIdentity, { generation, shaderModuleMode, session });
      session.beginFrame();
      return session;
    },
    resolveBuffer: (featureIdentity, reference) =>
      sessions.get(featureIdentity)?.session.resolveBuffer(reference),
    dispose: () => {
      if (disposed) return ok(undefined);
      disposed = true;
      let first: RenderError | undefined;
      for (const { session } of sessions.values()) {
        const disposed = session.dispose();
        if (!disposed.ok && first === undefined) first = disposed.error;
      }
      sessions.clear();
      return first === undefined ? ok(undefined) : err(first);
    },
  };
  return owner;
}
