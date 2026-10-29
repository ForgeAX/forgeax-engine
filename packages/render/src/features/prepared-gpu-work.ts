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
import { PipelineRecipeState } from '@forgeax/engine-rhi';
import {
  type BindGroupLayoutDescriptor,
  err,
  isDeepFrozenJson,
  ok,
  type Result,
  ShaderSource,
  shaderSourceDescriptor,
} from '@forgeax/engine-types';
import { type RenderError, RenderFeaturePreparationFailedError } from '../errors/render';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { sameValue } from '../same-value';
import type { SceneDataTarget } from '../temporal/scene-data';
import type {
  RenderFeaturePassDeclaration,
  RenderFeaturePlan,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
  RenderFeatureWorkScope,
} from './plan';
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
  readonly wgsl: string | ShaderSource;
  readonly entryPoints: readonly string[];
  readonly bindings?: readonly BindGroupLayoutDescriptor[];
}

export interface RenderFeatureGpuBufferDescriptor {
  readonly size: number;
  readonly usage: readonly RenderFeatureGpuBufferUsage[];
  readonly data?: ArrayBufferView;
  readonly uploads?: readonly { readonly offset: number; readonly data: ArrayBufferView }[];
}

export interface RenderFeatureGpuBindingsDescriptor {
  readonly program: RenderFeatureGpuProgramRef;
  readonly entries: readonly (
    | {
        readonly binding: number;
        readonly buffer: RenderFeatureGpuBufferRef;
        readonly offset?: number;
        readonly size?: number;
      }
    | {
        readonly binding: number;
        readonly resource: RenderFeatureGpuPreparedResourceRef;
        readonly offset?: number;
        readonly size?: number;
      }
  )[];
}

