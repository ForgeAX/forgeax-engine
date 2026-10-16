// @forgeax/engine-render-graph/src/graph.ts — RenderGraph core primitives.
//
// Shape (plan-strategy D-1/D-4/D-5/D-6.1):
// - ResourceDescriptor / PassDescriptor — declaration types
// - RenderGraph — main class: addResource / addPass / compile / execute
// - PassInfo / ResourceInfo — query interfaces (D-5)

import type {
  RhiCaps,
  ComputePassDescriptor as RhiComputePassDescriptor,
  RhiComputePassEncoder,
  RhiDevice,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  type AliasSourceDetail,
  type CapMissingDetail,
  type DanglingReadDetail,
  err,
  ok,
  RenderGraphError,
  type Result,
} from './errors.js';
import {
  type CurrentFrameObservationDescriptor,
  type CurrentFrameObservationLease,
  createCurrentFrameObservationLease,
} from './observation.js';
import type { PassEntry } from './pass-registry.js';
import { PassRegistry } from './pass-registry.js';
import {
  type ColorDomainConnection,
  type ColorValueDomain,
  validateColorDomainConnection,
} from './pipeline/color-value-domain.js';
import type { ResourceEntry } from './resource-registry.js';
import { ResourceRegistry } from './resource-registry.js';

// ── Declaration types ────────────────────────────────────────────

export type ResourceKind = 'texture' | 'buffer';

export type ResourceLifetime = 'transient' | 'persistent';

export type BufferRole = 'auto-storage-or-uniform' | 'uniform';

/**
 * Three-state size for addColorTarget (D-8):
 * - 'swapchain' — matches the output canvas size
 * - 'half-swapchain' — 1/2 the output canvas size (bloom downscale)
 * - { w, h } — fixed pixel dimensions (shadow maps, etc.)
 */
export type ColorTargetSize =
  | 'swapchain'
  | 'half-swapchain'
  | { readonly w: number; readonly h: number };

/**
 * Color target descriptor for addColorTarget (D-8).
 *
 * format: GPU texture format (e.g. 'rgba16float', 'bgra8unorm').
 * size: target dimensions relative to swap-chain or absolute.
 * lifetime: allocation lifetime (default 'transient'); persistent targets keep
 * their physical texture across unchanged compiles and replace it on descriptor drift.
 * sample: multisample count (default 1; MSAA count=4 via #301).
 * usage: GPU texture usage flags (default RENDER_ATTACHMENT | TEXTURE_BINDING).
 * viewFormats: extra GPU texture formats viewable via createTextureView from this
 *   texture; mirrors GPUTextureDescriptor.viewFormats. The LDR MSAA path needs
 *   `bgra8unorm` storage + `bgra8unorm-srgb` view (hardware sRGB encoding on
 *   store), so the consumer pre-declares the alternate format here.
 */
export interface ColorTargetDescriptor {
  readonly format: TextureFormat;
  readonly size: ColorTargetSize;
  readonly lifetime?: ResourceLifetime | undefined;
  readonly sample?: number | undefined;
  readonly usage?: number | undefined;
  readonly viewFormats?: readonly TextureFormat[] | undefined;
  /** Semantic color domain. Omitted only for legacy graphs without domain connections. */
  readonly domain?: ColorValueDomain | undefined;
}

export interface ResolvedColorTargetDescriptor {
  readonly texture: Texture;
  readonly format: TextureFormat;
  readonly size: { readonly width: number; readonly height: number };
  readonly usage: number;
  readonly sample: number;
}

export interface ResourceDescriptor {
  readonly kind: ResourceKind;
  readonly lifetime: ResourceLifetime;
  readonly bufferRole?: BufferRole;
}

/**
 * Opaque handle returned by addColorTarget. Resolved to a TextureView after
 * compile by calling resolve(name) in a pass execute closure.
 */
export type ColorTargetHandle = string;

/**
 * Per-pass resolve context: maps color target names to compiled TextureViews.
 * A pass execute closure receives this alongside the user-provided Ctx.
 */
export interface ResolveContext {
  /** Resolve a color target name to its compiled TextureView, or undefined if not compiled. */
  readonly resolve: (name: string) => unknown;
}

export interface PassDescriptor<Ctx = unknown> {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly execute?: ((ctx: Ctx) => void) | ((ctx: Ctx, resolve: ResolveContext) => void);
  readonly compute?: boolean;
  readonly storageBuffer?: boolean;
  /** Explicit resource-to-resource color-domain edges validated at compile time. */
  readonly colorConnections?: readonly ColorDomainConnection[] | undefined;
}

export interface ComputePassDescriptor<Ctx> {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly storageBuffer?: boolean | undefined;
  readonly begin?: ((frame: Ctx) => RhiComputePassDescriptor) | undefined;
  readonly onBeginError?: ((frame: Ctx, cause: unknown) => void) | undefined;
  readonly after?: ((frame: Ctx) => void) | undefined;
  encode(context: {
    readonly pass: RhiComputePassEncoder;
    readonly frame: Ctx;
    readonly resources: ResolveContext;
  }): void;
}

/** Optional nested observer for per-pass execution attribution. */
export type PassExecuteRunner = (passName: string, action: () => void) => void;

// ── Query types (D-5) ────────────────────────────────────────────

