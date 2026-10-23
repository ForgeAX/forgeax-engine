/// <reference types="@webgpu/types" />
// WebGPU stub — a no-op browser `GPU` that reports a captured adapter profile.
//
// `installWebGpuStub(profile)` replaces `navigator.gpu` and the `'webgpu'`
// canvas context of the calling realm. Every Engine consumer keeps its normal
// ambient WebGPU path (`backendKind: 'webgpu'`, the same caps/features/limits as
// the profiled device), but no GPU work, Dawn validation or software
// rasterization happens: submissions complete immediately and mapped ranges are
// zero-filled. Use it to observe CPU-side engine/game cost on hosts without a
// usable GPU, or to isolate CPU cost on a GPU host. It is never pixel, GPU-time
// or FPS acceptance evidence.

/** Structured-cloneable adapter facts the stub reports. */
export interface WebGpuStubProfile {
  /** Provenance label recorded by diagnostics. */
  readonly name: string;
  readonly preferredCanvasFormat: GPUTextureFormat;
  readonly wgslLanguageFeatures: readonly string[];
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly info: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
    readonly subgroupMinSize?: number;
    readonly subgroupMaxSize?: number;
  };
}

/**
 * Default profile: Chrome 155 headless on an Apple M4 Pro (Metal 3), captured
 * with `captureWebGpuStubProfile(navigator.gpu)` on 2026-10-22.
 */
export const DEFAULT_WEBGPU_STUB_PROFILE: WebGpuStubProfile = {
  name: 'apple-metal3-chrome155',
  preferredCanvasFormat: 'bgra8unorm',
  wgslLanguageFeatures: [
    'buffer_view',
    'immediate_address_space',
    'linear_indexing',
    'packed_4x8_integer_dot_product',
    'pointer_composite_access',
    'readonly_and_readwrite_storage_textures',
    'subgroup_id',
    'subgroup_uniformity',
    'swizzle_assignment',
    'texture_and_sampler_let',
    'texture_formats_tier1',
    'uniform_buffer_standard_layout',
    'unrestricted_pointer_parameters',
  ],
  features: [
    'bgra8unorm-storage',
    'clip-distances',
    'core-features-and-limits',
    'depth-clip-control',
    'depth32float-stencil8',
    'dual-source-blending',
    'float32-blendable',
    'float32-filterable',
    'indirect-first-instance',
    'primitive-index',
    'rg11b10ufloat-renderable',
    'shader-f16',
    'subgroup-size-control',
    'subgroups',
    'texture-component-swizzle',
    'texture-compression-astc',
    'texture-compression-astc-sliced-3d',
    'texture-compression-bc',
    'texture-compression-bc-sliced-3d',
    'texture-compression-etc2',
    'texture-formats-tier1',
    'texture-formats-tier2',
    'timestamp-query',
  ],
  limits: {
    maxTextureDimension1D: 16384,
    maxTextureDimension2D: 16384,
    maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 2048,
    maxBindGroups: 4,
    maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000,
    maxDynamicUniformBuffersPerPipelineLayout: 10,
    maxDynamicStorageBuffersPerPipelineLayout: 8,
    maxSampledTexturesPerShaderStage: 48,
    maxSamplersPerShaderStage: 16,
    maxStorageBuffersPerShaderStage: 10,
    maxStorageTexturesPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 4294967292,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    maxVertexBuffers: 8,
    maxBufferSize: 4294967292,
    maxVertexAttributes: 30,
    maxVertexBufferArrayStride: 2048,
    maxInterStageShaderVariables: 28,
    maxColorAttachments: 8,
    maxColorAttachmentBytesPerSample: 128,
    maxComputeWorkgroupStorageSize: 32768,
    maxComputeInvocationsPerWorkgroup: 1024,
    maxComputeWorkgroupSizeX: 1024,
    maxComputeWorkgroupSizeY: 1024,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535,
    maxImmediateSize: 64,
    maxStorageBuffersInFragmentStage: 10,
    maxStorageTexturesInFragmentStage: 8,
    maxStorageBuffersInVertexStage: 10,
    maxStorageTexturesInVertexStage: 8,
  },
  info: {
    vendor: 'apple',
    architecture: 'metal-3',
    device: '',
    description: '',
    subgroupMinSize: 32,
    subgroupMaxSize: 32,
  },
};