export interface RenderFeatureGpuPrepare {
  retainBindings(references: readonly RenderFeatureGpuBindingsRef[]): Result<void, RenderError>;
  prepareProgram(
    name: string,
    descriptor: RenderFeatureGpuProgramDescriptor,
    waitForCompletion?: boolean,
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
  // A compute pass keeps its pipeline and bind groups across dispatches, so
  // consecutive dispatches that share them skip the redundant set calls.
  let pipeline: ComputePipeline | undefined;
  let bindGroup: BindGroup | undefined;
  for (const dispatch of work.dispatches) {
    if (dispatch.pipeline !== pipeline) {
      pass.setPipeline(dispatch.pipeline);
      pipeline = dispatch.pipeline;
    }
    if (dispatch.resolveBindGroup !== undefined && resolveTarget === undefined) {
      throw new Error('Graph texture resolver required for sampled compute work');
    }
    const group =
      dispatch.resolveBindGroup !== undefined && resolveTarget !== undefined
        ? dispatch.resolveBindGroup(resolveTarget)
        : dispatch.bindGroup;
    if (group !== bindGroup) {
      pass.setBindGroup(0, group);
      bindGroup = group;
    }
    if ('workgroups' in dispatch) pass.dispatchWorkgroups(...dispatch.workgroups);
    else pass.dispatchWorkgroupsIndirect(dispatch.indirectBuffer, dispatch.indirectOffset);
  }
}

type NamedBindingEntries = Extract<
  RenderFeatureResourceDeclaration,
  { readonly kind: 'compute-bindings' }
>['entries'];

interface NamedBindingResources {
  readonly buffers: ReadonlyMap<string, RenderFeatureGpuBufferRef>;
  readonly resources: ReadonlyMap<string, RenderFeatureGpuPreparedResourceRef>;
}

declare const RenderFeatureGpuResourceDomainBrand: unique symbol;
export interface RenderFeatureGpuResourceDomain {
  readonly [RenderFeatureGpuResourceDomainBrand]: void;
}

export interface RenderFeatureGpuPrepareSession extends RenderFeatureGpuPrepare {
  /** Programs must pass current preparation before a captured domain is retained. */
  captureResourceDomain(input: {
    readonly programs: readonly RenderFeatureGpuProgramRef[];
    readonly buffers: readonly RenderFeatureGpuBufferRef[];
    readonly bindings: readonly RenderFeatureGpuBindingsRef[];
  }): Result<RenderFeatureGpuResourceDomain, RenderError>;
  retainResourceDomain(domain: RenderFeatureGpuResourceDomain): Result<boolean, RenderError>;
  writeBuffer(
    reference: RenderFeatureGpuBufferRef,
    offset: number,
    data: ArrayBufferView,
  ): Result<void, RenderError>;
  /** Host-private native work resolves names inside the existing validation walk. */
  prepareNamedBindings(
    name: string,
    descriptor: {
      readonly program: RenderFeatureGpuProgramRef;
      readonly entries: NamedBindingEntries;
    },
    resources: NamedBindingResources,
  ): Result<RenderFeatureGpuBindingsRef, RenderError>;
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

const NO_RESOURCE_LEASES: readonly PreparedGraphicsResourceLease[] = Object.freeze([]);

interface ProgramItem {
  readonly completionQualified: boolean;
  readonly name: string;
  /** Detached descriptor used for exact warm-frame equality checks. */
  readonly descriptor: RenderFeatureGpuProgramDescriptor;
  readonly reference: RenderFeatureGpuProgramRef;
  readonly module: ShaderModule;
  readonly pipelines: ReadonlyMap<string, ComputePipeline>;
  readonly bindGroupLayout?: BindGroupLayout;
  readonly bindingLayouts: ReadonlyMap<
    number,
    { readonly type: GPUBufferBindingType; readonly minBindingSize: number }
  >;
  readonly textureBindings: ReadonlyMap<
    number,
    'sampled' | 'storage-write' | 'storage-read' | 'storage-read-write'
  >;
}

interface BufferItem {
  readonly name: string;
  /** Unaligned size the owned buffer was declared with. */
  readonly requestedSize: number;
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
  readonly offset?: number;
  readonly size?: number;
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

/** The owned buffer item when it was declared with this size and usage bit set. */
function ownedBufferMatching(
  item: BufferItem | undefined,
  requestedSize: number,
  physicalUsage: number,
): BufferItem | undefined {
  return item?.owned === true &&
    item.requestedSize === requestedSize &&
    item.physicalUsage === physicalUsage
    ? item
    : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const source = ownedProgramSources.get(value);
    return `{${Object.keys(value as Record<string, unknown>)
      // Descriptor keys are canonicalized by code unit, not locale.  These
      // descriptors are generated every frame; avoiding locale collation
      // keeps the stable spelling deterministic and removes a per-call
      // ICU-backed comparator from the prepared-resource hot path.
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        (key) =>
          `${key}:${stable(key === 'wgsl' && source !== undefined ? source.identity : (value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

type ComputeAccessSummary = Omit<RenderFeatureResolvedGpuComputePass, 'dispatches'>;
/**
 * The graph accesses of one compute pass are a pure function of its program,
 * per-dispatch binding items and indirect buffer items (all immutable). The
 * last proven summary is kept on the pass's first binding item (one pass owner)
 * and reused while every item is identical.
 */
const computeAccessSummaries = new WeakMap<
  BindingsItem,
  {
    readonly program: ProgramItem;
    readonly bindings: readonly BindingsItem[];
    readonly indirect: readonly (BufferItem | undefined)[];
    readonly summary: ComputeAccessSummary;
  }
>();
function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
function computeAccessSummary(
  featureIdentity: string,
  program: ProgramItem,
  dispatchBindings: readonly BindingsItem[],
  indirectItems: readonly (BufferItem | undefined)[],
): Result<ComputeAccessSummary, RenderError> {
  const owner = dispatchBindings[0];
  const cached = owner === undefined ? undefined : computeAccessSummaries.get(owner);
  if (
    cached !== undefined &&
    cached.program === program &&
    sameItems(cached.bindings, dispatchBindings) &&
    sameItems(cached.indirect, indirectItems)
  )
    return ok(cached.summary);
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
      const derived = graphAccess(access.type);
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
  const summary: ComputeAccessSummary = Object.freeze({
    sampledTargets: Object.freeze([...sampledTargets]),
    storageTargets: Object.freeze([...storageTargets]),
    buffers: Object.freeze(
      [...resolvedBuffers].flatMap(([item, accesses]) =>
        [...accesses].map((access) => ({
          name: item.name,
          buffer: item.buffer,
          size: item.size,
          physicalUsage: item.physicalUsage,
          access,
        })),
      ),
    ),
  });
  if (owner !== undefined)
    computeAccessSummaries.set(owner, {
      program,
      bindings: [...dispatchBindings],
      indirect: [...indirectItems],
      summary,
    });
  return ok(summary);
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
const ownedProgramSources = new WeakMap<object, ShaderSource>();
const ownedProgramStates = new WeakMap<object, ReadonlyMap<string, PipelineRecipeState>>();

/** Detach cooked program data once; mutable declarations still use exact checks. */
export function ownRenderFeatureProgramData<T>(value: T): T {
  return ownRenderFeatureProgramDataWith(value);
}

/**
 * @internal Detach program data, substituting nodes for which `reuse` returns an
 * already owned, content-equal value. The caller proves that equality; every other
 * node is copied and frozen in one pass that also checks it is plain JSON data.
 */
export function ownRenderFeatureProgramDataWith<T>(
  value: T,
  reuse?: (node: object) => object | undefined,
): T {
  if (isOwnedRenderFeatureProgramData(value)) return value;
  const state = { plain: true };
  const owned = ownProgramNode(value, state, reuse) as T;
  if (state.plain && owned !== null && typeof owned === 'object') ownedProgramData.add(owned);
  return owned;
}

/**
 * One walk replaces the former clone + source plain-JSON walk + frozen-copy walk.
 * The copy keeps the former clone semantics exactly (enumerable string keys,
 * accessor values read once, views copied as bytes); any non-JSON trait only
 * clears `state.plain`, so such a copy is detached but never marked owned.
 * Owned subtrees and deep-frozen plain JSON subtrees are immutable and are
 * shared, not copied.
 */
function ownProgramNode(
  value: unknown,
  state: { plain: boolean },
  reuse: ((node: object) => object | undefined) | undefined,
): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type !== 'object') {
    if (type !== 'string' && type !== 'number' && type !== 'boolean') state.plain = false;
    return value;
  }
  const node = value as object;
  const sourceField = Object.getOwnPropertyDescriptor(node, 'wgsl');
  const entriesField = Object.getOwnPropertyDescriptor(node, 'entryPoints');
  const programNode =
    (typeof sourceField?.value === 'string' || ShaderSource.is(sourceField?.value)) &&
    Array.isArray(entriesField?.value);
  if (ownedProgramData.has(node)) return node;
  if (!containsProgram(node) && adoptsByIdentity(node)) return node;
  if (reuse !== undefined) {
    const substitute = reuse(node);
    if (substitute !== undefined && ownedProgramData.has(substitute)) return substitute;
  }
  if (ArrayBuffer.isView(node)) {
    state.plain = false;
    return new Uint8Array(new Uint8Array(node.buffer, node.byteOffset, node.byteLength));
  }
  const array = Array.isArray(node);
  if (!array) {
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) state.plain = false;
  }
  const keys = Reflect.ownKeys(node);
  const out: Record<string, unknown> = array
    ? (new Array((node as unknown[]).length) as unknown as Record<string, unknown>)
    : {};
  copyProgramProperties(node, out, keys, state, reuse);
  if (programNode && state.plain) {
    const source = ShaderSource.is(out.wgsl) ? out.wgsl : new ShaderSource([out.wgsl as string]);
    Object.defineProperty(out, 'wgsl', { enumerable: true, get: () => source.read() });
    ownedProgramSources.set(out, source);
    ownedProgramStates.set(
      out,
      new Map(
        (out.entryPoints as string[]).map((entryPoint) => [
          entryPoint,
          new PipelineRecipeState('compute', { compute: { entryPoint } }),
        ]),
      ),
    );
    ownedProgramKeys.set(out, stable(out));
    ownedProgramData.add(out);
  }
  return Object.freeze(out);
}

function copyProgramProperties(
  node: object,
  out: Record<string, unknown>,
  keys: readonly PropertyKey[],
  state: { plain: boolean },
  reuse: ((node: object) => object | undefined) | undefined,
): void {
  const array = Array.isArray(node);
  for (const key of keys) {
    if (typeof key !== 'string') {
      state.plain = false;
      continue;
    }
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor === undefined) continue;
    if (descriptor.enumerable !== true) {
      state.plain = false;
      continue;
    }
    let child: unknown;
    if ('value' in descriptor) child = descriptor.value;
    else {
      state.plain = false;
      child = (node as Record<string, unknown>)[key];
    }
    const copied =
      key === 'wgsl' && ShaderSource.is(child) ? child : ownProgramNode(child, state, reuse);
    if (key === '__proto__')
      Object.defineProperty(out, key, {
        value: copied,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else out[key] = copied;
  }
}

/**
 * Owned data is shared as is. A deep-frozen plain JSON subtree can no longer
 * change either, so owning it needs no copy: it is adopted by identity, and
 * large cooked facts (material ABIs the asset owner retains frozen) stay one
 * shared instance.
 */
function containsProgram(node: object): boolean {
  const source = Object.getOwnPropertyDescriptor(node, 'wgsl');
  const entries = Object.getOwnPropertyDescriptor(node, 'entryPoints');
  if (
    (typeof source?.value === 'string' || ShaderSource.is(source?.value)) &&
    Array.isArray(entries?.value)
  )
    return true;
  if (!isDeepFrozenJson(node)) return true;
  return Object.values(node).some(
    (value) => value !== null && typeof value === 'object' && containsProgram(value),
  );
}

function adoptsByIdentity(node: object): boolean {
  if (ownedProgramData.has(node)) return true;
  if (!isDeepFrozenJson(node)) return false;
  ownedProgramData.add(node);
  return true;
}

export function isOwnedRenderFeatureProgramData(value: unknown): boolean {
  return value !== null && typeof value === 'object' && ownedProgramData.has(value);
}

declare const RenderFeatureNativePlanBrand: unique symbol;
export interface RenderFeatureNativePlanToken {
  readonly [RenderFeatureNativePlanBrand]: void;
}

export interface RenderFeatureNativePlanOwner {
  readonly transaction: object;
  readonly featureIdentity: string;
  readonly frameNumber: number;
  readonly generation: number;
  readonly views: readonly { readonly identity: string; readonly render: boolean }[];
}

export interface RenderFeatureNativeScopeWork {
  scope: RenderFeatureWorkScope;
  resources: RenderFeatureResourceDeclaration[];
  passes: RenderFeaturePassDeclaration[];
}

declare const RenderFeatureNativeResourceDomainBrand: unique symbol;
export interface RenderFeatureNativeResourceDomain {
  readonly [RenderFeatureNativeResourceDomainBrand]: void;
}

export interface RenderFeatureNativeResourceAdmission {
  program(
    scope: RenderFeatureWorkScope,
    name: string,
    descriptor: RenderFeatureGpuProgramDescriptor,
    waitForCompletion?: boolean,
  ): void;
  retain(scope: RenderFeatureWorkScope, domain: RenderFeatureNativeResourceDomain): boolean;
  admit(
    scope: RenderFeatureWorkScope,
    resources: readonly RenderFeatureResourceDeclaration[],
  ): RenderFeatureNativeResourceDomain;
  upload(scope: RenderFeatureWorkScope, name: string, offset: number, data: ArrayBufferView): void;
}

export interface RenderFeatureNativePlanBuilder {
  scope(scope: RenderFeatureWorkScope): RenderFeatureNativeScopeWork;
  readonly resourceAdmission?: RenderFeatureNativeResourceAdmission | undefined;
  finish(
    finalWork: readonly RenderFeatureWork[],
    sourceFeedback?: unknown,
    // The producer permits adjacent view raster draws to share their usage
    // scope; no storage/provider ordering barrier depends on the pass boundary.
    // Host still proves current non-writing pipeline state and actual readiness.
    options?: { readonly batchReadOnlyDepthRaster?: true },
  ): RenderFeaturePlan;
}

interface NativePlanPublication extends RenderFeatureNativePlanOwner {
  readonly batchReadOnlyDepthRaster?: true;
  readonly work: readonly RenderFeatureWork[];
  readonly resourceAdmission?: RenderFeatureNativeResourceAdmission | undefined;
  consumed: boolean;
}

const nativePlanPublications = new WeakMap<object, NativePlanPublication>();

/**
 * @internal Host-bound creator of the primary private work, never an adapter for
 * borrowed declarations. Finish transfers the exact work; the creator must stop
 * mutating it. Only bounded owner facts are detached, never declaration trees.
 */
export function createRenderFeatureNativePlanBuilder(
  input: RenderFeatureNativePlanOwner,
  createResourceAdmission?: () => RenderFeatureNativeResourceAdmission,
): RenderFeatureNativePlanBuilder {
  const { transaction, featureIdentity, frameNumber, generation } = input;
  const views = input.views.map(({ identity, render }) => ({ identity, render }));
  const viewNames = new Set(views.map((view) => view.identity));
  if (viewNames.size !== views.length) throw new Error('Duplicate native plan view');
  let scopes: Map<string, RenderFeatureNativeScopeWork> | undefined;
  let closed = false;
  const scopeKey = (scope: RenderFeatureWorkScope): string => {
    if (scope === 'frame') return 'frame';
    if (scope === null || typeof scope !== 'object' || !viewNames.has(scope.view))
      throw new Error('Unknown native plan scope');
    return `view:${scope.view}`;
  };
  let resourceAdmission: RenderFeatureNativeResourceAdmission | undefined;
  let guardedAdmission: RenderFeatureNativeResourceAdmission | undefined;
  const admission = () => {
    if (guardedAdmission === undefined && createResourceAdmission !== undefined) {
      if (closed) throw new Error('Native plan builder is closed');
      resourceAdmission = createResourceAdmission();
      guardedAdmission = Object.fromEntries(
        Object.entries(resourceAdmission).map(([name, method]) => [
          name,
          (scope: RenderFeatureWorkScope, ...args: unknown[]) => {
            if (closed) throw new Error('Native plan builder is closed');
            scopeKey(scope);
            return (method as (scope: RenderFeatureWorkScope, ...args: unknown[]) => unknown)(
              scope,
              ...args,
            );
          },
        ]),
      ) as unknown as RenderFeatureNativeResourceAdmission;
    }
    return guardedAdmission;
  };
  return {
    get resourceAdmission() {
      return admission();
    },
    scope: (scope) => {
      if (closed) throw new Error('Native plan builder is closed');
      const key = scopeKey(scope);
      let work = scopes?.get(key);
      if (work === undefined) {
        work = {
          scope: scope === 'frame' ? 'frame' : { view: scope.view },
          resources: [],
          passes: [],
        };
        scopes ??= new Map();
        scopes.set(key, work);
      }
      return work;
    },
    finish: (finalWork, sourceFeedback, options) => {
      if (closed) throw new Error('Native plan builder is closed');
      closed = true;
      let admitted: Set<string> | undefined;
      for (const work of finalWork) {
        const key = scopeKey(work.scope);
        if (
          !scopes?.has(key) ||
          admitted?.has(key) === true ||
          !Array.isArray(work.resources) ||
          !Array.isArray(work.passes)
        )
          throw new Error('Native plan work must use each created scope at most once');
        admitted ??= new Set();
        admitted.add(key);
      }
      const native = {} as RenderFeatureNativePlanToken;
      const planned: RenderFeaturePlan = {
        work: [],
        native,
        ...(sourceFeedback === undefined ? {} : { sourceFeedback }),
      };
      nativePlanPublications.set(planned, {
        transaction,
        featureIdentity,
        frameNumber,
        generation,
        views,
        ...(options?.batchReadOnlyDepthRaster === true ? { batchReadOnlyDepthRaster: true } : {}),
        work: finalWork,
        ...(resourceAdmission === undefined ? {} : { resourceAdmission }),
        consumed: false,
      });
      return planned;
    },
  };
}

/** @internal Match an issued wrapper without observing any borrowed properties. */
export function isRenderFeatureNativePlan(value: unknown): boolean {
  return value !== null && typeof value === 'object' && nativePlanPublications.has(value);
}

/** @internal The admission is recovered only from the consumed Host publication. */
export function renderFeatureNativeResourceAdmission(
  planned: object,
): RenderFeatureNativeResourceAdmission | undefined {
  const publication = nativePlanPublications.get(planned);
  return publication?.consumed === true ? publication.resourceAdmission : undefined;
}

/** @internal Producer permission only; current prepared pipeline authority still
 * proves read-only state and actual readiness before any pass is combined. */
export function renderFeatureNativeDepthBatchPermission(planned: object): boolean {
  const publication = nativePlanPublications.get(planned);
  return publication?.consumed === true && publication.batchReadOnlyDepthRaster === true;
}

/** @internal A successful Host consumption closes this exact publication. */
export function consumeRenderFeatureNativePlan(
  planned: unknown,
  expected: RenderFeatureNativePlanOwner,
): readonly RenderFeatureWork[] | undefined {
  if (planned === null || typeof planned !== 'object') return undefined;
  const publication = nativePlanPublications.get(planned);
  if (
    publication === undefined ||
    publication.consumed ||
    publication.transaction !== expected.transaction ||
    publication.featureIdentity !== expected.featureIdentity ||
    publication.frameNumber !== expected.frameNumber ||
    publication.generation !== expected.generation ||
    publication.views.length !== expected.views.length ||
    !publication.views.every(
      (view, index) =>
        view.identity === expected.views[index]?.identity &&
        view.render === expected.views[index]?.render,
    )
  )
    return undefined;
  publication.consumed = true;
  return publication.work;
}

function rhiReason(error: unknown): string {
  if (error === null || typeof error !== 'object') return String(error);
  const code = 'code' in error ? String(error.code) : 'webgpu-runtime-error';
  const hint =
    'hint' in error ? String(error.hint) : error instanceof Error ? error.message : String(error);
  const detail = 'detail' in error && error.detail !== undefined ? `:${stable(error.detail)}` : '';
  return `${code}:${hint}${detail}`;
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
  let disposed = false;
  interface PreparingProgram {
    readonly module: ShaderModule;
    readonly bindGroupLayout?: BindGroupLayout;
    readonly pipelines: Map<string, ComputePipeline>;
    pending: number;
    error?: RenderError;
  }
  const preparingPrograms = new Map<string, PreparingProgram>();
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
  const resourceDomains = new WeakMap<
    RenderFeatureGpuResourceDomain,
    {
      readonly programs: readonly ProgramItem[];
      readonly buffers: readonly BufferItem[];
      readonly bindings: readonly BindingsItem[];
    }
  >();
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
  // Active, parked and queue-retired resources all remain in these indexes.
  const hasResourceReferences = (): boolean =>
    programRefs.size !== 0 ||
    bufferRefs.size !== 0 ||
    bindingRefs.size !== 0 ||
    textureViewRefs.size !== 0 ||
    samplerRefs.size !== 0;
  // Resource refs are freshly allocated opaque objects. Rollback needs only
  // this frame's additions; accepted index keys never need copying. One
  // rollback record is retained and reset per frame instead of reallocated.
  const candidateState = {
    // Candidate preparation only inserts or overwrites active names. Keep
    // each name's first old value; accepted keys never move before commit.
    programs: new Map<string, ProgramItem | undefined>(),
    buffers: new Map<string, BufferItem | undefined>(),
    bindings: new Map<string, BindingsItem | undefined>(),
    textureViews: new Map<string, TextureViewItem | undefined>(),
    samplers: new Map<string, SamplerItem | undefined>(),
    parkedPrograms: new Map<string, { readonly item: ProgramItem; readonly frame: number }>(),
    parkedBuffers: new Map<string, { readonly item: BufferItem; readonly frame: number }>(),
    parkedBindings: new Map<string, { readonly item: BindingsItem; readonly frame: number }>(),
    addedProgramRefs: [] as object[],
    addedBufferRefs: [] as object[],
    addedBindingRefs: [] as object[],
    addedTextureViewRefs: [] as object[],
    addedSamplerRefs: [] as object[],
  };
  // Clearing an empty collection still reallocates its table; skip it.
  const clearCollection = (collection: { readonly size: number; clear(): void }): void => {
    if (collection.size > 0) collection.clear();
  };
  const copyInto = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void => {
    clearCollection(target);
    if (source.size > 0) for (const [key, value] of source) target.set(key, value);
  };
  const snapshotIndexes = (): typeof candidateState => {
    const state = candidateState;
    clearCollection(state.programs);
    clearCollection(state.buffers);
    clearCollection(state.bindings);
    clearCollection(state.textureViews);
    clearCollection(state.samplers);
    copyInto(state.parkedPrograms, parkedPrograms);
    copyInto(state.parkedBuffers, parkedBuffers);
    copyInto(state.parkedBindings, parkedBindings);
    state.addedProgramRefs.length = 0;
    state.addedBufferRefs.length = 0;
    state.addedBindingRefs.length = 0;
    state.addedTextureViewRefs.length = 0;
    state.addedSamplerRefs.length = 0;
    return state;
  };
  let candidate: ReturnType<typeof snapshotIndexes> | undefined;
  const setCandidateName = <T>(
    target: Map<string, T>,
    previous: Map<string, T | undefined> | undefined,
    name: string,
    item: T,
  ): void => {
    const current = target.get(name);
    if (current === item) return;
    if (previous !== undefined && !previous.has(name)) previous.set(name, current);
    target.set(name, item);
  };
  const restoreCandidateNames = <T>(
    target: Map<string, T>,
    previous: ReadonlyMap<string, T | undefined>,
  ): void => {
    // Active names are never deleted during a candidate: restoring a value
    // preserves accepted insertion order, while new names can be removed.
    for (const [name, item] of previous) {
      if (item === undefined) target.delete(name);
      else target.set(name, item);
    }
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
    if (!hasResourceReferences()) return ok(undefined);
    const createdBuffers: BufferItem[] = [];
    for (const reference of previous.addedBufferRefs) {
      const item = bufferRefs.get(reference);
      if (item !== undefined) createdBuffers.push(item);
    }
    const discard = <T>(index: Map<object, T>, references: readonly object[]): void => {
      for (const reference of references) index.delete(reference);
    };
    restoreCandidateNames(programs, previous.programs);
    restoreCandidateNames(buffers, previous.buffers);
    restoreCandidateNames(bindings, previous.bindings);
    restoreCandidateNames(textureViews, previous.textureViews);
    restoreCandidateNames(samplers, previous.samplers);
    copyInto(parkedPrograms, previous.parkedPrograms);
    copyInto(parkedBuffers, previous.parkedBuffers);
    copyInto(parkedBindings, previous.parkedBindings);
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
    if (current === undefined) {
      parkedPrograms.delete(item.name);
      setCandidateName(programs, candidate?.programs, item.name, item);
    }
  };
  const activateBuffer = (item: BufferItem): void => {
    const current = buffers.get(item.name);
    if (current === undefined) {
      parkedBuffers.delete(item.name);
      setCandidateName(buffers, candidate?.buffers, item.name, item);
    }
  };
  const activateBindingName = (item: BindingsItem): void => {
    const current = bindings.get(item.name);
    if (current === undefined) {
      parkedBindings.delete(item.name);
      setCandidateName(bindings, candidate?.bindings, item.name, item);
    }
  };
  const activateBindings = (item: BindingsItem): void => {
    activateBindingName(item);
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
  const touchBindingName = (item: BindingsItem): void => {
    retiring.delete(item.reference);
    touchedBindings.add(item);
  };
  const touchBindings = (item: BindingsItem): void => {
    // A binding's immutable closure is touched together, including domains.
    if (touchedBindings.has(item)) return;
    touchBindingName(item);
    touchProgram(item.program);
    for (const entry of item.entries) {
      if (entry.buffer !== undefined) touchBuffer(entry.buffer);
      if (entry.textureView !== undefined) touchTextureView(entry.textureView);
      if (entry.sampler !== undefined) touchSampler(entry.sampler);
    }
  };

  const currentProgram = (item: ProgramItem): boolean =>
    programRefs.get(item.reference) === item &&
    item.reference.generation === input.generation &&
    (programs.get(item.name) ?? parkedPrograms.get(item.name)?.item) === item;
  const currentBuffer = (item: BufferItem): boolean =>
    bufferRefs.get(item.reference) === item &&
    item.reference.generation === input.generation &&
    (buffers.get(item.name) ?? parkedBuffers.get(item.name)?.item) === item;
  const currentBindings = (item: BindingsItem): boolean =>
    bindingRefs.get(item.reference) === item &&
    item.reference.generation === input.generation &&
    (bindings.get(item.name) ?? parkedBindings.get(item.name)?.item) === item;

  const prepareProgram: RenderFeatureGpuPrepare['prepareProgram'] = (
    name,
    descriptor,
    waitForCompletion = false,
  ) => {
    const source = ownedProgramSources.get(descriptor);
    const createAsync = waitForCompletion ? input.device.createComputePipelineAsync : undefined;
    const complete = (item: ProgramItem) => createAsync === undefined || item.completionQualified;
    const prior = programs.get(name) ?? parkedPrograms.get(name)?.item;
    if (
      prior !== undefined &&
      complete(prior) &&
      sameProgramDescriptor(prior.descriptor, descriptor)
    ) {
      activateProgram(prior);
      touchProgram(prior);
      return ok(prior.reference);
    }
    if (
      name.length === 0 ||
      (source?.length ?? descriptor.wgsl.length) === 0 ||
      descriptor.entryPoints.length === 0
    ) {
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
    const programKey = programDescriptorKey(descriptor);
    const compiled = compiledPrograms.get(programKey);
    if (compiled !== undefined && complete(compiled)) {
      compiledPrograms.delete(programKey);
      compiledPrograms.set(programKey, compiled);
      const item = {
        ...compiled,
        name,
        // Equivalent recipes share native programs, but an admitted immutable
        // alias keeps its own detached descriptor for the existing identity check.
        descriptor: isOwnedRenderFeatureProgramData(descriptor) ? descriptor : compiled.descriptor,
        reference: Object.freeze({ generation: input.generation }) as RenderFeatureGpuProgramRef,
      };
      parkedPrograms.delete(name);
      setCandidateName(programs, candidate?.programs, name, item);
      changedResourceNames.add(name);
      programRefs.set(item.reference, item);
      candidate?.addedProgramRefs.push(item.reference);
      touchProgram(item);
      return ok(item.reference);
    }
    const preparing = preparingPrograms.get(programKey);
    const preparationFailure = (reason: string) =>
      failure(input.featureIdentity, 'prepare-gpu-program', 'pipeline', name, reason);
    if (preparing?.error !== undefined) return err(preparing.error);
    if (preparing !== undefined && preparing.pending > 0)
      return err(preparationFailure('rhi-not-available:pipeline-pending'));
    const module =
      preparing === undefined
        ? input.shaderModuleFactory.createShaderModule(
            source?.descriptor(name) ?? shaderSourceDescriptor(descriptor.wgsl, name),
          )
        : ok(preparing.module);
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
    let bindGroupLayout: BindGroupLayout | undefined = preparing?.bindGroupLayout;
    let pipelineLayout: 'auto' | PipelineLayout = 'auto';
    if (preparing === undefined && descriptor.bindings !== undefined) {
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
    const pipelineMap = preparing?.pipelines ?? new Map<string, ComputePipeline>();
    if (preparing === undefined && createAsync !== undefined) {
      if (preparingPrograms.size >= COMPILED_PROGRAM_CACHE_LIMIT)
        return err(preparationFailure('preparation-budget-exceeded'));
      const state: PreparingProgram = {
        module: module.value,
        ...(bindGroupLayout === undefined ? {} : { bindGroupLayout }),
        pipelines: pipelineMap,
        pending: descriptor.entryPoints.length,
      };
      preparingPrograms.set(programKey, state);
      const settle = (entryPoint: string, result: Result<ComputePipeline, unknown>) => {
        if (disposed || preparingPrograms.get(programKey) !== state) return;
        if (result.ok) state.pipelines.set(entryPoint, result.value);
        else state.error ??= preparationFailure(rhiReason(result.error));
        state.pending--;
      };
      for (const entryPoint of descriptor.entryPoints) {
        try {
          const selected = selectProgramPipeline(
            input.device,
            descriptor,
            entryPoint,
            pipelineLayout,
            module.value,
            true,
          );
          const create = () =>
            createAsync.call(input.device, {
              label: `${name}.${entryPoint}`,
              layout: pipelineLayout,
              compute: { module: module.value, entryPoint },
            });
          const completion = completeProgramSelection(selected, create);
          // forgeax-async-whitelist: dom-native - observe actual backend compute compilation completion.
          if ('ok' in completion) settle(entryPoint, completion);
          else
            void completion.then(
              (result) => settle(entryPoint, result),
              (cause) => settle(entryPoint, err(cause)),
            );
        } catch (cause) {
          settle(entryPoint, err(cause));
        }
      }
      if (state.pending > 0) return err(preparationFailure('rhi-not-available:pipeline-pending'));
      if (state.error !== undefined) return err(state.error);
    }
    if (preparing === undefined && createAsync === undefined)
      for (const entryPoint of descriptor.entryPoints) {
        const selected = selectProgramPipeline(
          input.device,
          descriptor,
          entryPoint,
          pipelineLayout,
          module.value,
          false,
        );
        const pipeline = immediateProgramSelection(selected, () =>
          input.device.createComputePipeline({
            label: `${name}.${entryPoint}`,
            layout: pipelineLayout,
            compute: { module: module.value, entryPoint },
          }),
        );
        if (!pipeline.ok) return err(preparationFailure(rhiReason(pipeline.error)));
        pipelineMap.set(entryPoint, pipeline.value);
      }
    preparingPrograms.delete(programKey);
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
      completionQualified: preparing !== undefined || createAsync !== undefined,
      descriptor: cloneProgramDescriptor(descriptor),
      reference,
      module: module.value,
      pipelines: pipelineMap,
      bindingLayouts: new Map(
        (descriptor.bindings?.[0]?.entries ?? []).flatMap((entry) =>
          entry.buffer === undefined
            ? []
            : [
                [
                  entry.binding,
                  {
                    type: entry.buffer.type ?? 'uniform',
                    minBindingSize: entry.buffer.minBindingSize ?? 0,
                  },
                ] as const,
              ],
        ),
      ),
      textureBindings,
      ...(bindGroupLayout === undefined ? {} : { bindGroupLayout }),
    };
    parkedPrograms.delete(name);
    setCandidateName(programs, candidate?.programs, name, item);
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
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      !Number.isSafeInteger(alignedSize(descriptor.size)) ||
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
    const uploadFailure = (reason: string) =>
      err(failure(input.featureIdentity, 'write-gpu-buffer', 'vertex-data', name, reason));
    if (descriptor.uploads !== undefined) {
      if (!Array.isArray(descriptor.uploads)) return uploadFailure('uploads-invalid');
      for (const upload of descriptor.uploads) {
        if (
          upload === null ||
          typeof upload !== 'object' ||
          !ArrayBuffer.isView(upload.data) ||
          !Number.isSafeInteger(upload.offset) ||
          upload.offset < 0 ||
          upload.offset % 4 !== 0 ||
          upload.data.byteLength % 4 !== 0 ||
          upload.offset > descriptor.size ||
          upload.data.byteLength > descriptor.size - upload.offset
        )
          return uploadFailure('upload-range-invalid');
      }
    }
    // Size and the usage bit set identify an owned buffer: equal bits are the
    // same usage set in any order, so no per-frame signature text is built.
    const usage = descriptor.usage.reduce((bits, key) => bits | BUFFER_USAGE[key], COPY_DST);
    let item = ownedBufferMatching(
      buffers.get(name) ?? parkedBuffers.get(name)?.item,
      descriptor.size,
      usage,
    );
    if (item === undefined) {
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
        requestedSize: descriptor.size,
        reference,
        buffer: created.value,
        size: alignedSize(descriptor.size),
        physicalUsage: usage,
        owned: true,
      };
      parkedBuffers.delete(name);
      setCandidateName(buffers, candidate?.buffers, name, item);
      changedResourceNames.add(name);
      bufferRefs.set(reference, item);
      candidate?.addedBufferRefs.push(reference);
    }
    activateBuffer(item);
    touchBuffer(item);
    if (descriptor.data !== undefined) {
      if (descriptor.data.byteLength > descriptor.size) return uploadFailure('data-exceeds-size');
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
    for (const upload of descriptor.uploads ?? []) {
      const written = input.device.queue.writeBuffer(
        item.buffer,
        upload.offset,
        bytes(upload.data),
      );
      if (!written.ok) return uploadFailure(written.error.code);
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
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      !Number.isSafeInteger(alignedSize(descriptor.size)) ||
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
      requestedSize: descriptor.size,
      reference,
      buffer: resource,
      size,
      physicalUsage: usage,
      owned: false,
    };
    parkedBuffers.delete(name);
    setCandidateName(buffers, candidate?.buffers, name, item);
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
    setCandidateName(textureViews, candidate?.textureViews, name, item);
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
    setCandidateName(samplers, candidate?.samplers, name, item);
    changedResourceNames.add(name);
    samplerRefs.set(reference, item);
    candidate?.addedSamplerRefs.push(reference);
    touchSampler(item);
    return ok(reference);
  };

  const prepareBindings = (
    name: string,
    descriptor:
      | RenderFeatureGpuBindingsDescriptor
      | {
          readonly program: RenderFeatureGpuProgramRef;
          readonly entries: NamedBindingEntries;
        },
    named?: NamedBindingResources,
  ): Result<RenderFeatureGpuBindingsRef, RenderError> => {
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
    const prior = bindings.get(name) ?? parkedBindings.get(name)?.item;
    const entryItems: BindingResourceItem[] = [];
    const previousEntry = (binding: number): BindingResourceItem | undefined => {
      const entry = prior?.program === program ? prior.entries[entryItems.length] : undefined;
      return entry?.binding === binding ? entry : undefined;
    };
    const bufferEntry = (
      entry: Pick<
        RenderFeatureGpuBindingsDescriptor['entries'][number],
        'binding' | 'offset' | 'size'
      >,
      item: BufferItem,
    ): Result<BindingResourceItem, RenderError> => {
      const offset = entry.offset ?? 0;
      const size = entry.size ?? item.size - offset;
      const layout = program.bindingLayouts.get(entry.binding);
      const reject = (reason: string) =>
        err(
          failure(
            input.featureIdentity,
            'prepare-gpu-bindings',
            'bindings',
            name,
            `${reason}:${entry.binding}`,
          ),
        );
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        offset > item.size ||
        size > item.size - offset ||
        (layout?.type !== 'uniform' && size % 4 !== 0)
      )
        return reject('buffer-range-invalid');
      const alignment =
        layout?.type === 'uniform'
          ? (input.device.limits.minUniformBufferOffsetAlignment ?? 256)
          : (input.device.limits.minStorageBufferOffsetAlignment ?? 256);
      if (offset % alignment !== 0) return reject('buffer-offset-unaligned');
      if (
        layout !== undefined &&
        (!Number.isSafeInteger(layout.minBindingSize) ||
          layout.minBindingSize < 0 ||
          size < layout.minBindingSize)
      )
        return reject('buffer-binding-too-small');
      const previous = previousEntry(entry.binding);
      if (previous?.buffer === item && previous.offset === offset && previous.size === size)
        return ok(previous);
      return ok({
        binding: entry.binding,
        offset,
        size,
        resource: {
          kind: 'buffer',
          value: {
            buffer: item.buffer,
            ...(entry.offset === undefined ? {} : { offset }),
            ...(entry.size === undefined ? {} : { size }),
          },
        },
        buffer: item,
      });
    };
    for (const entry of descriptor.entries) {
      const namedBuffer = named?.buffers.get((entry as NamedBindingEntries[number]).resource);
      if (named === undefined ? 'buffer' in entry : namedBuffer !== undefined) {
        const raw = entry as Extract<
          RenderFeatureGpuBindingsDescriptor['entries'][number],
          { readonly buffer: RenderFeatureGpuBufferRef }
        >;
        const item = bufferRefs.get((named === undefined ? raw.buffer : namedBuffer) as object);
        if (
          item === undefined ||
          (named === undefined ? raw.buffer : (namedBuffer as RenderFeatureGpuBufferRef))
            .generation !== input.generation
        ) {
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
        const ranged = bufferEntry(entry, item);
        if (!ranged.ok) return ranged;
        entryItems.push(ranged.value);
        continue;
      }
      const prepared = (
        named === undefined
          ? (
              entry as Extract<
                RenderFeatureGpuBindingsDescriptor['entries'][number],
                { readonly resource: RenderFeatureGpuPreparedResourceRef }
              >
            ).resource
          : named.resources.get((entry as NamedBindingEntries[number]).resource)
      ) as RenderFeatureGpuPreparedResourceRef;
      if (named !== undefined && prepared === undefined) {
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-bindings',
            'bindings',
            name,
            `resource-unavailable:${entry.binding}`,
          ),
        );
      }
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
        const ranged = bufferEntry(entry, item);
        if (!ranged.ok) return ranged;
        entryItems.push(ranged.value);
        continue;
      }
      if (entry.offset !== undefined || entry.size !== undefined)
        return err(
          failure(
            input.featureIdentity,
            'prepare-gpu-bindings',
            'bindings',
            name,
            `buffer-range-on-non-buffer:${entry.binding}`,
          ),
        );
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
        const previous = previousEntry(entry.binding);
        if (previous?.textureView === item) {
          entryItems.push(previous);
          continue;
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
      const previous = previousEntry(entry.binding);
      if (previous?.sampler === item) {
        entryItems.push(previous);
        continue;
      }
      entryItems.push({
        binding: entry.binding,
        resource: { kind: 'sampler', value: item.resource },
        sampler: item,
      });
    }
    if (
      prior !== undefined &&
      prior.program === program &&
      prior.entries.length === entryItems.length &&
      prior.entries.every((entry, index) => {
        const next = entryItems[index];
        return (
          next !== undefined &&
          entry.binding === next.binding &&
          entry.offset === next.offset &&
          entry.size === next.size &&
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
    setCandidateName(bindings, candidate?.bindings, name, item);
    changedResourceNames.add(name);
    bindingRefs.set(reference, item);
    candidate?.addedBindingRefs.push(reference);
    touchBindings(item);
    return ok(reference);
  };

  const captureResourceDomain: RenderFeatureGpuPrepareSession['captureResourceDomain'] = (
    source,
  ) => {
    const reject = (reason: string) =>
      err(
        failure(
          input.featureIdentity,
          'capture-gpu-resources',
          'bindings',
          'resource-domain',
          reason,
        ),
      );
    if (disposed || candidate === undefined) return reject('frame-unavailable');
    const domainPrograms = new Set<ProgramItem>();
    const domainBuffers = new Set<BufferItem>();
    const domainBindings = new Set<BindingsItem>();
    for (const reference of source.programs) {
      const item = programRefs.get(reference);
      if (item === undefined || !currentProgram(item)) return reject('program-unavailable');
      domainPrograms.add(item);
    }
    for (const reference of source.buffers) {
      const item = bufferRefs.get(reference);
      if (item === undefined || !item.owned || !currentBuffer(item))
        return reject('buffer-unavailable');
      domainBuffers.add(item);
    }
    for (const reference of source.bindings) {
      const item = bindingRefs.get(reference);
      if (item === undefined || !currentBindings(item) || !currentProgram(item.program))
        return reject('bindings-unavailable');
      domainBindings.add(item);
      domainPrograms.add(item.program);
      for (const entry of item.entries) {
        if (entry.textureView !== undefined || entry.sampler !== undefined)
          return reject('borrowed-resource');
        if (entry.buffer === undefined) continue;
        if (!entry.buffer.owned || !currentBuffer(entry.buffer))
          return reject('buffer-unavailable');
        domainBuffers.add(entry.buffer);
      }
    }
    const domain = Object.freeze({}) as RenderFeatureGpuResourceDomain;
    resourceDomains.set(domain, {
      programs: [...domainPrograms],
      buffers: [...domainBuffers],
      bindings: [...domainBindings],
    });
    return ok(domain);
  };
  const retainResourceDomain: RenderFeatureGpuPrepareSession['retainResourceDomain'] = (domain) => {
    const retained = resourceDomains.get(domain);
    if (
      disposed ||
      candidate === undefined ||
      retained === undefined ||
      !retained.programs.every(currentProgram) ||
      !retained.buffers.every(currentBuffer) ||
      !retained.bindings.every(currentBindings)
    )
      return ok(false);
    // Validate the complete closure before publishing any revived names.
    for (const item of retained.programs) {
      activateProgram(item);
      touchProgram(item);
    }
    for (const item of retained.buffers) {
      activateBuffer(item);
      touchBuffer(item);
    }
    for (const item of retained.bindings) {
      activateBindingName(item);
      touchBindingName(item);
    }
    return ok(true);
  };
  const writeBuffer: RenderFeatureGpuPrepareSession['writeBuffer'] = (reference, offset, data) => {
    const item = bufferRefs.get(reference);
    const reject = (reason: string) =>
      err(
        failure(
          input.featureIdentity,
          'write-gpu-buffer',
          'vertex-data',
          item?.name ?? 'buffer',
          reason,
        ),
      );
    if (disposed || candidate === undefined || item === undefined || !currentBuffer(item))
      return reject('buffer-unavailable');
    if (
      !ArrayBuffer.isView(data) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % 4 !== 0 ||
      data.byteLength % 4 !== 0 ||
      offset > item.size ||
      data.byteLength > item.size - offset ||
      (item.physicalUsage & COPY_DST) === 0
    )
      return reject('upload-range-invalid');
    activateBuffer(item);
    touchBuffer(item);
    const written = input.device.queue.writeBuffer(item.buffer, offset, bytes(data));
    return written.ok ? ok(undefined) : reject(written.error.code);
  };

  return {
    changedResourceNames,
    captureResourceDomain,
    retainResourceDomain,
    writeBuffer,
    beginFrame: () => {
      if (candidate !== undefined)
        throw new Error('Feature GPU frame must commit or abort before beginning another frame');
      candidate = snapshotIndexes();
      clearCollection(changedResourceNames);
      clearCollection(touchedPrograms);
      clearCollection(touchedBuffers);
      clearCollection(touchedTextureViews);
      clearCollection(touchedSamplers);
      clearCollection(touchedBindings);
    },
    retainResources: (matches) => {
      if (!hasResourceReferences()) return;
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
    prepareNamedBindings: (name, descriptor, resources) =>
      prepareBindings(name, descriptor, resources),
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
      for (let index = 0; index < descriptor.dispatches.length; index++) {
        const dispatch = descriptor.dispatches[index] as (typeof descriptor.dispatches)[number];
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
      for (let index = 0; index < descriptor.dispatches.length; index++) {
        const dispatch = descriptor.dispatches[index] as (typeof descriptor.dispatches)[number];
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
      const access = computeAccessSummary(
        featureIdentity,
        program,
        dispatchBindings as readonly BindingsItem[],
        indirectItems,
      );
      if (!access.ok) return access;
      return ok({ ...access.value, dispatches: resolvedDispatches });
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
      if (candidate === undefined) return NO_RESOURCE_LEASES;
      candidate = undefined;
      frameSerial += 1;
      // No prepared references means there are no active, parked or pending
      // retirement resources to visit. In-flight retirement retains its refs.
      if (!hasResourceReferences()) return NO_RESOURCE_LEASES;
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
      const releases: (() => BufferItem | undefined)[] = [];
      const retire = <T extends { readonly name: string; readonly reference: object }>(
        index: Map<object, T>,
        named: ReadonlyMap<string, T>,
        parked: ReadonlyMap<string, { readonly item: T }> | undefined,
        touched: ReadonlySet<T>,
        buffer?: (item: T) => BufferItem,
      ): void => {
        for (const [reference, item] of index) {
          if (
            touched.has(item) ||
            named.get(item.name) === item ||
            parked?.get(item.name)?.item === item ||
            retiring.has(reference)
          )
            continue;
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
      retire(programRefs, programs, parkedPrograms, touchedPrograms);
      retire(bufferRefs, buffers, parkedBuffers, touchedBuffers, (item) => item);
      retire(bindingRefs, bindings, parkedBindings, touchedBindings);
      retire(textureViewRefs, textureViews, undefined, touchedTextureViews);
      retire(samplerRefs, samplers, undefined, touchedSamplers);
      if (releases.length === 0) return NO_RESOURCE_LEASES;
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
      disposed = true;
      preparingPrograms.clear();
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

function programDescriptorKey(descriptor: RenderFeatureGpuProgramDescriptor): string {
  if (!isOwnedRenderFeatureProgramData(descriptor)) return stable(descriptor);
  const existing = ownedProgramKeys.get(descriptor);
  if (existing !== undefined) return existing;
  const key = stable(descriptor);
  ownedProgramKeys.set(descriptor, key);
  return key;
}

function sameProgramDescriptor(
  left: RenderFeatureGpuProgramDescriptor,
  right: RenderFeatureGpuProgramDescriptor,
): boolean {
  if (left === right) return true;
  if (isOwnedRenderFeatureProgramData(left) && isOwnedRenderFeatureProgramData(right))
    return programDescriptorKey(left) === programDescriptorKey(right);
  return sameValue(left, right);
}

type ProgramPipelineSelection =
  | Result<ComputePipeline | undefined, unknown>
  | Promise<Result<ComputePipeline | undefined, unknown>>
  | undefined;

function selectProgramPipeline(
  device: RhiDevice,
  descriptor: RenderFeatureGpuProgramDescriptor,
  entryPoint: string,
  layout: PipelineLayout | 'auto',
  module: ShaderModule,
  completed: boolean,
): ProgramPipelineSelection {
  const state = ownedProgramStates.get(descriptor)?.get(entryPoint);
  return state === undefined
    ? undefined
    : device.pipelineLibrary?.selectCompute?.(state, { layout, compute: module }, completed);
}

function completeProgramSelection(
  selected: ProgramPipelineSelection,
  create: () => Result<ComputePipeline, unknown> | Promise<Result<ComputePipeline, unknown>>,
): Result<ComputePipeline, unknown> | Promise<Result<ComputePipeline, unknown>> {
  if (selected === undefined) return create();
  if ('ok' in selected)
    return selected.ok && selected.value === undefined
      ? create()
      : (selected as Result<ComputePipeline, unknown>);
  return selected.then((result) => {
    if (result.ok && result.value === undefined) throw new Error('Selected pipeline disappeared');
    return result as Result<ComputePipeline, unknown>;
  });
}

function immediateProgramSelection(
  selected: ProgramPipelineSelection,
  create: () => Result<ComputePipeline, unknown>,
): Result<ComputePipeline, unknown> {
  if (selected !== undefined && 'ok' in selected && (!selected.ok || selected.value !== undefined))
    return selected as Result<ComputePipeline, unknown>;
  return create();
}