export interface PassInfo {
  readonly name: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

export interface ResourceInfo {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly lifetime: ResourceLifetime;
}

// ── Internalized graph ───────────────────────────────────────────

export interface InternalizedPass {
  readonly name: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

/**
 * RHI buffer binding type a buffer resource resolves to after compile.
 * Mirrors the `@webgpu/types` GPUBufferBindingType subset used by the
 * storage-vs-uniform cap switch (research Finding 7; runtime template
 * `pbr-pipeline.ts` `caps.storageBuffer ? 'read-only-storage' : 'uniform'`).
 */
export type ResolvedBufferType = 'read-only-storage' | 'uniform';

/**
 * Resolved buffer binding for a registered `kind:'buffer'` resource.
 * Produced by compile() per AC-09 / D-6.1: the declarative graph picks the
 * concrete binding type from `caps.storageBuffer`, so a consumer building a
 * bind-group layout reads `resolvedBufferType` instead of duplicating the
 * cap switch.
 */
export interface ResolvedBuffer {
  readonly key: string;
  readonly resolvedBufferType: ResolvedBufferType;
}

export interface InternalizedGraph {
  readonly passes: readonly InternalizedPass[];
  /**
   * Buffer resources resolved to a concrete RHI binding type (AC-09).
   * Empty when the graph declares no `kind:'buffer'` resources.
   */
  readonly resolvedBuffers: readonly ResolvedBuffer[];
  /**
   * Resolved physical texture/view pairs keyed once by resource name.
   * Populated by the compile allocation phase for addColorTarget resources.
   * Empty when no color targets were declared.
   */
  readonly colorTargets: ReadonlyMap<
    string,
    { readonly texture: Texture; readonly view: TextureView }
  >;
}

// ── Compile options ──────────────────────────────────────────────

export interface CompileOptions {
  // D-6: second independent literal union (NOT derived from RhiCaps['backendKind']);
  // add-only '|null' member so passthrough callers forwarding
  // device.caps.backendKind type-check. Deriving from RhiCaps to collapse the
  // duplicate is a known OOS follow-on (architecture-principles #2 Derive).
  readonly backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';
  readonly caps: RhiCaps;
  /**
   * RHI device interface handle for real GPU texture allocation (D-1).
   * Required when the graph has addColorTarget resources; the compile phase
   * calls device.createTexture/createTextureView for each color target.
   */
  readonly device?: RhiDevice | undefined;
}

// ── RenderGraph ──────────────────────────────────────────────────

/**
 * Descriptor key for texture pool lookups (D-2 / D-8 / KB-2).
 * Transient resources with identical descriptors share the same physical
 * texture; drift in any field triggers rebuild.
 * NOTE: stringified form is used as Map key; the interface is for doc only.
 */
// interface _TexturePoolKey { format:string; width:number; height:number; usage:number; sample:number; viewFormats:string[]; }

/** Pooled texture entry shared by transient and persistent allocation paths. */
interface PooledTexture {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly descriptorKey: string;
}

interface StagedColorTargetAllocation {
  readonly colorTargets: InternalizedGraph['colorTargets'];
  readonly transient: ReadonlyMap<string, PooledTexture>;
  readonly persistent: ReadonlyMap<string, PooledTexture>;
}

/** A subset of RhiDevice surface needed by drain() and reclaim to release pooled textures. */
type DrainDevice = Pick<RhiDevice, 'destroyTexture' | 'queue'>;

function poolKey(meta: {
  format: TextureFormat;
  width: number;
  height: number;
  usage: number;
  sample: number;
  viewFormats: readonly TextureFormat[];
}): string {
  return `${meta.format}:${meta.width}x${meta.height}:${meta.usage}:${meta.sample}:${JSON.stringify(meta.viewFormats)}`;
}

/**
 * Runtime projection of the type-only WebGPU GPUTextureFormat union.
 *
 * `TextureFormat` is erased at runtime, but RenderGraph must reject malformed
 * declarations before it calls an RHI device. Keep this ordered vocabulary as
 * the single runtime validation authority; backend capability or usage refusal
 * remains a `resource-alloc-failed` result after this syntax gate.
 */
const VALID_GPU_TEXTURE_FORMATS = [
  'r8unorm',
  'r8snorm',
  'r8uint',
  'r8sint',
  'r16unorm',
  'r16snorm',
  'r16uint',
  'r16sint',
  'r16float',
  'rg8unorm',
  'rg8snorm',
  'rg8uint',
  'rg8sint',
  'r32uint',
  'r32sint',
  'r32float',
  'rg16unorm',
  'rg16snorm',
  'rg16uint',
  'rg16sint',
  'rg16float',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rgba8snorm',
  'rgba8uint',
  'rgba8sint',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'rgb9e5ufloat',
  'rgb10a2uint',
  'rgb10a2unorm',
  'rg11b10ufloat',
  'rg32uint',
  'rg32sint',
  'rg32float',
  'rgba16unorm',
  'rgba16snorm',
  'rgba16uint',
  'rgba16sint',
  'rgba16float',
  'rgba32uint',
  'rgba32sint',
  'rgba32float',
  'stencil8',
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
  'depth32float-stencil8',
  'bc1-rgba-unorm',
  'bc1-rgba-unorm-srgb',
  'bc2-rgba-unorm',
  'bc2-rgba-unorm-srgb',
  'bc3-rgba-unorm',
  'bc3-rgba-unorm-srgb',
  'bc4-r-unorm',
  'bc4-r-snorm',
  'bc5-rg-unorm',
  'bc5-rg-snorm',
  'bc6h-rgb-ufloat',
  'bc6h-rgb-float',
  'bc7-rgba-unorm',
  'bc7-rgba-unorm-srgb',
  'etc2-rgb8unorm',
  'etc2-rgb8unorm-srgb',
  'etc2-rgb8a1unorm',
  'etc2-rgb8a1unorm-srgb',
  'etc2-rgba8unorm',
  'etc2-rgba8unorm-srgb',
  'eac-r11unorm',
  'eac-r11snorm',
  'eac-rg11unorm',
  'eac-rg11snorm',
  'astc-4x4-unorm',
  'astc-4x4-unorm-srgb',
  'astc-5x4-unorm',
  'astc-5x4-unorm-srgb',
  'astc-5x5-unorm',
  'astc-5x5-unorm-srgb',
  'astc-6x5-unorm',
  'astc-6x5-unorm-srgb',
  'astc-6x6-unorm',
  'astc-6x6-unorm-srgb',
  'astc-8x5-unorm',
  'astc-8x5-unorm-srgb',
  'astc-8x6-unorm',
  'astc-8x6-unorm-srgb',
  'astc-8x8-unorm',
  'astc-8x8-unorm-srgb',
  'astc-10x5-unorm',
  'astc-10x5-unorm-srgb',
  'astc-10x6-unorm',
  'astc-10x6-unorm-srgb',
  'astc-10x8-unorm',
  'astc-10x8-unorm-srgb',
  'astc-10x10-unorm',
  'astc-10x10-unorm-srgb',
  'astc-12x10-unorm',
  'astc-12x10-unorm-srgb',
  'astc-12x12-unorm',
  'astc-12x12-unorm-srgb',
] as const satisfies readonly TextureFormat[];

const VALID_GPU_TEXTURE_FORMAT_SET: ReadonlySet<string> = new Set(VALID_GPU_TEXTURE_FORMATS);

export class RenderGraph<Ctx = unknown> {
  private readonly resources = new ResourceRegistry();
  private readonly passes = new PassRegistry<Ctx>();
  private compiled: InternalizedGraph | null = null;

