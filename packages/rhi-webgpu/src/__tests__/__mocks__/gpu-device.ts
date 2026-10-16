// Minimal mock GPU device fixture for @forgeax/engine-rhi-webgpu unit tests.
//
// Strategy (decision S-2 / OQ-1 path (b) / research F-6):
// - hand-written minimal mock object (pure TS, zero native dependency).
// - does NOT attempt a spec-compliant full GPUDevice (webgpu-utils author
//   evaluated that as higher-cost than maintaining a puppeteer launcher,
//   and impossible to keep up with spec drift).
// - covers the entry-point set used by the shim tests:
//     requestAdapter / requestDevice / device.createBuffer / createTexture /
//     createSampler / createBindGroupLayout / createRenderPipeline /
//     createShaderModule / createCommandEncoder + queue submit / writeBuffer
//     + failure injection switches.
//
// Design points:
// - `MockGpu` implements the GPU interface subset required by the shim's
//   `gpu?: GPU` provider seam (research F-6 webgpu-utils + CTS consensus).
// - All createX calls forward the descriptor into `__captured` so the
//   field-by-field passthrough assertions can read it back.
// - `failures` controls error injection for the device/shader paths.
// - `compilerMessages` lets shader-compile tests pump the full 6 fields of
//   GPUCompilationMessage (OQ-P2: message / type / lineNum / linePos /
//   offset / length).
//
// w3 / w5 / w6 (feat-20260508-rhi-surface-completion): added
// MockCommandEncoder + MockRenderPassEncoder + MockComputePassEncoder +
// MockCommandBuffer + MockBuffer.size + MockQueue.submit / writeBuffer.

/// <reference types="@webgpu/types" />

/** Failure-injection switches consumed by the device path tests. */
export interface MockFailures {
  /** `requestAdapter` returns null (research F-5 single null channel). */
  adapterNull?: boolean;
  /** `requestDevice` rejects with `OperationError` (spec behaviour for an
   *  unsupported feature). */
  requestDeviceFeatureNotEnabled?: boolean;
  /** `requestDevice` rejects with `OperationError` (spec behaviour for an
   *  out-of-range limit). */
  requestDeviceLimitExceeded?: boolean;
  /** `createShaderModule` returns a module whose `getCompilationInfo()`
   *  yields error-typed messages. */
  shaderCompileMessages?: readonly GPUCompilationMessage[];
  /** `createShaderModule` returns a module whose `getCompilationInfo()`
   *  rejects — models the GPU instance being dropped mid-await (device
   *  destroyed / page teardown while the async query is in flight). */
  getCompilationInfoRejects?: boolean;
  /** `createRenderPipeline` throws synchronously with this message. */
  renderPipelineError?: string;
}

/** Mock-capture event union; consumed by passthrough assertions. */
export type MockCapture =
  | { kind: 'requestAdapter'; options: GPURequestAdapterOptions | undefined }
  | { kind: 'requestDevice'; options: GPUDeviceDescriptor | undefined }
  | { kind: 'createBuffer'; descriptor: GPUBufferDescriptor }
  | { kind: 'createTexture'; descriptor: GPUTextureDescriptor }
  | { kind: 'createSampler'; descriptor: GPUSamplerDescriptor | undefined }
  | { kind: 'createBindGroupLayout'; descriptor: GPUBindGroupLayoutDescriptor }
  | { kind: 'createBindGroup'; descriptor: GPUBindGroupDescriptor }
  | { kind: 'createPipelineLayout'; descriptor: GPUPipelineLayoutDescriptor }
  | { kind: 'createRenderPipeline'; descriptor: GPURenderPipelineDescriptor }
  | { kind: 'createShaderModule'; descriptor: GPUShaderModuleDescriptor }
  | {
      kind: 'createTextureView';
      sourceDescriptor: GPUTextureDescriptor;
      descriptor: GPUTextureViewDescriptor | undefined;
    }
  | { kind: 'createComputePipeline'; descriptor: GPUComputePipelineDescriptor }
  | { kind: 'createQuerySet'; descriptor: GPUQuerySetDescriptor };

/** Unique brand symbol so captured handles cannot be confused with real GPU* objects. */
const MOCK_BRAND: unique symbol = Symbol('mock-gpu-handle');