/** Capture a stub profile from a real `GPU` (for example `navigator.gpu`). */
export async function captureWebGpuStubProfile(
  gpu: GPU,
  name: string,
  options?: GPURequestAdapterOptions,
): Promise<WebGpuStubProfile | null> {
  const adapter = await gpu.requestAdapter(options);
  if (adapter === null) return null;
  const limits: Record<string, number> = {};
  for (const key in adapter.limits) {
    const value = (adapter.limits as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number') limits[key] = value;
  }
  const info = adapter.info as GPUAdapterInfo & {
    readonly subgroupMinSize?: number;
    readonly subgroupMaxSize?: number;
  };
  return {
    name,
    preferredCanvasFormat: gpu.getPreferredCanvasFormat(),
    wgslLanguageFeatures: [...gpu.wgslLanguageFeatures].sort(),
    features: [...adapter.features].sort(),
    limits,
    info: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      ...(info.subgroupMinSize === undefined ? {} : { subgroupMinSize: info.subgroupMinSize }),
      ...(info.subgroupMaxSize === undefined ? {} : { subgroupMaxSize: info.subgroupMaxSize }),
    },
  };
}

// WebGPU core defaults; a device reports these unless a limit is requested.
const SPEC_DEFAULT_LIMITS: Readonly<Record<string, number>> = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
  maxImmediateSize: 0,
  maxStorageBuffersInFragmentStage: 8,
  maxStorageTexturesInFragmentStage: 4,
  maxStorageBuffersInVertexStage: 8,
  maxStorageTexturesInVertexStage: 4,
};

const RESOLVED = Promise.resolve();
const INSTALLED = Symbol.for('forgeax.webgpu-stub');

interface Labelled {
  label: string;
}
const labelled = <T extends Labelled>(target: T, descriptor?: { readonly label?: string }): T => {
  target.label = descriptor?.label ?? '';
  return target;
};

class StubBuffer {
  label = '';
  readonly size: number;
  readonly usage: number;
  mapState: GPUBufferMapState;
  constructor(descriptor: GPUBufferDescriptor) {
    labelled(this, descriptor);
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.mapState = descriptor.mappedAtCreation === true ? 'mapped' : 'unmapped';
  }
  mapAsync(): Promise<undefined> {
    this.mapState = 'pending';
    return RESOLVED.then(() => {
      this.mapState = 'mapped';
      return undefined;
    });
  }
  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    return new ArrayBuffer(size ?? Math.max(0, this.size - offset));
  }
  unmap(): undefined {
    this.mapState = 'unmapped';
    return undefined;
  }
  destroy(): undefined {
    this.mapState = 'unmapped';
    return undefined;
  }
}

class StubTextureView {
  label = '';
  constructor(
    readonly texture: StubTexture,
    descriptor?: GPUTextureViewDescriptor,
  ) {
    labelled(this, descriptor);
  }
}

class StubTexture {
  label = '';
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly dimension: GPUTextureDimension;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  constructor(descriptor: GPUTextureDescriptor) {
    labelled(this, descriptor);
    const size = descriptor.size;
    const [width, height, layers] =
      Symbol.iterator in Object(size)
        ? [...(size as Iterable<number>)]
        : [
            (size as GPUExtent3DDict).width,
            (size as GPUExtent3DDict).height,
            (size as GPUExtent3DDict).depthOrArrayLayers,
          ];
    this.width = width ?? 1;
    this.height = height ?? 1;
    this.depthOrArrayLayers = layers ?? 1;
    this.mipLevelCount = descriptor.mipLevelCount ?? 1;
    this.sampleCount = descriptor.sampleCount ?? 1;
    this.dimension = descriptor.dimension ?? '2d';
    this.format = descriptor.format;
    this.usage = descriptor.usage;
  }
  createView(descriptor?: GPUTextureViewDescriptor): StubTextureView {
    return new StubTextureView(this, descriptor);
  }
  destroy(): undefined {
    return undefined;
  }
}