  /** Transient texture pool: keyed by descriptor, reused across compiles (D-2). */
  private readonly transientPool = new Map<string, PooledTexture>();
  /**
   * Pending-destroy queue (bug-20260622): replaced textures awaiting GPU
   * retirement before actual device.destroyTexture. drainTransient(),
   * setTransientEntry(), and setPersistentEntry() push here instead of destroying immediately;
   * reclaimRetiredTransients() (called post-queue.submit in recordFrame) drains
   * the queue when the GPU signals onSubmittedWorkDone.
   */
  private readonly pendingDestroy: PooledTexture[] = [];
  /** Persistent textures: keyed by resource name, kept across compiles. */
  private readonly persistentTextures = new Map<string, PooledTexture>();
  /** Swap-chain size for resolving 'swapchain' / 'half-swapchain' sizes. */
  private swapChainWidth = 800;
  private swapChainHeight = 600;
  /** Last compile-time swap-chain size; diff triggers recompile-invalidation. */
  private compiledWidth = 800;
  private compiledHeight = 600;
  /**
   * feat-20260612 M-4 / w15: device reference stashed at compile-time so
   * drain() can release pooled textures via device.destroyTexture without
   * a separate parameter. Set by compile(); null until the first compile.
   * Render-graph stays RHI-pure (no runtime dep): the destroy bookkeeping
   * SSOT is the RHI shim, exactly as GpuTexture.destroy() routes through it.
   */
  private lastDevice: DrainDevice | null = null;

  /**
   * Set the current swap-chain dimensions (w7).
   * The compile allocation phase uses this to resolve 'swapchain' and
   * 'half-swapchain' size specifiers. Returns true when dimensions differ
   * from the last compile, signalling that a recompile is needed.
   */
  setSwapChainSize(width: number, height: number): boolean {
    this.swapChainWidth = width;
    this.swapChainHeight = height;
    if (width !== this.compiledWidth || height !== this.compiledHeight) {
      return true;
    }
    return false;
  }

  /**
   * w7: resolve a color-target name to its compiled TextureView.
   * Returns the GPU view after compile, or undefined if not yet compiled
   * or the name was not registered via addColorTarget.
   */
  getColorTargetView(name: string): unknown {
    return this.compiled?.colorTargets.get(name)?.view;
  }

  /**
   * w7: resolve a color-target name to its compiled GPU Texture handle.
   * Returns the texture after compile, or undefined if not yet compiled.
   */
  getColorTargetTexture(name: string): unknown {
    return this.compiled?.colorTargets.get(name)?.texture;
  }

  getColorTargetDescriptor(name: string): ResolvedColorTargetDescriptor | undefined {
    const meta = this.resources.getColorTargetMeta(name);
    const texture = this.compiled?.colorTargets.get(name)?.texture;
    if (meta === undefined || texture === undefined) return undefined;
    return {
      texture,
      format: meta.format,
      size: {
        width: this.resolveWidth(meta.size),
        height: this.resolveHeight(meta.size),
      },
      usage: meta.usage,
      sample: meta.sample,
    };
  }

  /**
   * Declare a color target alias: both names share the same physical texture.
   * The source must already be registered via addColorTarget.
   * Used for hdrComposited -> hdrColor folding (KB-1 / D-2). The returned
   * Result contains the opaque alias handle or a duplicate-resource error.
   */
  addColorTargetAlias(name: string, source: string): Result<ColorTargetHandle, RenderGraphError> {
    const result = this.resources.addColorTargetAlias(name, source);
    if (!result.ok) return result;
    return ok(name);
  }

  addResource(
    key: string,
    descriptor: ResourceDescriptor,
  ): Result<ResourceEntry, RenderGraphError> {
    return this.resources.add(key, descriptor);
  }