/**
 * Mock texture handle: exposes spec readonly fields the shim consumes for
 * createTextureView cross-resource validation (research §1.1: format must be
 * in source.format ∪ source.viewFormats; usage must be a subset of
 * source.usage). The shim retrieves these via its own WeakMap (filled at
 * createTexture time), but the mock surfaces createView so the shim can
 * forward and capture descriptors verbatim.
 */
export interface MockTexture {
  readonly [MOCK_BRAND]: 'texture';
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;
  readonly viewFormats: readonly GPUTextureFormat[];
  createView(descriptor?: GPUTextureViewDescriptor | undefined): MockTextureView;
}

/** Mock texture view handle. */
export interface MockTextureView {
  readonly [MOCK_BRAND]: 'texture-view';
}

/** Mock device exposed subset (covers only the surface the shim uses). */
export interface MockDevice {
  readonly features: GPUSupportedFeatures;
  readonly limits: GPUSupportedLimits;
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly queue: MockQueue;
  createBuffer(descriptor: GPUBufferDescriptor): MockBuffer;
  createTexture(descriptor: GPUTextureDescriptor): MockTexture;
  createSampler(descriptor?: GPUSamplerDescriptor | undefined): {
    readonly [MOCK_BRAND]: 'sampler';
  };
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): { readonly [MOCK_BRAND]: 'bgl' };
  createBindGroup(descriptor: GPUBindGroupDescriptor): { readonly [MOCK_BRAND]: 'bg' };
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): {
    readonly [MOCK_BRAND]: 'pl';
  };
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): {
    readonly [MOCK_BRAND]: 'render-pipeline';
  };
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): {
    readonly [MOCK_BRAND]: 'compute-pipeline';
  };
  createQuerySet(descriptor: GPUQuerySetDescriptor): {
    readonly [MOCK_BRAND]: 'query-set';
  };
  createShaderModule(descriptor: GPUShaderModuleDescriptor): {
    readonly [MOCK_BRAND]: 'shader';
    getCompilationInfo(): Promise<GPUCompilationInfo>;
  };
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor | undefined): MockCommandEncoder;
}

/** Mock queue: tracks submit / writeBuffer for assertions; M5 / w37 adds
 *  writeTexture / copyExternalImageToTexture / onSubmittedWorkDone. */