class StubObject {
  label = '';
  constructor(descriptor?: { readonly label?: string }) {
    labelled(this, descriptor);
  }
}

class StubPipeline extends StubObject {
  private readonly layouts = new Map<number, StubObject>();
  getBindGroupLayout(index: number): StubObject {
    let layout = this.layouts.get(index);
    if (layout === undefined) {
      layout = new StubObject({ label: `${this.label}#${index}` });
      this.layouts.set(index, layout);
    }
    return layout;
  }
}

class StubShaderModule extends StubObject {
  getCompilationInfo(): Promise<{ readonly messages: readonly never[] }> {
    return Promise.resolve({ messages: [] });
  }
}

class StubQuerySet extends StubObject {
  readonly type: GPUQueryType;
  readonly count: number;
  constructor(descriptor: GPUQuerySetDescriptor) {
    super(descriptor);
    this.type = descriptor.type;
    this.count = descriptor.count;
  }
  destroy(): undefined {
    return undefined;
  }
}

class StubDebugCommands extends StubObject {
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
}

class StubRenderCommands extends StubDebugCommands {
  setPipeline(): void {}
  setBindGroup(): void {}
  setVertexBuffer(): void {}
  setIndexBuffer(): void {}
  setImmediates(): void {}
  draw(): void {}
  drawIndexed(): void {}
  drawIndirect(): void {}
  drawIndexedIndirect(): void {}
}

class StubRenderPass extends StubRenderCommands {
  setViewport(): void {}
  setScissorRect(): void {}
  setBlendConstant(): void {}
  setStencilReference(): void {}
  beginOcclusionQuery(): void {}
  endOcclusionQuery(): void {}
  executeBundles(): void {}
  end(): void {}
}

class StubRenderBundleEncoder extends StubRenderCommands {
  finish(descriptor?: GPURenderBundleDescriptor): StubObject {
    return new StubObject(descriptor);
  }
}

class StubComputePass extends StubDebugCommands {
  setPipeline(): void {}
  setBindGroup(): void {}
  setImmediates(): void {}
  dispatchWorkgroups(): void {}
  dispatchWorkgroupsIndirect(): void {}
  end(): void {}
}

class StubCommandEncoder extends StubDebugCommands {
  beginRenderPass(descriptor: GPURenderPassDescriptor): StubRenderPass {
    return new StubRenderPass(descriptor);
  }
  beginComputePass(descriptor?: GPUComputePassDescriptor): StubComputePass {
    return new StubComputePass(descriptor);
  }
  copyBufferToBuffer(): void {}
  copyBufferToTexture(): void {}
  copyTextureToBuffer(): void {}
  copyTextureToTexture(): void {}
  clearBuffer(): void {}
  resolveQuerySet(): void {}
  writeTimestamp(): void {}
  finish(descriptor?: GPUCommandBufferDescriptor): StubObject {
    return new StubObject(descriptor);
  }
}

class StubQueue extends StubObject {
  submit(): void {}
  writeBuffer(): void {}
  writeTexture(): void {}
  copyExternalImageToTexture(): void {}
  onSubmittedWorkDone(): Promise<undefined> {
    return RESOLVED as Promise<undefined>;
  }
}