  /**
   * Declare a color target resource that the compiler will allocate as a
   * transient or persistent GPU texture (D-1 / D-8). A successful Result
   * contains an opaque string handle that can be referenced in pass read/write
   * arrays and resolved to a TextureView via resolve(name) inside a pass
   * execute closure. A duplicate key is rejected before registry publication.
   *
   * Omitted lifetime preserves the default `transient`; `persistent` retains
   * identity across unchanged compiles and replaces on descriptor drift.
   * format/size/sample/usage are stored on the resource entry for the compile
   * allocation phase (w6).
   */
  addColorTarget(
    name: string,
    desc: ColorTargetDescriptor,
  ): Result<ColorTargetHandle, RenderGraphError> {
    const result = this.resources.addColorTarget(name, desc);
    if (!result.ok) return result;
    return ok(name);
  }

  addPass(name: string, descriptor: PassDescriptor<Ctx>): PassEntry<Ctx> {
    return this.passes.add(name, descriptor);
  }

  /** @internal Renderer composition seam for declaring feature work at its semantic target. */
  _addPassBefore(name: string, before: string, descriptor: PassDescriptor<Ctx>): PassEntry<Ctx> {
    return this.passes.add(name, descriptor, before);
  }

  addComputePass(name: string, descriptor: ComputePassDescriptor<Ctx>): PassEntry<Ctx> {
    return this.addComputePassAt(name, descriptor);
  }

  /** @internal Renderer composition seam for declaring feature work at its semantic target. */
  _addComputePassBefore(
    name: string,
    before: string,
    descriptor: ComputePassDescriptor<Ctx>,
  ): PassEntry<Ctx> {
    return this.addComputePassAt(name, descriptor, before);
  }

  private addComputePassAt(
    name: string,
    descriptor: ComputePassDescriptor<Ctx>,
    before?: string,
  ): PassEntry<Ctx> {
    return this.passes.add(
      name,
      {
        reads: descriptor.reads,
        writes: descriptor.writes,
        compute: true,
        storageBuffer: descriptor.storageBuffer ?? true,
        execute: (frame: Ctx, resources: ResolveContext) => {
          const encoder = (
            frame as Ctx & { readonly encoder: import('@forgeax/engine-rhi').RhiCommandEncoder }
          ).encoder;
          const begin = descriptor.begin?.(frame);
          let pass: RhiComputePassEncoder;
          try {
            pass = encoder.beginComputePass({
              label: name,
              ...(begin?.timestampWrites === undefined
                ? {}
                : { timestampWrites: begin.timestampWrites }),
            });
          } catch (cause) {
            descriptor.onBeginError?.(frame, cause);
            return;
          }
          try {
            descriptor.encode({ pass, frame, resources });
          } finally {
            pass.end();
          }
          descriptor.after?.(frame);
        },
      },
      before,
    );
  }

  /**
   * Validate a producer-scoped current-frame texture without exposing graph
   * resource names through the observation lease.
   */
  createCurrentFrameObservationLease(
    descriptor: CurrentFrameObservationDescriptor,
    currentFrameId: number,
  ): Result<CurrentFrameObservationLease, RenderGraphError> {
    return createCurrentFrameObservationLease(descriptor, currentFrameId);
  }

  /**
   * Compile the graph into an internalized form.
   *
   * Phases (plan-strategy 3.1):
   * 1. Cap-gate fail-fast
   * 2. Unknown-resource fail-fast (every pass read/write key is registered)
   * 3. Dangling-read fail-fast
   * 4. Preserve declaration order as the temporal authority
   * 5. Buffer-role resolution (AC-09 / D-6.1)
   * 6. GPU allocation for color targets (D-1) — when device is provided and the
   *    graph has addColorTarget resources, allocate textures via
   *    device.createTexture/createTextureView. Errors surface as
   *    'resource-alloc-failed' or 'invalid-format'.
   */
  compile(opts: CompileOptions): Result<InternalizedGraph, RenderGraphError> {
    const passList = this.passes.list();
    const { caps, device } = opts;

    const capErr = this.validateCaps(passList, caps);
    if (capErr) return capErr;

    const colorDomainErr = this.validateColorDomains(passList);
    if (colorDomainErr) return colorDomainErr;

    const unknownErr = this.validateNoUnknownResource(passList);
    if (unknownErr) return unknownErr;

    const danglingErr = this.validateNoDanglingRead(passList);
    if (danglingErr) return danglingErr;

    const formatErr = this.validateColorTargetFormats();
    if (!formatErr.ok) return formatErr;

    const internalizedPasses: InternalizedPass[] = passList.map((pass) => {
      return {
        name: pass.name,
        reads: pass.descriptor.reads,
        writes: pass.descriptor.writes,
      };
    });

    const resolvedBuffers = this.resolveBuffers(caps);

    // Phase 7: GPU allocation for color targets (D-1).
    const resizeDetected =
      this.swapChainWidth !== this.compiledWidth || this.swapChainHeight !== this.compiledHeight;
    const allocatedTextures = this.allocateColorTargets(device, resizeDetected);
    if (!allocatedTextures.ok) return allocatedTextures;

    // Phase 6.5: resize drain (AC-09, plan-strategy D-4). Defer the drain
    // until allocation succeeds so a refused compile leaves the active graph
    // and its pool untouched for a retry.
    if (resizeDetected) {
      this.drainTransient();
    }

    for (const [key, pooled] of allocatedTextures.value.transient) {
      this.setTransientEntry(key, pooled);
    }
    for (const [key, pooled] of allocatedTextures.value.persistent) {
      this.setPersistentEntry(key, pooled);
    }

    this.compiled = {
      passes: internalizedPasses,
      resolvedBuffers,
      colorTargets: allocatedTextures.value.colorTargets,
    };
    this.compiledWidth = this.swapChainWidth;
    this.compiledHeight = this.swapChainHeight;
    if (device !== undefined) {
      this.lastDevice = device;
    }
    return ok(this.compiled);
  }