export interface MockQueue {
  readonly [MOCK_BRAND]: 'queue';
  submit(commandBuffers: Iterable<MockCommandBuffer>): void;
  writeBuffer(
    buffer: MockBuffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void;
  writeTexture(
    destination: unknown,
    data: ArrayBufferView | ArrayBuffer,
    dataLayout: unknown,
    size: unknown,
  ): void;
  copyExternalImageToTexture(source: unknown, destination: unknown, copySize: unknown): void;
  onSubmittedWorkDone(): Promise<undefined>;
}

/** Mock buffer; carries `size` so writeBuffer bounds-checking has a value.
 *  Extended in M5 / w35 with mapping surface (mapAsync / getMappedRange /
 *  unmap / mapState) so the shim Buffer wrapper can drive the validation
 *  paths (research §4.1 / §4.2 / §4.4). */
export interface MockBuffer {
  readonly [MOCK_BRAND]: 'buffer';
  readonly size: number;
  mapState: 'unmapped' | 'pending' | 'mapped';
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
}

/** Mock command encoder: returned by device.createCommandEncoder. */
export interface MockCommandEncoder {
  readonly [MOCK_BRAND]: 'command-encoder';
  beginRenderPass(descriptor: GPURenderPassDescriptor): MockRenderPassEncoder;
  beginComputePass(descriptor?: GPUComputePassDescriptor): MockComputePassEncoder;
  copyBufferToBuffer(...args: unknown[]): void;
  copyBufferToTexture(source: unknown, destination: unknown, copySize: unknown): void;
  copyTextureToBuffer(source: unknown, destination: unknown, copySize: unknown): void;
  copyTextureToTexture(source: unknown, destination: unknown, copySize: unknown): void;
  clearBuffer(buffer: MockBuffer, offset?: number, size?: number): void;
  resolveQuerySet(...args: unknown[]): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
  finish(descriptor?: GPUCommandBufferDescriptor): MockCommandBuffer;
}

/** Mock render pass encoder. */
export interface MockRenderPassEncoder {
  readonly [MOCK_BRAND]: 'render-pass-encoder';
  executeBundles(bundles: Iterable<unknown>): void;
  setPipeline(pipeline: unknown): void;
  setBindGroup(...args: unknown[]): void;
  setIndexBuffer(...args: unknown[]): void;
  setVertexBuffer(...args: unknown[]): void;
  draw(...args: unknown[]): void;
  drawIndexed(...args: unknown[]): void;
  drawIndirect(...args: unknown[]): void;
  drawIndexedIndirect(...args: unknown[]): void;
  setViewport(...args: unknown[]): void;
  setScissorRect(...args: unknown[]): void;
  setBlendConstant(...args: unknown[]): void;
  setStencilReference(...args: unknown[]): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
  end(): void;
}

/** Mock compute pass encoder. */
export interface MockComputePassEncoder {
  readonly [MOCK_BRAND]: 'compute-pass-encoder';
  setPipeline(pipeline: unknown): void;
  setBindGroup(...args: unknown[]): void;
  dispatchWorkgroups(...args: unknown[]): void;
  dispatchWorkgroupsIndirect(...args: unknown[]): void;
  end(): void;
}

/** Mock command buffer (returned by encoder.finish). */
export interface MockCommandBuffer {
  readonly [MOCK_BRAND]: 'command-buffer';
}

/**
 * Minimal mock `GPU` provider injected via the shim's `gpu?: GPU` provider
 * seam (research F-6 webgpu-utils + CTS consensus).
 *
 * `__captured` / `__failures` are observation points exclusive to the test
 * side; the shim does not read them.
 */
export interface MockGpu {
  /** Test observation: createX / requestX call-site descriptors in order. */
  readonly __captured: MockCapture[];
  /** Failure-injection switches for the test side. */
  readonly __failures: MockFailures;
  requestAdapter(options?: GPURequestAdapterOptions | undefined): Promise<MockAdapter | null>;
}

/** Mock adapter subset. */
export interface MockAdapter {
  readonly features: GPUSupportedFeatures;
  readonly limits: GPUSupportedLimits;
  requestDevice(descriptor?: GPUDeviceDescriptor | undefined): Promise<MockDevice>;
}

/** Default features set (empty); use failures.requestDeviceFeatureNotEnabled
 *  to trigger the unsupported-feature path. */
function makeFeatures(initial: readonly GPUFeatureName[] = []): GPUSupportedFeatures {
  return new Set(initial) as unknown as GPUSupportedFeatures;
}

/**
 * Default limits with non-zero values (MVP-1.2 runtime non-empty assertion
 * only checks `typeof !== 'undefined'`).
 *
 * Field set aligns with `@webgpu/types` v0.1.69 GPUSupportedLimits 35 fields;
 * this mock uses spec defaults (research F-1 / W3C CR 3.6). Cast to
 * GPUSupportedLimits to tolerate upstream dts additions.
 */
function makeLimits(): GPUSupportedLimits {
  return {
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
  } as unknown as GPUSupportedLimits;
}

/** Construct a minimal mock device; captures call-site descriptors into `captured`. */
function makeDevice(captured: MockCapture[], failures: MockFailures): MockDevice {
  const compileMsgs = failures.shaderCompileMessages;
  const compilationInfoRejects = failures.getCompilationInfoRejects === true;
  const lost = new Promise<GPUDeviceLostInfo>(() => {
    /* never settles - device.lost two-track test uses caller-injected mock */
  });
  // M5 / w37: track FIFO order of onSubmittedWorkDone calls so the unit
  // tests can assert ordering constraint #1 (research §5.2).
  let osWdCounter = 0;
  const queue: MockQueue = {
    [MOCK_BRAND]: 'queue' as const,
    submit(_commandBuffers): void {
      // No-op; w6 unit tests assert the shim wiring + bounds error paths
      // before the call would reach the real GPU layer.
    },
    writeBuffer(_buffer, _bufferOffset, _data, _dataOffset, _size): void {
      // No-op; bounds checks happen in the shim before this is reached.
    },
    writeTexture(_destination, _data, _dataLayout, _size): void {
      // No-op; alignment validation happens in the shim before this is hit.
    },
    copyExternalImageToTexture(_source, _destination, _copySize): void {
      // No-op; mock surface for type / API contract assertions.
    },
    onSubmittedWorkDone(): Promise<undefined> {
      // Mirror FIFO ordering by chaining microtasks (await each previous
      // call's resolution before resolving this one).
      const order = ++osWdCounter;
      return new Promise<undefined>((resolve) => {
        // Schedule resolution at microtask depth N so the N-th call
        // settles after the (N-1)-th call (research §5.2 constraint #1).
        const chain = (depth: number): void => {
          if (depth === 0) {
            resolve(undefined);
            return;
          }
          queueMicrotask(() => chain(depth - 1));
        };
        chain(order);
      });
    },
  };
  return {
    features: makeFeatures(),
    limits: makeLimits(),
    lost,
    queue,
    createBuffer(descriptor) {
      captured.push({ kind: 'createBuffer', descriptor });
      const sizeField =
        typeof descriptor.size === 'number' ? descriptor.size : Number.MAX_SAFE_INTEGER;
      // M5 / w35: track mapState so the shim Buffer wrapper can detect the
      // F-8 three-row faults (already-mapped re-mapAsync / detach after unmap
      // / mode-usage mismatch all ride 'webgpu-runtime-error', research §4.2
      // step 1 / 9 + §4.4 detach semantics).
      let backing: ArrayBuffer | null =
        descriptor.mappedAtCreation === true ? new ArrayBuffer(sizeField) : null;
      const buf: MockBuffer = {
        [MOCK_BRAND]: 'buffer' as const,
        size: sizeField,
        mapState: descriptor.mappedAtCreation === true ? 'mapped' : 'unmapped',
        mapAsync(_mode, _offset, _size): Promise<void> {
          buf.mapState = 'mapped';
          backing = new ArrayBuffer(sizeField);
          return Promise.resolve();
        },
        getMappedRange(offset = 0, size?): ArrayBuffer {
          if (backing === null) {
            throw new Error('mock: getMappedRange before mapAsync');
          }
          const len = size ?? backing.byteLength - offset;
          return backing.slice(offset, offset + len);
        },
        unmap(): void {
          backing = null;
          buf.mapState = 'unmapped';
        },
      };
      return buf;
    },
    createTexture(descriptor) {
      captured.push({ kind: 'createTexture', descriptor });
      const sourceDescriptor = descriptor;
      const tex: MockTexture = {
        [MOCK_BRAND]: 'texture' as const,
        format: descriptor.format,
        usage: descriptor.usage,
        viewFormats: descriptor.viewFormats === undefined ? [] : [...descriptor.viewFormats],
        createView(viewDescriptor) {
          captured.push({
            kind: 'createTextureView',
            sourceDescriptor,
            descriptor: viewDescriptor,
          });
          return { [MOCK_BRAND]: 'texture-view' as const };
        },
      };
      return tex;
    },
    createSampler(descriptor) {
      captured.push({ kind: 'createSampler', descriptor });
      return { [MOCK_BRAND]: 'sampler' as const };
    },
    createBindGroupLayout(descriptor) {
      captured.push({ kind: 'createBindGroupLayout', descriptor });
      return { [MOCK_BRAND]: 'bgl' as const };
    },
    createBindGroup(descriptor) {
      captured.push({ kind: 'createBindGroup', descriptor });
      return { [MOCK_BRAND]: 'bg' as const };
    },
    createPipelineLayout(descriptor) {
      captured.push({ kind: 'createPipelineLayout', descriptor });
      return { [MOCK_BRAND]: 'pl' as const };
    },
    createRenderPipeline(descriptor) {
      captured.push({ kind: 'createRenderPipeline', descriptor });
      if (failures.renderPipelineError !== undefined) {
        throw new Error(failures.renderPipelineError);
      }
      return { [MOCK_BRAND]: 'render-pipeline' as const };
    },
    createComputePipeline(descriptor) {
      captured.push({ kind: 'createComputePipeline', descriptor });
      return { [MOCK_BRAND]: 'compute-pipeline' as const };
    },
    createQuerySet(descriptor) {
      captured.push({ kind: 'createQuerySet', descriptor });
      // Mock surfaces .count + .type (spec readonly fields) so the shim's
      // resolveQuerySet bounds check (research §2.3) and beginOcclusionQuery
      // queryIndex bounds check (research §2.1) can read real values without
      // routing through the dawn-real-gpu path.
      return {
        [MOCK_BRAND]: 'query-set' as const,
        count: descriptor.count,
        type: descriptor.type,
      } as unknown as { readonly [MOCK_BRAND]: 'query-set' };
    },
    createShaderModule(descriptor) {
      captured.push({ kind: 'createShaderModule', descriptor });
      return {
        [MOCK_BRAND]: 'shader' as const,
        getCompilationInfo() {
          if (compilationInfoRejects) {
            return Promise.reject(
              new DOMException('Instance dropped error in getCompilationInfo', 'OperationError'),
            );
          }
          return Promise.resolve({
            messages: compileMsgs ?? [],
          } as GPUCompilationInfo);
        },
      };
    },
    createCommandEncoder(_descriptor) {
      const encoder: MockCommandEncoder = {
        [MOCK_BRAND]: 'command-encoder' as const,
        beginRenderPass(_descriptor) {
          const pass: MockRenderPassEncoder = {
            [MOCK_BRAND]: 'render-pass-encoder' as const,
            executeBundles() {},
            setPipeline() {},
            setBindGroup() {},
            setIndexBuffer() {},
            setVertexBuffer() {},
            draw() {},
            drawIndexed() {},
            drawIndirect() {},
            drawIndexedIndirect() {},
            setViewport() {},
            setScissorRect() {},
            setBlendConstant() {},
            setStencilReference() {},
            pushDebugGroup() {},
            popDebugGroup() {},
            insertDebugMarker() {},
            end() {},
          };
          return pass;
        },
        beginComputePass(_descriptor) {
          const pass: MockComputePassEncoder = {
            [MOCK_BRAND]: 'compute-pass-encoder' as const,
            setPipeline() {},
            setBindGroup() {},
            dispatchWorkgroups() {},
            dispatchWorkgroupsIndirect() {},
            end() {},
          };
          return pass;
        },
        copyBufferToBuffer() {},
        copyBufferToTexture() {},
        copyTextureToBuffer() {},
        copyTextureToTexture() {},
        clearBuffer() {},
        resolveQuerySet() {},
        pushDebugGroup() {},
        popDebugGroup() {},
        insertDebugMarker() {},
        finish(_descriptor) {
          return { [MOCK_BRAND]: 'command-buffer' as const };
        },
      };
      return encoder;
    },
  };
}

/**
 * Create a MockGpu test entry point.
 *
 * @example
 *   const gpu = createMockGpu();
 *   gpu.__failures.adapterNull = true;
 *   const r = await rhiWebgpu.requestDevice({ gpu });
 *   expect(r.ok).toBe(false);
 */
export function createMockGpu(failures: MockFailures = {}): MockGpu {
  const captured: MockCapture[] = [];
  const __failures: MockFailures = { ...failures };
  return {
    __captured: captured,
    __failures,
    async requestAdapter(options) {
      captured.push({ kind: 'requestAdapter', options });
      if (__failures.adapterNull === true) return null;
      return {
        features: makeFeatures(),
        limits: makeLimits(),
        async requestDevice(deviceOptions) {
          captured.push({ kind: 'requestDevice', options: deviceOptions });
          if (__failures.requestDeviceFeatureNotEnabled === true) {
            const e = new Error('mock: requested feature not supported by adapter');
            e.name = 'OperationError';
            throw e;
          }
          if (__failures.requestDeviceLimitExceeded === true) {
            const e = new Error('mock: requested limit exceeds adapter capability');
            e.name = 'OperationError';
            throw e;
          }
          return makeDevice(captured, __failures);
        },
      };
    },
  };
}

/**
 * Build a 6-field GPUCompilationMessage (OQ-P2 locked field set).
 * Used by shader-compile-failed path tests asserting detail.compilerMessages.
 */
export function makeShaderError(
  partial: Partial<GPUCompilationMessage> = {},
): GPUCompilationMessage {
  // GPUCompilationMessage in @webgpu/types v0.1.69 has a private __brand
  // placeholder (implementation-exclusive brand); user code constructs a
  // plain object and casts to GPUCompilationMessage. Same shape as the
  // webgpu-utils / CTS test fixtures (research F-6).
  return {
    message: partial.message ?? 'unexpected token',
    type: partial.type ?? 'error',
    lineNum: partial.lineNum ?? 1,
    linePos: partial.linePos ?? 1,
    offset: partial.offset ?? 0,
    length: partial.length ?? 0,
  } as unknown as GPUCompilationMessage;
}