class StubDevice extends EventTarget {
  label = '';
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly adapterInfo: WebGpuStubProfile['info'];
  readonly queue = new StubQueue();
  readonly lost: Promise<never> = new Promise<never>(() => {});
  onuncapturederror: ((event: Event) => void) | null = null;
  constructor(adapter: StubAdapter, descriptor?: GPUDeviceDescriptor) {
    super();
    labelled(this, descriptor);
    const features = new Set<string>(descriptor?.requiredFeatures ?? []);
    if (adapter.features.has('core-features-and-limits')) features.add('core-features-and-limits');
    const required = (descriptor?.requiredLimits ?? {}) as Record<string, number | undefined>;
    const limits: Record<string, number> = {};
    for (const [key, adapterValue] of Object.entries(adapter.limits)) {
      limits[key] = required[key] ?? SPEC_DEFAULT_LIMITS[key] ?? adapterValue;
    }
    this.features = features;
    this.limits = Object.freeze(limits);
    this.adapterInfo = adapter.info;
  }
  get info(): WebGpuStubProfile['info'] {
    return this.adapterInfo;
  }
  destroy(): void {}
  createBuffer(descriptor: GPUBufferDescriptor): StubBuffer {
    return new StubBuffer(descriptor);
  }
  createTexture(descriptor: GPUTextureDescriptor): StubTexture {
    return new StubTexture(descriptor);
  }
  createSampler(descriptor?: GPUSamplerDescriptor): StubObject {
    return new StubObject(descriptor);
  }
  importExternalTexture(descriptor: GPUExternalTextureDescriptor): StubObject {
    return new StubObject(descriptor);
  }
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): StubObject {
    return new StubObject(descriptor);
  }
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): StubObject {
    return new StubObject(descriptor);
  }
  createBindGroup(descriptor: GPUBindGroupDescriptor): StubObject {
    return new StubObject(descriptor);
  }
  createShaderModule(descriptor: GPUShaderModuleDescriptor): StubShaderModule {
    return new StubShaderModule(descriptor);
  }
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): StubPipeline {
    return new StubPipeline(descriptor);
  }
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): StubPipeline {
    return new StubPipeline(descriptor);
  }
  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<StubPipeline> {
    return Promise.resolve(new StubPipeline(descriptor));
  }
  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<StubPipeline> {
    return Promise.resolve(new StubPipeline(descriptor));
  }
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): StubCommandEncoder {
    return new StubCommandEncoder(descriptor);
  }
  createRenderBundleEncoder(descriptor: GPURenderBundleEncoderDescriptor): StubRenderBundleEncoder {
    return new StubRenderBundleEncoder(descriptor);
  }
  createQuerySet(descriptor: GPUQuerySetDescriptor): StubQuerySet {
    return new StubQuerySet(descriptor);
  }
  pushErrorScope(): void {}
  popErrorScope(): Promise<null> {
    return Promise.resolve(null);
  }
}

class StubAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly info: WebGpuStubProfile['info'] & { readonly isFallbackAdapter: false };
  readonly isFallbackAdapter = false;
  constructor(profile: WebGpuStubProfile) {
    this.features = new Set(profile.features);
    this.limits = Object.freeze({ ...profile.limits });
    this.info = Object.freeze({ ...profile.info, isFallbackAdapter: false as const });
  }
  async requestDevice(descriptor?: GPUDeviceDescriptor): Promise<StubDevice> {
    for (const feature of descriptor?.requiredFeatures ?? []) {
      if (!this.features.has(feature)) {
        throw new TypeError(`WebGPU stub adapter does not support feature '${feature}'`);
      }
    }
    for (const [key, value] of Object.entries(descriptor?.requiredLimits ?? {})) {
      const supported = this.limits[key];
      if (value === undefined) continue;
      if (supported === undefined) {
        throw new TypeError(`WebGPU stub adapter does not report limit '${key}'`);
      }
      const better = key.startsWith('min') ? value >= supported : value <= supported;
      if (!better) {
        const error = new Error(`WebGPU stub limit '${key}' ${value} exceeds adapter ${supported}`);
        error.name = 'OperationError';
        throw error;
      }
    }
    return new StubDevice(this, descriptor);
  }
}