  /**
   * feat-20260612 M-4 / w15: release every pooled GPU texture and clear
   * the pools.
   *
   * Walks `transientPool` + `persistentTextures`, forwarding each
   * `PooledTexture.texture` opaque handle to `device.destroyTexture(...)`,
   * then clears both Maps. The destroy bookkeeping SSOT is the RHI shim
   * (architecture-principles §1 SSOT: same path GpuTexture.destroy()
   * uses); render-graph stays RHI-pure (no runtime dep).
   *
   * Plan-strategy D-7: drain covers the dispose exit path (`Renderer.dispose()`);
   * descriptor-drift replacement during compile is fenced through
   * `pendingDestroy` and `reclaimRetiredTransients()`.
   *
   * Idempotent (architecture-principles §6): a second drain on cleared
   * Maps is a no-op. drain() before any compile is also a safe no-op.
   * Per-handle errors from the RHI shim (e.g. 'destroy-after-destroy'
   * on a stale handle) are tolerated so the dispose chain can make
   * progress (mirrors gpuStore.destroyAll's swallow-and-continue
   * policy; plan-strategy D-3 / D-8). The structured error stays
   * available on the device handle for future inspector hooks.
   */
  drain(): void {
    const device = this.lastDevice;
    if (device === null) {
      this.transientPool.clear();
      this.persistentTextures.clear();
      this.pendingDestroy.length = 0;
      return;
    }
    for (const pooled of this.transientPool.values()) {
      try {
        device.destroyTexture(pooled.texture);
      } catch {
        // swallow-and-continue: per-handle destroy failures do not
        // interrupt the drain chain (docstring tolerance contract).
      }
    }
    this.transientPool.clear();
    // bug-20260622 D-6: drain teardown path — destroy any pendingDestroy
    // items left over (Renderer.dispose() has no in-flight frames).
    for (const pooled of this.pendingDestroy) {
      try {
        device.destroyTexture(pooled.texture);
      } catch {
        // swallow-and-continue: per-handle destroy failures do not
        // interrupt the drain chain (docstring tolerance contract).
      }
    }
    this.pendingDestroy.length = 0;
    for (const pooled of this.persistentTextures.values()) {
      try {
        device.destroyTexture(pooled.texture);
      } catch {
        // swallow-and-continue: per-handle destroy failures do not
        // interrupt the drain chain (docstring tolerance contract).
      }
    }
    this.persistentTextures.clear();
  }

  /**
   * Relinquish every texture owned by this graph after its last frame has
   * been submitted. Unlike {@link drain}, this does not synchronously destroy
   * GPU resources: they join `pendingDestroy` and are released by
   * `reclaimRetiredTransients()` only after `onSubmittedWorkDone` resolves.
   *
   * A retired graph is no longer executable. Runtime replaces a memoized
   * per-frame graph through this entry when topology changes (rather than
   * dropping the graph and its pools), while `drain()` remains the teardown
   * path where immediate destruction is safe.
   */
  retire(): void {
    const device = this.lastDevice;
    if (device === null) {
      this.transientPool.clear();
      this.persistentTextures.clear();
      this.pendingDestroy.length = 0;
      this.compiled = null;
      return;
    }
    for (const pooled of this.transientPool.values()) {
      this.pendingDestroy.push(pooled);
    }
    this.transientPool.clear();
    for (const pooled of this.persistentTextures.values()) {
      this.pendingDestroy.push(pooled);
    }
    this.persistentTextures.clear();
    this.compiled = null;
  }

  /**
   * Release every transient-pool texture while keeping persistentTextures
   * intact (AC-09: resize drain, plan-strategy D-4).
   *
   * Walks `transientPool` values and forwards each `PooledTexture.texture`
   * opaque handle to `device.destroyTexture(...)`, then clears the transient
   * pool. Mirror of `drain()` but scoped to the transient pool only.
   *
   * Persistent textures survive `drainTransient` — they are only released by
   * the full `drain()` on teardown. `drainTransient` is an internal helper
   * called by `compile()` when swap-chain size changes; it is NOT a public API
   * (callers should use `drain()` for teardown).
   *
   * Idempotent (architecture-principles §6): a second drainTransient on an
   * already-cleared transient pool is a no-op.
   */
  private drainTransient(): void {
    const device = this.lastDevice;
    if (device === null) {
      this.transientPool.clear();
      return;
    }
    // bug-20260622 D-1: push old transient textures into pendingDestroy
    // queue instead of destroying immediately. The GPU may still hold
    // references from a prior in-flight command buffer.
    for (const pooled of this.transientPool.values()) {
      this.pendingDestroy.push(pooled);
    }
    this.transientPool.clear();
  }

  /**
   * Guarded transient pool insert (AC-08, plan-strategy D-4).
   *
   * Before overwriting a key in the transient pool, destroys the old pooled
   * texture via `device.destroyTexture(...)` to prevent stranded GPU textures.
   * The guard is defensive: in current production code flow this code path is
   * unreachable (set() only follows a get() miss inside allocateColorTargets),
   * but the single-line guard costs almost nothing and closes the symmetry gap
   * (every GPU resource allocation has a paired destroy).
   *
   * When `lastDevice` is null (no device ever stashed), the old entry is
   * silently dropped without destroy (mirrors drainTransient's null-device
   * fast path).
   */
  private setTransientEntry(key: string, pooled: PooledTexture): void {
    const old = this.transientPool.get(key);
    if (old) {
      // bug-20260622 D-1: push into pendingDestroy queue instead of
      // destroying immediately — the old texture may still be referenced
      // by an in-flight command buffer.
      this.pendingDestroy.push(old);
    }
    this.transientPool.set(key, pooled);
  }

