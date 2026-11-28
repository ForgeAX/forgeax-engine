// In-WASM RenderKernel backed by `WasmWgpuRenderKernel` inside `@forgeax/engine-wgpu-wasm`.
// Executes SceneDelta, Cull, and PHYS_* replay in a single WASM crossing without bouncing back through TS RHI.

import type { RhiCaps, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { bitsToF32, FrameRecorder } from './command-stream.js';
import {
  CULL_FLAG_COMPUTE_VISIBLE_BOUNDS,
  CULL_FLAG_CULL_LIGHTS,
  type FrameSubmitReceipt,
  type KernelAssetApi,
  type KernelBufferDesc,
  type KernelCullParams,
  type KernelCullSummary,
  type KernelMaterialDesc,
  type KernelMeshDesc,
  type KernelSamplerDesc,
  type KernelShaderProgramDesc,
  type KernelTextureDesc,
  type KernelVisibleLightSummary,
  type RenderKernel,
} from './contract.js';
import {
  type DynamicTextureDesc,
  type DynamicTextureUploadSource,
  isByteDynamicSource,
} from './dynamic-texture.js';
import { type KernelError, kernelErr, ok, type Result } from './errors.js';
import type {
  BufferId,
  CullId,
  DynamicTextureId,
  LightId,
  MaterialId,
  MeshId,
  PipelineId,
  RenderObjectId,
  SamplerId,
  ShaderProgramId,
  SurfaceId,
  TextureId,
} from './handles.js';
import { SceneDeltaWriter } from './scene-delta.js';
import { wrapWasmCall } from './wasm-kernel.js';

export interface RawWasmWgpuKernel {
  free(): void;
  set_capture_resolved(enabled: boolean): void;
  supports_scene_4bgl(): boolean;
  gpu_memory_bytes(): number;
  create_mesh(
    vertexLayoutId: number,
    vertexData: Uint8Array,
    indexData: Uint8Array | null | undefined,
    indexCount: number,
    vertexCount: number,
    isUint32Index: boolean,
    topology: number,
    label?: string | null,
  ): number;
  destroy_mesh(id: number): void;
  create_texture(
    width: number,
    height: number,
    formatCode: number,
    usage: number,
    data: Uint8Array | null | undefined,
    mipLevelCount: number,
    arrayLayerCount: number,
    sampleCount: number,
    label?: string | null,
  ): number;
  destroy_texture(id: number): void;
  create_dynamic_texture(width: number, height: number, formatCode: number): number;
  upload_dynamic_texture(
    id: number,
    revision: number,
    width: number,
    height: number,
    data: Uint8Array,
  ): boolean;
  destroy_dynamic_texture(id: number): void;
  create_buffer(
    size: number,
    usage: number,
    data?: Uint8Array | null,
    label?: string | null,
  ): number;
  write_buffer(id: number, offset: number, data: Uint8Array): void;
  destroy_buffer(id: number): void;
  create_sampler(
    hash: number,
    addressModeU?: string | null,
    addressModeV?: string | null,
    addressModeW?: string | null,
    magFilter?: string | null,
    minFilter?: string | null,
    mipmapFilter?: string | null,
    compare?: string | null,
    label?: string | null,
  ): number;
  destroy_sampler(id: number): void;
  register_shader_program(
    code: string,
    vertexEntryPoint: string | null | undefined,
    fragmentEntryPoint: string | null | undefined,
    computeEntryPoint: string | null | undefined,
    layoutFamilyId: number,
    vertexLayoutsJson: string | null | undefined,
    colorFormatsJson: string | null | undefined,
    depthFormat: string | null | undefined,
    sampleCount: number,
    blendMode: string | null | undefined,
    primitiveTopology: string | null | undefined,
    label?: string | null,
    extraStateJson?: string | null,
  ): number;
  destroy_shader_program(id: number): void;
  create_material(
    shaderProgramId: number,
    layoutFamilyId: number,
    renderStateBits: number,
    variantFlags: number,
    queue: number,
    paramBytes: Uint8Array,
    baseColorTextureId: number,
    normalTextureId: number,
    metallicRoughnessTextureId: number,
    emissiveTextureId: number,
    occlusionTextureId: number,
    samplerId: number,
    label?: string | null,
  ): number;
  destroy_material(id: number): void;
  ensure_delta_buffer(minBytes: number): number;
  delta_buffer_capacity(): number;
  commit_scene_delta_len(byteLen: number): number;
  begin_frame(frameId: number, surfaceWidth: number, surfaceHeight: number): void;
  cull_vp_ptr(): number;
  cull(
    camX: number,
    camY: number,
    camZ: number,
    layerMask: number,
    flags: number,
    lodBias: number,
  ): number;
  cull_summary_ptr(): number;
  cull_lights_ptr(): number;
  ensure_cmd_buffer(minWords: number): number;
  cmd_buffer_capacity(): number;
  submit_frame_words(wordLen: number, uniformData: Uint8Array, targetView?: unknown): number;
  resolved_cmds_ptr(): number;
  resolved_cmds_len(): number;
  receipt_ptr(): number;
  submitted_bitmap_ptr(): number;
  submitted_bitmap_len(): number;
  object_count(): number;
  readback_ticket(ticketId: number): {
    readonly width: number;
    readonly height: number;
    readonly format: GPUTextureFormat;
    readonly pixels: Uint8Array;
  };
}

export interface WasmWgpuKernelModule {
  WasmWgpuRenderKernel: new (
    rawDevice: unknown,
    adapterName?: string | null,
    backendName?: string | null,
  ) => RawWasmWgpuKernel;
  kernelWasmMemory: () => WebAssembly.Memory;
}

export interface WasmWgpuKernelOptions {
  readonly captureResolved?: boolean | undefined;
  readonly adapterName?: string | undefined;
  readonly backendName?: string | undefined;
}

/** Extracts the underlying wasm-bindgen handle from an `@forgeax/engine-rhi-wgpu` wrapper if present. */
export function unwrapRhiWgpuHandle(handle: unknown): unknown {
  if (handle === null || handle === undefined || typeof handle !== 'object') return undefined;
  const obj = handle as { _internal_raw?: unknown; forgeaxToken?: unknown };
  if (obj._internal_raw !== undefined) return obj._internal_raw;
  if (typeof obj.forgeaxToken === 'number') return handle;
  return undefined;
}

export class WasmWgpuRenderKernel implements RenderKernel {
  readonly backendKind = 'rust-wgpu-wasm' as const;
  readonly mode = 'wasm' as const;
  readonly caps: Readonly<RhiCaps>;
  readonly device: RhiDevice;
  readonly assets: KernelAssetApi;

  private readonly mod: WasmWgpuKernelModule;
  private readonly raw: RawWasmWgpuKernel;
  private readonly deltaWriter = new SceneDeltaWriter(64 * 1024);
  private readonly recorder = new FrameRecorder(8192);
  private readonly lightsOut: KernelVisibleLightSummary[] = [];
  private activeFrameId: number | undefined;
  private lastRevision = 0;
  private disposed = false;
  private nextExternalId = 1;
  private activeTargetViewRaw: unknown = undefined;

  constructor(device: RhiDevice, mod: WasmWgpuKernelModule, options?: WasmWgpuKernelOptions) {
    const rawDevice = unwrapRhiWgpuHandle(device);
    if (!rawDevice) {
      throw new Error(
        'WasmWgpuRenderKernel requires an @forgeax/engine-rhi-wgpu RhiDevice with _internal_raw',
      );
    }
    this.device = device;
    this.caps = device.caps;
    this.mod = mod;
    this.raw = new mod.WasmWgpuRenderKernel(
      rawDevice,
      options?.adapterName ?? null,
      options?.backendName ?? null,
    );
    if (options?.captureResolved) {
      this.raw.set_capture_resolved(true);
    }
    this.assets = this.createAssetApi();
  }

  private mem(): ArrayBuffer {
    return this.mod.kernelWasmMemory().buffer;
  }

  setCaptureResolved(enabled: boolean): void {
    this.raw.set_capture_resolved(enabled);
  }

  supportsScene4Bgl(): boolean {
    return this.raw.supports_scene_4bgl();
  }

  gpuMemoryBytes(): number {
    return this.raw.gpu_memory_bytes();
  }

  private createAssetApi(): KernelAssetApi {
    return {
      createMesh: (desc: KernelMeshDesc, vertexBytes: Uint8Array, indexBytes?: Uint8Array) => {
        if (this.disposed)
          return kernelErr('kernel-disposed', 'WasmWgpuRenderKernel', 'live kernel', 'disposed');
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.createMesh', () =>
          this.raw.create_mesh(
            desc.vertexLayoutId,
            vertexBytes,
            indexBytes ?? null,
            desc.indexCount,
            desc.vertexCount,
            desc.isUint32Index === true,
            desc.topology ?? 0,
            desc.label ?? null,
          ),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as MeshId);
      },
      destroyMesh: (id: MeshId) =>
        wrapWasmCall('WasmWgpuRenderKernel.destroyMesh', () => this.raw.destroy_mesh(id), id),
      createTexture: (desc: KernelTextureDesc, initialBytes?: Uint8Array) => {
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.createTexture', () =>
          this.raw.create_texture(
            desc.width,
            desc.height,
            desc.format,
            desc.usage ?? 0,
            initialBytes ?? null,
            desc.mipLevelCount ?? 1,
            desc.arrayLayerCount ?? 1,
            desc.sampleCount ?? 1,
            desc.label ?? null,
          ),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as TextureId);
      },
      destroyTexture: (id: TextureId) =>
        wrapWasmCall('WasmWgpuRenderKernel.destroyTexture', () => this.raw.destroy_texture(id), id),
      createDynamicTexture: (desc: DynamicTextureDesc) => {
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.createDynamicTexture', () =>
          this.raw.create_dynamic_texture(desc.width, desc.height, desc.format),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as DynamicTextureId);
      },
      uploadDynamicTexture: (
        id: DynamicTextureId,
        revision: number,
        width: number,
        height: number,
        source: DynamicTextureUploadSource,
      ) => {
        if (!isByteDynamicSource(source)) {
          return kernelErr(
            'kernel-capability-unsupported',
            'WasmWgpuRenderKernel.uploadDynamicTexture',
            'byte-backed DynamicTextureUploadSource',
            'canvas/image sources are not directly uploadable inside wgpu-wasm',
            id,
          );
        }
        return wrapWasmCall(
          'WasmWgpuRenderKernel.uploadDynamicTexture',
          () => this.raw.upload_dynamic_texture(id, revision, width, height, source),
          id,
        );
      },
      destroyDynamicTexture: (id: DynamicTextureId) =>
        wrapWasmCall(
          'WasmWgpuRenderKernel.destroyDynamicTexture',
          () => this.raw.destroy_dynamic_texture(id),
          id,
        ),
      createBuffer: (desc: KernelBufferDesc, initialBytes?: Uint8Array) => {
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.createBuffer', () =>
          this.raw.create_buffer(desc.size, desc.usage, initialBytes ?? null, desc.label ?? null),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as BufferId);
      },
      writeBuffer: (id: BufferId, offset: number, bytes: Uint8Array) =>
        wrapWasmCall(
          'WasmWgpuRenderKernel.writeBuffer',
          () => this.raw.write_buffer(id, offset, bytes),
          id,
        ),
      destroyBuffer: (id: BufferId) =>
        wrapWasmCall('WasmWgpuRenderKernel.destroyBuffer', () => this.raw.destroy_buffer(id), id),
      createSampler: (desc: KernelSamplerDesc) => {
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.createSampler', () =>
          this.raw.create_sampler(
            1,
            desc.addressModeU ?? null,
            desc.addressModeV ?? null,
            desc.addressModeW ?? null,
            desc.magFilter ?? null,
            desc.minFilter ?? null,
            desc.mipmapFilter ?? null,
            desc.compare ?? null,
            desc.label ?? null,
          ),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as SamplerId);
      },
      destroySampler: (id: SamplerId) =>
        wrapWasmCall('WasmWgpuRenderKernel.destroySampler', () => this.raw.destroy_sampler(id), id),
      registerShaderProgram: (desc: KernelShaderProgramDesc) => {
        const vblJson = desc.vertexBufferLayouts ? JSON.stringify(desc.vertexBufferLayouts) : null;
        const cfJson = desc.colorFormats ? JSON.stringify(desc.colorFormats) : null;
        const hasExtra =
          desc.colorTargets !== undefined ||
          desc.depthStencil !== undefined ||
          desc.cullMode !== undefined ||
          desc.frontFace !== undefined;
        const extraJson = hasExtra
          ? JSON.stringify({
              ...(desc.colorTargets === undefined ? {} : { colorTargets: desc.colorTargets }),
              ...(desc.depthStencil === undefined ? {} : { depthStencil: desc.depthStencil }),
              ...(desc.cullMode === undefined ? {} : { cullMode: desc.cullMode }),
              ...(desc.frontFace === undefined ? {} : { frontFace: desc.frontFace }),
            })
          : null;
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.registerShaderProgram', () =>
          this.raw.register_shader_program(
            desc.code,
            desc.vertexEntryPoint ?? null,
            desc.fragmentEntryPoint ?? null,
            desc.computeEntryPoint ?? null,
            desc.layoutFamilyId,
            vblJson,
            cfJson,
            desc.depthFormat ?? null,
            desc.sampleCount ?? 1,
            desc.blendMode ?? null,
            desc.primitiveTopology ?? null,
            desc.label ?? null,
            extraJson,
          ),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as ShaderProgramId);
      },
      destroyShaderProgram: (id: ShaderProgramId) =>
        wrapWasmCall(
          'WasmWgpuRenderKernel.destroyShaderProgram',
          () => this.raw.destroy_shader_program(id),
          id,
        ),
      createMaterial: (desc: KernelMaterialDesc, initialParamBytes: Uint8Array) => {
        const idRes = wrapWasmCall('WasmWgpuRenderKernel.createMaterial', () =>
          this.raw.create_material(
            desc.shaderProgramId,
            desc.layoutFamilyId,
            desc.renderStateBits,
            desc.variantFlags ?? 0,
            desc.queue ?? 1000,
            initialParamBytes,
            desc.baseColorTextureId ?? 0,
            desc.normalTextureId ?? 0,
            desc.metallicRoughnessTextureId ?? 0,
            desc.emissiveTextureId ?? 0,
            desc.occlusionTextureId ?? 0,
            desc.samplerId ?? 0,
            desc.label ?? null,
          ),
        );
        if (!idRes.ok) return idRes;
        return ok(idRes.value as MaterialId);
      },
      destroyMaterial: (id: MaterialId) =>
        wrapWasmCall(
          'WasmWgpuRenderKernel.destroyMaterial',
          () => this.raw.destroy_material(id),
          id,
        ),
      registerExternalSurface: (_texture: Texture, view: TextureView, _w: number, _h: number) => {
        const rawView = unwrapRhiWgpuHandle(view);
        if (rawView) {
          this.activeTargetViewRaw = rawView;
        }
        return this.nextExternalId++ as SurfaceId;
      },
      registerExternalPipeline: () => this.nextExternalId++ as PipelineId,
    };
  }

  beginSceneDelta(minBytes = 64 * 1024): SceneDeltaWriter {
    const ptr = this.raw.ensure_delta_buffer(minBytes);
    const cap = this.raw.delta_buffer_capacity();
    this.deltaWriter.bindExternal(new Uint8Array(this.mem(), ptr, cap), (needed) => {
      const nextPtr = this.raw.ensure_delta_buffer(needed);
      const nextCap = this.raw.delta_buffer_capacity();
      return new Uint8Array(this.mem(), nextPtr, nextCap);
    });
    return this.deltaWriter;
  }

  commitSceneDelta(writer: SceneDeltaWriter): Result<number, KernelError> {
    if (this.disposed)
      return kernelErr('kernel-disposed', 'WasmWgpuRenderKernel', 'live kernel', 'disposed');
    const slice = writer.finish();
    if (slice.buffer !== this.mem()) {
      const ptr = this.raw.ensure_delta_buffer(slice.byteLength);
      new Uint8Array(this.mem(), ptr, slice.byteLength).set(slice);
    }
    const res = wrapWasmCall('WasmWgpuRenderKernel.commitSceneDelta', () =>
      this.raw.commit_scene_delta_len(slice.byteLength),
    );
    if (!res.ok) return res;
    this.lastRevision = res.value;
    return res;
  }

  beginFrame(
    frameId: number,
    surfaceWidth: number,
    surfaceHeight: number,
  ): Result<FrameRecorder, KernelError> {
    if (this.disposed)
      return kernelErr('kernel-disposed', 'WasmWgpuRenderKernel', 'live kernel', 'disposed');
    const res = wrapWasmCall('WasmWgpuRenderKernel.beginFrame', () =>
      this.raw.begin_frame(frameId, surfaceWidth, surfaceHeight),
    );
    if (!res.ok) return res;
    this.activeFrameId = frameId;
    const ptr = this.raw.ensure_cmd_buffer(8192);
    const cap = this.raw.cmd_buffer_capacity();
    this.recorder.bindExternalCmds(new Uint32Array(this.mem(), ptr, cap), (needed) => {
      const nextPtr = this.raw.ensure_cmd_buffer(needed);
      const nextCap = this.raw.cmd_buffer_capacity();
      return new Uint32Array(this.mem(), nextPtr, nextCap);
    });
    this.recorder.reset();
    return ok(this.recorder);
  }

  cull(params: KernelCullParams): Result<KernelCullSummary, KernelError> {
    const vpPtr = this.raw.cull_vp_ptr();
    new Float32Array(this.mem(), vpPtr, 16).set(params.viewProj.subarray(0, 16));
    const layerMask = (params.layerMask ?? 0xffff_ffff) >>> 0;
    const flags = (params.flags ?? CULL_FLAG_CULL_LIGHTS | CULL_FLAG_COMPUTE_VISIBLE_BOUNDS) >>> 0;
    const res = wrapWasmCall('WasmWgpuRenderKernel.cull', () =>
      this.raw.cull(
        params.cameraPos[0],
        params.cameraPos[1],
        params.cameraPos[2],
        layerMask,
        flags,
        params.lodBias ?? 0,
      ),
    );
    if (!res.ok) return res;

    const sumPtr = this.raw.cull_summary_ptr();
    const sum = new Uint32Array(this.mem(), sumPtr, 14);
    const lightCount = sum[12] as number;
    this.lightsOut.length = 0;
    if (lightCount > 0) {
      const lPtr = this.raw.cull_lights_ptr();
      const l = new Uint32Array(this.mem(), lPtr, lightCount * 3);
      for (let i = 0; i < lightCount; i++) {
        const meta = l[i * 3 + 1] as number;
        this.lightsOut.push({
          lightId: l[i * 3] as number as LightId,
          kind: (meta & 0xff) as 0 | 1 | 2,
          castShadow: ((meta >>> 8) & 1) !== 0,
          cascadeCount: (meta >>> 16) & 0xff,
          screenCoverage: bitsToF32(l[i * 3 + 2] as number),
        });
      }
    }

    return ok({
      cullId: sum[0] as number as CullId,
      candidateCount: sum[1] as number,
      visibleOpaqueCount: sum[2] as number,
      visibleMaskedCount: sum[3] as number,
      visibleTransparentCount: sum[4] as number,
      visibleShadowCasterCount: sum[5] as number,
      visibleBoundsMin: [
        bitsToF32(sum[6] as number),
        bitsToF32(sum[7] as number),
        bitsToF32(sum[8] as number),
      ],
      visibleBoundsMax: [
        bitsToF32(sum[9] as number),
        bitsToF32(sum[10] as number),
        bitsToF32(sum[11] as number),
      ],
      visibleLights: this.lightsOut,
    });
  }

  submitFrame(recorder: FrameRecorder): Result<FrameSubmitReceipt, KernelError> {
    if (this.activeFrameId === undefined) {
      return kernelErr(
        'kernel-command-stream-malformed',
        'WasmWgpuRenderKernel.submitFrame',
        'active frame',
        'call beginFrame first',
      );
    }
    const frameId = this.activeFrameId;
    this.activeFrameId = undefined;

    const slice = recorder.commandSlice;
    if (slice.buffer !== this.mem()) {
      const ptr = this.raw.ensure_cmd_buffer(slice.length);
      new Uint32Array(this.mem(), ptr, slice.length).set(slice);
    }

    const submitRes = wrapWasmCall('WasmWgpuRenderKernel.submitFrame', () =>
      this.raw.submit_frame_words(
        slice.length,
        recorder.uniformDataSlice,
        this.activeTargetViewRaw ?? null,
      ),
    );
    if (!submitRes.ok) return submitRes;

    const rPtr = this.raw.receipt_ptr();
    const r = new Uint32Array(this.mem(), rPtr, 10);
    const bPtr = this.raw.submitted_bitmap_ptr();
    const bLen = this.raw.submitted_bitmap_len();
    const physLen = this.raw.resolved_cmds_len();
    const resolvedPhysicalCommands =
      physLen > 0
        ? new Uint32Array(new Uint32Array(this.mem(), this.raw.resolved_cmds_ptr(), physLen))
        : new Uint32Array(0);

    return ok({
      frameId,
      sceneRevision: this.lastRevision,
      status: (r[4] as number) > 0 ? 'pending-pipelines' : 'ready',
      submittedPassCount: r[0] as number,
      mergedPassCount: r[1] as number,
      submittedDrawCount: r[2] as number,
      submittedIndirectCount: r[3] as number,
      pendingPipelineCount: r[4] as number,
      firstMissingObjectId: r[5] as number as RenderObjectId | 0,
      firstMissingSubmesh: r[6] as number,
      poolTextureCount: r[7] as number,
      poolAllocations: r[8] as number,
      poolReuses: r[9] as number,
      resolvedPhysicalCommands,
      submittedBitmap: new Uint32Array(new Uint32Array(this.mem(), bPtr, bLen)),
    });
  }

  getPoolTexture(_poolSlotId: number): Texture | undefined {
    return undefined;
  }

  async readbackTicket(
    ticketId: number,
  ): Promise<Result<import('./contract.js').KernelReadbackResult, KernelError>> {
    if (this.disposed)
      return kernelErr('kernel-disposed', 'WasmWgpuRenderKernel', 'live kernel', 'disposed');
    return wrapWasmCall(
      'WasmWgpuRenderKernel.readbackTicket',
      () => this.raw.readback_ticket(ticketId),
      ticketId,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeTargetViewRaw = undefined;
    this.raw.free();
  }
}