class StubCanvasContext {
  private configuration: GPUCanvasConfiguration | null = null;
  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly fallbackFormat: GPUTextureFormat,
  ) {}
  configure(configuration: GPUCanvasConfiguration): void {
    this.configuration = configuration;
  }
  unconfigure(): void {
    this.configuration = null;
  }
  getConfiguration(): GPUCanvasConfiguration | null {
    return this.configuration;
  }
  getCurrentTexture(): StubTexture {
    return new StubTexture({
      label: 'canvas',
      size: { width: this.canvas.width, height: this.canvas.height },
      format: this.configuration?.format ?? this.fallbackFormat,
      usage: this.configuration?.usage ?? 0x10,
    });
  }
}

type CanvasClass = { prototype: { getContext(type: string, ...rest: unknown[]): unknown } };

/**
 * Replace this realm's `navigator.gpu` and `'webgpu'` canvas contexts with the
 * stub. Idempotent per realm; install it in every realm that creates a Renderer
 * (App forwards its `gpuStub` option to execution Workers).
 */
export function installWebGpuStub(profile: WebGpuStubProfile): void {
  const realm = globalThis as typeof globalThis & { [INSTALLED]?: string };
  if (realm[INSTALLED] !== undefined) return;
  const navigatorObject = (realm as { navigator?: object }).navigator;
  if (navigatorObject === undefined) {
    throw new TypeError('WebGPU stub requires a realm with navigator');
  }
  realm[INSTALLED] = profile.name;
  const gpu = {
    requestAdapter: (): Promise<StubAdapter> => Promise.resolve(new StubAdapter(profile)),
    getPreferredCanvasFormat: (): GPUTextureFormat => profile.preferredCanvasFormat,
    wgslLanguageFeatures: new Set(profile.wgslLanguageFeatures),
  };
  Object.defineProperty(navigatorObject, 'gpu', { get: () => gpu, configurable: true });
  const constants: Readonly<Record<string, Readonly<Record<string, number>>>> = {
    GPUBufferUsage: {
      MAP_READ: 1,
      MAP_WRITE: 2,
      COPY_SRC: 4,
      COPY_DST: 8,
      INDEX: 16,
      VERTEX: 32,
      UNIFORM: 64,
      STORAGE: 128,
      INDIRECT: 256,
      QUERY_RESOLVE: 512,
    },
    GPUTextureUsage: {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8,
      RENDER_ATTACHMENT: 16,
      TRANSIENT_ATTACHMENT: 32,
    },
    GPUMapMode: { READ: 1, WRITE: 2 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
    GPUColorWrite: { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 },
  };
  for (const [name, value] of Object.entries(constants)) {
    if ((realm as Record<string, unknown>)[name] === undefined) {
      Object.defineProperty(realm, name, { value: Object.freeze(value), configurable: true });
    }
  }
  const contexts = new WeakMap<object, StubCanvasContext>();
  for (const name of ['HTMLCanvasElement', 'OffscreenCanvas']) {
    const canvasClass = (realm as Record<string, unknown>)[name] as CanvasClass | undefined;
    if (canvasClass === undefined) continue;
    const original = canvasClass.prototype.getContext;
    canvasClass.prototype.getContext = function getContext(
      this: HTMLCanvasElement | OffscreenCanvas,
      type: string,
      ...rest: unknown[]
    ): unknown {
      if (type !== 'webgpu') return original.call(this, type, ...rest);
      let context = contexts.get(this);
      if (context === undefined) {
        context = new StubCanvasContext(this, profile.preferredCanvasFormat);
        contexts.set(this, context);
      }
      return context;
    };
  }
}

/** The profile name installed in this realm, if any. */
export function installedWebGpuStub(): string | undefined {
  return (globalThis as { [INSTALLED]?: string })[INSTALLED];
}