  /**
   * Publish a persistent replacement only after a complete allocation succeeds.
   * The old handle remains fenced until the GPU retires work that may still
   * reference it, just like a transient replacement.
   */
  private setPersistentEntry(key: string, pooled: PooledTexture): void {
    const old = this.persistentTextures.get(key);
    if (old && old.texture !== pooled.texture) {
      this.pendingDestroy.push(old);
    }
    this.persistentTextures.set(key, pooled);
  }

  /**
   * bug-20260622 D-2: reclaim pool textures queued in pendingDestroy after
   * the GPU has retired all prior command buffers.
   *
   * Takes a snapshot of pendingDestroy, then calls
   * `lastDevice.queue.onSubmittedWorkDone()`. When the promise resolves,
   * the snapshot items are actually destroyed via
   * `device.destroyTexture(...)` and removed from the queue.
   *
   * Idempotent (architecture-principles D-4): a second reclaim on an
   * already-drained pendingDestroy is a no-op. When lastDevice is null
   * (no device ever stashed), pendingDestroy is cleared directly.
   *
   * Per-handle destroy errors are tolerated (swallow-and-continue,
   * plan-strategy D-5) — a stale-handle destroy-after-destroy does not
   * interrupt the reclaim chain.
   */
  async reclaimRetiredTransients(): Promise<void> {
    const device = this.lastDevice;
    if (device === null) {
      this.pendingDestroy.length = 0;
      return;
    }
    if (this.pendingDestroy.length === 0) return;

    // Snapshot the queue; items added after this point are handled by the
    // next reclaim call (D-4: no race with concurrent push from same-frame
    // drainTransient).
    const snapshot = this.pendingDestroy.splice(0);

    // Wait for all prior GPU work to complete.
    await device.queue.onSubmittedWorkDone();

    // Destroy snapshot items.
    for (const pooled of snapshot) {
      try {
        device.destroyTexture(pooled.texture);
      } catch {
        // swallow-and-continue: per-handle destroy errors are tolerated
        // (docstring contract) — a stale handle does not interrupt the
        // reclaim chain for subsequent items.
      }
    }
  }

  /**
   * Drop the pendingDestroy queue WITHOUT calling device.destroyTexture
   * (feat-20260622-s5 M3 / B-2 / B-AC-02).
   *
   * Used on the device-lost recover() rebuild path: the queue holds
   * PooledTexture handles minted against the now-lost device, so calling
   * destroyTexture on them against the freshly-rebuilt device is meaningless
   * (the old GPUDevice owns them; spec retires its resources implicitly when
   * it is lost). recover() calls this after `gpuStore.destroyAll()` and before
   * `tryCreateWebGPURenderer` so no stale handle reaches the new device.
   *
   * device-lost is an upstream judgement (createRenderer's health state); the
   * graph stays RHI-pure and takes no device parameter — it only exposes the
   * clear entry. Same effect as the existing null-device fast paths in drain()
   * / reclaimRetiredTransients() (`pendingDestroy.length = 0`), surfaced as a
   * method recover() can call directly. Idempotent: a second call on an
   * already-empty queue is a no-op.
   */
  clearPendingDestroy(): void {
    this.pendingDestroy.length = 0;
  }

  /**
   * Execute the compiled graph in declaration order, calling
   * each pass's execute closure with the provided context. Passes without an
   * execute closure are silently skipped.
   */
  execute(ctx: Ctx, runPass?: PassExecuteRunner): void {
    const compiled = this.compiled;
    if (!compiled) return;
    const resolveCtx: ResolveContext = {
      resolve: (name: string) =>
        name.endsWith('::tex')
          ? compiled.colorTargets.get(name.slice(0, -5))?.texture
          : compiled.colorTargets.get(name)?.view,
    };
    const passList = this.passes.list();
    const passByName = new Map<string, PassEntry<Ctx>>(passList.map((p) => [p.name, p]));
    for (const internalPass of compiled.passes) {
      const entry = passByName.get(internalPass.name);
      const execute = entry?.descriptor.execute;
      if (execute) {
        if (runPass === undefined) {
          (execute as (ctx: Ctx, resolve: ResolveContext) => void)(ctx, resolveCtx);
        } else {
          runPass(internalPass.name, () =>
            (execute as (ctx: Ctx, resolve: ResolveContext) => void)(ctx, resolveCtx),
          );
        }
      }
    }
  }

  listPasses(): readonly PassInfo[] {
    return this.passes.list().map((p) => ({
      name: p.name,
      reads: p.descriptor.reads,
      writes: p.descriptor.writes,
    }));
  }

  listResources(): readonly ResourceInfo[] {
    const result: ResourceInfo[] = [];
    for (const entry of this.resources.entries()) {
      result.push({
        key: entry.key,
        kind: entry.descriptor.kind,
        lifetime: entry.descriptor.lifetime,
      });
    }
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────

  private validateCaps(
    passList: readonly PassEntry<Ctx>[],
    caps: RhiCaps,
  ): Result<never, RenderGraphError> | null {
    for (const pass of passList) {
      const { name, descriptor } = pass;

      if (descriptor.compute && !caps.compute) {
        return err(
          new RenderGraphError({
            code: 'cap-missing',
            expected: `pass '${name}' is a compute pass but caps.compute is false`,
            hint: 'use a render pass path or enable compute on the backend',
            detail: { cap: 'compute', passName: name } satisfies CapMissingDetail,
          }),
        );
      }

      if (descriptor.storageBuffer && !caps.storageBuffer) {
        return err(
          new RenderGraphError({
            code: 'cap-missing',
            expected: `pass '${name}' requires storage buffer but caps.storageBuffer is false`,
            hint: 'switch to uniform buffer or enable storageBuffer on the backend',
            detail: {
              cap: 'storageBuffer',
              passName: name,
            } satisfies CapMissingDetail,
          }),
        );
      }
    }
    return null;
  }

  private validateColorDomains(
    passList: readonly PassEntry<Ctx>[],
  ): Result<never, RenderGraphError> | null {
    for (const pass of passList) {
      for (const connection of pass.descriptor.colorConnections ?? []) {
        const source = this.resources.get(connection.source)?.colorTarget?.domain;
        const destination = this.resources.get(connection.destination)?.colorTarget?.domain;
        const validation = validateColorDomainConnection(
          source,
          destination,
          connection.conversion,
        );
        if (!validation.ok) return err(validation.error);
      }
    }
    return null;
  }

  private validateNoUnknownResource(
    passList: readonly PassEntry<Ctx>[],
  ): Result<never, RenderGraphError> | null {
    for (const pass of passList) {
      for (const key of [...pass.descriptor.reads, ...pass.descriptor.writes]) {
        // Built-in reserved key 'swapchain' (feat-20260609 framebuffers demo
        // M5 / T-12-a): the swap-chain output is not a graph-allocated
        // resource; passes that write to 'swapchain' surface their writeView
        // through the resolveCtx fallback (`resolveCtx.resolve('swapchain')`
        // returns undefined -> the dispatcher falls back to `ctx.view`, the
        // current swap-chain view). Allowed in `writes` (a fullscreen pass
        // outputs to the swap-chain) and in `reads` (a future pass that
        // samples the swap-chain via copyTextureToTexture). The graph never
        // allocates, owns, or aliases this resource — it is purely an
        // ordering/contract token.
        if (key === 'swapchain') continue;
        if (!this.resources.has(key)) {
          return err(
            new RenderGraphError({
              code: 'unknown-resource',
              expected: `pass '${pass.name}' references resource key '${key}' but it is not registered`,
              hint: `call addResource('${key}', ...) before compile, or remove '${key}' from pass '${pass.name}'`,
              detail: {
                resourceKey: key,
                passName: pass.name,
              } satisfies DanglingReadDetail,
            }),
          );
        }
      }
    }
    return null;
  }

  /**
   * Resolve every registered `kind:'buffer'` resource to a concrete RHI
   * binding type (AC-09 / D-6.1). `bufferRole='auto-storage-or-uniform'`
   * (the default when unset) picks `'read-only-storage'` when the backend
   * advertises `caps.storageBuffer`, else falls back to `'uniform'`;
   * `bufferRole='uniform'` is always `'uniform'`. Mirrors the runtime
   * `pbr-pipeline.ts` cap switch (research Finding 7), expressed here in the
   * RHI-pure graph layer so consumers never duplicate the branch.
   */
  private resolveBuffers(caps: RhiCaps): ResolvedBuffer[] {
    const resolved: ResolvedBuffer[] = [];
    for (const entry of this.resources.entries()) {
      if (entry.descriptor.kind !== 'buffer') continue;
      const role = entry.descriptor.bufferRole ?? 'auto-storage-or-uniform';
      const resolvedBufferType: ResolvedBufferType =
        role === 'uniform' ? 'uniform' : caps.storageBuffer ? 'read-only-storage' : 'uniform';
      resolved.push({ key: entry.key, resolvedBufferType });
    }
    return resolved;
  }

  private validateColorTargetFormats(): Result<undefined, RenderGraphError> {
    for (const entry of this.resources.entries()) {
      const meta = entry.colorTarget;
      if (!meta || VALID_GPU_TEXTURE_FORMAT_SET.has(meta.format)) continue;

      return err(
        new RenderGraphError({
          code: 'invalid-format',
          expected: `addColorTarget format must be a valid GPU texture format; received '${meta.format}'`,
          hint: `replace '${meta.format}' with one of detail.expected before recompiling`,
          detail: {
            resourceKey: entry.key,
            format: meta.format,
            expected: VALID_GPU_TEXTURE_FORMATS,
          },
        }),
      );
    }
    return ok(undefined);
  }

  /**
   * Phase 7: allocate GPU textures for registered color targets (D-1 / D-2).
   *
   * For each addColorTarget resource, resolves the concrete size from the
   * ColorTargetSize descriptor and swapChainSize, then looks up the transient
   * pool by descriptor key. Pool hit reuses the same physical texture/view;
   * pool miss (drift) triggers device.createTexture/createTextureView rebuild.
   *
   * Alias targets (addColorTargetAlias) fold into the source's physical texture
   * (KB-1 MoveNode pattern). Persistent targets are retained across compiles
   * with size-drift rebuild.
   *
   * device === undefined is a no-op (returns an empty map).
   * Allocation is transactional: newly created textures are destroyed on any
   * failure, and pool mutations are committed only after every target succeeds.
   */
  private allocateColorTargets(
    device: RhiDevice | undefined,
    invalidateTransientPool = false,
  ): Result<StagedColorTargetAllocation, RenderGraphError> {
    const result = new Map<string, { readonly texture: Texture; readonly view: TextureView }>();
    if (
      !device ||
      typeof (device as unknown as Record<string, unknown>).createTexture !== 'function'
    )
      return ok({ colorTargets: result, transient: new Map(), persistent: new Map() });

    const stagedTransient = new Map<string, PooledTexture>();
    const stagedPersistent = new Map<string, PooledTexture>();
    const stagedAllocations: PooledTexture[] = [];
    const discardStaged = (): void => {
      for (const pooled of stagedAllocations) {
        try {
          device.destroyTexture(pooled.texture);
        } catch {
          // A cleanup failure must not hide the allocation error.
        }
      }
    };

    for (const entry of this.resources.entries()) {
      const meta = entry.colorTarget;
      if (!meta) continue;

      // Resolve alias: fold to source physical texture.
      if (entry.aliasedFrom !== undefined) {
        const source = result.get(entry.aliasedFrom);
        if (source === undefined) {
          discardStaged();
          return err(
            new RenderGraphError({
              code: 'alias-source-missing',
              expected: `alias '${entry.key}' source '${entry.aliasedFrom}' must resolve to a compiled color target`,
              hint: `register color target '${entry.aliasedFrom}' before compiling alias '${entry.key}'`,
              detail: {
                aliasKey: entry.key,
                sourceKey: entry.aliasedFrom,
              } satisfies AliasSourceDetail,
            }),
          );
        }
        result.set(entry.key, source);
        continue;
      }

      const width = this.resolveWidth(meta.size);
      const height = this.resolveHeight(meta.size);
      const lifetime = entry.descriptor.lifetime;

      // feat-20260612-hdrp-ssao M9 scope-amendment (M8 graph barrier):
      // Include the resource name in the transient pool key. Without this,
      // two simultaneously-active transient color targets with identical
      // descriptors (e.g. two r8unorm half-swapchain color targets with the same usage,
      // RENDER_ATTACHMENT|TEXTURE_BINDING) share the same GPU texture. When
      // one pass writes and the next pass both writes (color attachment) and
      // reads (texture binding from the same view), WebGPU rejects the command
      // buffer: "TextureBinding|RenderAttachment in the same synchronization
      // scope."
      const descriptorKey = poolKey({
        format: meta.format,
        width,
        height,
        usage: meta.usage,
        sample: meta.sample,
        viewFormats: meta.viewFormats ?? [],
      });
      const key = `${entry.key}:${descriptorKey}`;

      const candidate =
        lifetime === 'transient'
          ? invalidateTransientPool
            ? undefined
            : this.transientPool.get(key)
          : this.persistentTextures.get(entry.key);
      if (candidate?.descriptorKey === descriptorKey) {
        result.set(entry.key, candidate);
        continue;
      }

      // Pool miss or persistent fresh allocation: create new texture.
      const texResult = device.createTexture({
        label: entry.key,
        size: { width, height, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: meta.sample,
        dimension: '2d',
        format: meta.format,
        usage: meta.usage,
        viewFormats: meta.viewFormats ?? [],
      } as never);

      if (!texResult.ok) {
        discardStaged();
        return err(
          new RenderGraphError({
            code: 'resource-alloc-failed',
            expected: `device.createTexture must succeed for color target '${entry.key}'`,
            hint: `retry after recovering the RHI allocation failure for '${entry.key}'`,
            detail: {
              resourceKey: entry.key,
              rhiCode: texResult.error.code,
            },
          }),
        );
      }

      const viewResult = device.createTextureView(texResult.value, {});
      if (!viewResult.ok) {
        try {
          device.destroyTexture(texResult.value);
        } catch {
          // A cleanup failure must not hide the allocation error.
        }
        discardStaged();
        return err(
          new RenderGraphError({
            code: 'resource-alloc-failed',
            expected: `device.createTextureView must succeed for color target '${entry.key}'`,
            hint: `retry after recovering the RHI view allocation failure for '${entry.key}'`,
            detail: {
              resourceKey: entry.key,
              rhiCode: viewResult.error.code,
            },
          }),
        );
      }

      const pooled: PooledTexture = {
        texture: texResult.value,
        view: viewResult.value,
        descriptorKey,
      };
      stagedAllocations.push(pooled);

      if (lifetime === 'transient') {
        stagedTransient.set(key, pooled);
      } else {
        stagedPersistent.set(entry.key, pooled);
      }

      result.set(entry.key, pooled);
    }

    return ok({
      colorTargets: result,
      transient: stagedTransient,
      persistent: stagedPersistent,
    });
  }

  private resolveWidth(size: ColorTargetDescriptor['size']): number {
    if (typeof size === 'string') {
      return size === 'half-swapchain' ? Math.ceil(this.swapChainWidth / 2) : this.swapChainWidth;
    }
    return size.w;
  }

  private resolveHeight(size: ColorTargetDescriptor['size']): number {
    if (typeof size === 'string') {
      return size === 'half-swapchain' ? Math.ceil(this.swapChainHeight / 2) : this.swapChainHeight;
    }
    return size.h;
  }

  private validateNoDanglingRead(
    passList: readonly PassEntry<Ctx>[],
  ): Result<never, RenderGraphError> | null {
    const writers = new Set<string>();
    for (const pass of passList) {
      for (const key of pass.descriptor.reads) {
        const imported = this.resources.get(key)?.descriptor.lifetime === 'persistent';
        if (key !== 'swapchain' && !imported && !writers.has(key)) {
          return err(
            new RenderGraphError({
              code: 'dangling-read',
              expected: `pass '${pass.name}' reads key '${key}' but no pass writes it`,
              hint: `add a pass that writes '${key}', or remove '${key}' from pass '${pass.name}' reads`,
              detail: {
                resourceKey: key,
                passName: pass.name,
              } satisfies DanglingReadDetail,
            }),
          );
        }
      }
      for (const key of pass.descriptor.writes) writers.add(key);
    }
    return null;
  }
}
