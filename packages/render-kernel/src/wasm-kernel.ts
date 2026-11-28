// Rust WASM RenderKernel backed by pure-compute `forgeax-render-kernel-wasm` + linear RHI replay.
// Zero-copy linear memory sharing for SceneDelta, CullParams, FrameCommandStream, and resolved PHYS_* stream.

import type { RhiCaps, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import initWasm, * as wasmExports from '../wasm/forgeax_render_kernel_wasm.js';
import { bitsToF32, FrameRecorder } from './command-stream.js';
import {
  CULL_FLAG_COMPUTE_VISIBLE_BOUNDS,
  CULL_FLAG_CULL_LIGHTS,
  type FrameSubmitReceipt,
  type KernelAssetApi,
  type KernelBufferDesc,
  type KernelCreateShaderModuleImmediate,
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
import type { DynamicTextureDesc, DynamicTextureUploadSource } from './dynamic-texture.js';
import { type KernelError, kernelErr, ok, parseKernelErrorCode, type Result } from './errors.js';
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
import { RhiPhysicalExecutor } from './rhi-replay.js';
import { SceneDeltaWriter } from './scene-delta.js';

export interface WasmKernelModule {
  default: (
    moduleOrPath?:
      | { module_or_path?: BufferSource | WebAssembly.Module | RequestInfo | URL }
      | BufferSource
      | WebAssembly.Module
      | RequestInfo
      | URL,
  ) => Promise<unknown>;
  WasmRenderKernel: new () => RawWasmKernel;
  WasmHotPathAccel: new (initialCapacity: number) => RawWasmHotPathAccel;
  wasm_memory: () => WebAssembly.Memory;
}

export interface RawWasmKernel {
  free(): void;
  register_mesh(
    vertexLayoutId: number,
    indexCount: number,
    vertexCount: number,
    isU32: boolean,
    topology: number,
  ): number;
  set_mesh_submeshes?(id: number, packed: Uint32Array): void;
  destroy_mesh(id: number): void;
  register_texture(w: number, h: number, fmt: number): number;
  destroy_texture(id: number): void;
  register_dynamic_texture(w: number, h: number, fmt: number): number;
  update_dynamic_texture(id: number, rev: number, w: number, h: number): boolean;
  destroy_dynamic_texture(id: number): void;
  register_buffer(byteSize: number): number;
  destroy_buffer(id: number): void;
  register_sampler(hash: number): number;
  destroy_sampler(id: number): void;
  register_shader(layoutFamilyId: number): number;
  destroy_shader(id: number): void;
  register_material(
    shaderId: number,
    layoutFamilyId: number,
    renderStateBits: number,
    variantFlags: number,
    queue: number,
    paramBytesLen: number,
  ): number;
  destroy_material(id: number): void;
  ensure_delta_buffer(minBytes: number): number;
  delta_buffer_capacity(): number;
  commit_scene_delta_len(byteLen: number): number;
  begin_frame(frameId: number, width: number, height: number): void;
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
  submit_frame_words(wordLen: number): number;
  resolved_cmds_ptr(): number;
  resolved_cmds_len(): number;
  receipt_ptr(): number;
  submitted_bitmap_ptr(): number;
  submitted_bitmap_len(): number;
  object_count(): number;
  instance_rows_ptr?(): number;
  instance_rows_len?(): number;
  pack_scene_objects_gpu?(): number;
  scene_objects_gpu_ptr?(): number;
  pack_scene_lights_gpu?(): number;
  scene_lights_gpu_ptr?(): number;
}

export interface RawWasmHotPathAccel {
  free(): void;
  ensure_capacity(count: number): void;
  ensure_frustum_cameras(cameraCount: number): void;
  local_aabbs_ptr(): number;
  world_matrices_ptr(): number;
  flags_ptr(): number;
  layer_masks_ptr(): number;
  camera_vp_ptr(): number;
  out_visible_ptr(): number;
  out_world_aabbs_ptr(): number;
  world_aabbs_ptr(): number;
  frustum_planes_ptr(): number;
  out_vis_bits_ptr(): number;
  run_cull_world_aabbs(count: number, cameraCount: number): number;
  run_transform_and_cull(
    count: number,
    cameraLayerMask: number,
    shadowCasterOnly: boolean,
    writeWorldAabbs: boolean,
  ): number;
  sort_positions_ptr(): number;
  sort_layers_ptr(): number;
  sort_ties_ptr(): number;
  out_sort_order_ptr(): number;
  run_sort_transparent(count: number, eyeX: number, eyeY: number, eyeZ: number): void;
}

let cachedWasmModule: WasmKernelModule | undefined;
let cachedWasmPromise: Promise<Result<WasmKernelModule, KernelError>> | undefined;

interface NodeProcessLike {
  readonly versions?: { readonly node?: string };
}
interface NodeFsLike {
  readFile(path: URL): Promise<Uint8Array<ArrayBuffer>>;
}

function decodeDataUrlBytes(url: URL): Uint8Array<ArrayBuffer> {
  const comma = url.href.indexOf(',');
  if (comma < 0) throw new Error('render-kernel wasm data URL is malformed');
  const payload = decodeURIComponent(url.href.slice(comma + 1));
  if (url.href.slice(0, comma).toLowerCase().endsWith(';base64')) {
    const bin = atob(payload);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const encoded = new TextEncoder().encode(payload);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/** Loads and initializes the lightweight pure-compute Rust WASM module (Node + Browser + Worker safe). */
export async function loadRenderKernelWasm(
  wasmBytes?: BufferSource,
): Promise<Result<WasmKernelModule, KernelError>> {
  if (cachedWasmModule !== undefined) return ok(cachedWasmModule);
  if (cachedWasmPromise !== undefined) return cachedWasmPromise;

  cachedWasmPromise = (async (): Promise<Result<WasmKernelModule, KernelError>> => {
    try {
      const mod: WasmKernelModule = {
        default: initWasm as unknown as WasmKernelModule['default'],
        WasmRenderKernel:
          wasmExports.WasmRenderKernel as unknown as WasmKernelModule['WasmRenderKernel'],
        WasmHotPathAccel:
          wasmExports.WasmHotPathAccel as unknown as WasmKernelModule['WasmHotPathAccel'],
        wasm_memory: wasmExports.wasm_memory as unknown as WasmKernelModule['wasm_memory'],
      };
      let input: BufferSource | URL | undefined = wasmBytes;
      if (input === undefined) {
        const defaultRel = import.meta.url.endsWith('/src/wasm-kernel.ts')
          ? '../dist/forgeax_render_kernel_wasm_bg.wasm'
          : './forgeax_render_kernel_wasm_bg.wasm';
        const wasmUrl = new URL(defaultRel, import.meta.url);
        const proc = (globalThis as unknown as { process?: NodeProcessLike }).process;
        if (typeof proc?.versions?.node === 'string') {
          const fsModuleId = 'node:fs/promises';
          const fs = (await import(/* @vite-ignore */ fsModuleId)) as unknown as NodeFsLike;
          const candidateRels = [
            defaultRel,
            './forgeax_render_kernel_wasm_bg.wasm',
            '../dist/forgeax_render_kernel_wasm_bg.wasm',
            '../wasm/forgeax_render_kernel_wasm_bg.wasm',
          ];
          let lastError: unknown;
          for (const rel of candidateRels) {
            try {
              input = await fs.readFile(new URL(rel, import.meta.url));
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (input === undefined) throw lastError;
        } else if (wasmUrl.protocol === 'data:') {
          input = decodeDataUrlBytes(wasmUrl);
        } else if (wasmUrl.protocol === 'http:' || wasmUrl.protocol === 'https:') {
          input = wasmUrl;
        } else {
          // Single-HTML (`forgeax-resource:`), `file:`, and `blob:` bundles do not serve loose
          // `.wasm` siblings; decline cleanly without issuing a missing-resource fetch.
          cachedWasmPromise = undefined;
          return kernelErr(
            'kernel-capability-unsupported',
            'loadRenderKernelWasm',
            'http/https/data URL or explicit wasmBytes',
            `unsupported protocol ${wasmUrl.protocol}`,
          );
        }
      }
      await mod.default({ module_or_path: input });
      cachedWasmModule = mod;
      return ok(mod);
    } catch (cause) {
      cachedWasmPromise = undefined;
      return kernelErr(
        'kernel-backend-runtime-error',
        'loadRenderKernelWasm',
        'initialized forgeax_render_kernel_wasm',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  })();
  return cachedWasmPromise;
}

export function wrapWasmCall<T>(
  owner: string,
  fn: () => T,
  handle?: number,
): Result<T, KernelError> {
  try {
    return ok(fn());
  } catch (cause) {
    return kernelErr(
      parseKernelErrorCode(cause),
      owner,
      'valid kernel operation',
      typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : String(cause),
      handle,
    );
  }
}

export class WasmRenderKernel implements RenderKernel {
  readonly backendKind = 'rust-wasm-rhi' as const;
  readonly mode = 'wasm' as const;
  readonly caps: Readonly<RhiCaps>;
  readonly device: RhiDevice;
  readonly assets: KernelAssetApi;

  private readonly mod: WasmKernelModule;
  private readonly raw: RawWasmKernel;
  private readonly executor: RhiPhysicalExecutor;
  private readonly deltaWriter = new SceneDeltaWriter(64 * 1024);
  private readonly recorder = new FrameRecorder(8192, 64 * 1024);
  private activeFrameId: number | undefined;
  private lastRevision = 0;
  private disposed = false;

  constructor(
    device: RhiDevice,
    mod: WasmKernelModule,
    createShaderModuleImmediate?: KernelCreateShaderModuleImmediate,
  ) {
    this.device = device;
    this.caps = device.caps;
    this.mod = mod;
    this.raw = new mod.WasmRenderKernel();
    this.executor = new RhiPhysicalExecutor(device, createShaderModuleImmediate);
    this.assets = this.createAssetApi();
  }

  get supportsScene4Bgl(): boolean {
    return this.executor.supportsScene4Bgl;
  }

  private mem(): ArrayBuffer {
    return this.mod.wasm_memory().buffer;
  }

  private createAssetApi(): KernelAssetApi {
    return {
      createMesh: (desc: KernelMeshDesc, vertexBytes: Uint8Array, indexBytes?: Uint8Array) => {
        if (this.disposed)
          return kernelErr('kernel-disposed', 'WasmRenderKernel', 'live kernel', 'disposed');
        const idRes = wrapWasmCall('WasmRenderKernel.createMesh', () =>
          this.raw.register_mesh(
            desc.vertexLayoutId,
            desc.indexCount,
            desc.vertexCount,
            desc.isUint32Index === true,
            desc.topology ?? 0,
          ),
        );
        if (!idRes.ok) return idRes;
        if (
          desc.submeshes !== undefined &&
          desc.submeshes.length > 0 &&
          typeof this.raw.set_mesh_submeshes === 'function'
        ) {
          const packed = new Uint32Array(desc.submeshes.length * 5);
          for (let i = 0; i < desc.submeshes.length; i++) {
            const s = desc.submeshes[i];
            if (s === undefined) continue;
            packed[i * 5] = (s.firstIndex ?? 0) >>> 0;
            packed[i * 5 + 1] = (s.indexCount ?? 0) >>> 0;
            packed[i * 5 + 2] = (s.baseVertex ?? 0) | 0;
            packed[i * 5 + 3] = (s.firstVertex ?? 0) >>> 0;
            packed[i * 5 + 4] = (s.vertexCount ?? 0) >>> 0;
          }
          this.raw.set_mesh_submeshes(idRes.value, packed);
        }
        const r = this.executor.createMesh(idRes.value, desc, vertexBytes, indexBytes);
        if (!r.ok) {
          this.raw.destroy_mesh(idRes.value);
          return r;
        }
        return ok(idRes.value as MeshId);
      },
      destroyMesh: (id: MeshId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroyMesh',
          () => this.raw.destroy_mesh(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroyMesh(id);
        return ok(undefined);
      },
      createTexture: (desc: KernelTextureDesc, initialBytes?: Uint8Array) => {
        const idRes = wrapWasmCall('WasmRenderKernel.createTexture', () =>
          this.raw.register_texture(desc.width, desc.height, desc.format),
        );
        if (!idRes.ok) return idRes;
        const r = this.executor.createTexture(idRes.value, desc, initialBytes);
        if (!r.ok) {
          this.raw.destroy_texture(idRes.value);
          return r;
        }
        return ok(idRes.value as TextureId);
      },
      destroyTexture: (id: TextureId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroyTexture',
          () => this.raw.destroy_texture(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroyTexture(id);
        return ok(undefined);
      },
      createDynamicTexture: (desc: DynamicTextureDesc) => {
        const idRes = wrapWasmCall('WasmRenderKernel.createDynamicTexture', () =>
          this.raw.register_dynamic_texture(desc.width, desc.height, desc.format),
        );
        if (!idRes.ok) return idRes;
        const r = this.executor.createDynamicTexture(idRes.value, desc);
        if (!r.ok) {
          this.raw.destroy_dynamic_texture(idRes.value);
          return r;
        }
        return ok(idRes.value as DynamicTextureId);
      },
      uploadDynamicTexture: (
        id: DynamicTextureId,
        revision: number,
        width: number,
        height: number,
        source: DynamicTextureUploadSource,
      ) => {
        const reRes = wrapWasmCall(
          'WasmRenderKernel.uploadDynamicTexture',
          () => this.raw.update_dynamic_texture(id, revision, width, height),
          id,
        );
        if (!reRes.ok) return reRes;
        const up = this.executor.uploadDynamicTexture(id, reRes.value, width, height, source);
        if (!up.ok) return up;
        return ok(reRes.value);
      },
      destroyDynamicTexture: (id: DynamicTextureId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroyDynamicTexture',
          () => this.raw.destroy_dynamic_texture(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroyDynamicTexture(id);
        return ok(undefined);
      },
      createBuffer: (desc: KernelBufferDesc, initialBytes?: Uint8Array) => {
        const idRes = wrapWasmCall('WasmRenderKernel.createBuffer', () =>
          this.raw.register_buffer(desc.size),
        );
        if (!idRes.ok) return idRes;
        const r = this.executor.createBuffer(idRes.value, desc, initialBytes);
        if (!r.ok) {
          this.raw.destroy_buffer(idRes.value);
          return r;
        }
        return ok(idRes.value as BufferId);
      },
      writeBuffer: (id: BufferId, offset: number, bytes: Uint8Array) =>
        this.executor.writeBuffer(id, offset, bytes),
      destroyBuffer: (id: BufferId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroyBuffer',
          () => this.raw.destroy_buffer(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroyBuffer(id);
        return ok(undefined);
      },
      createSampler: (desc: KernelSamplerDesc) => {
        const idRes = wrapWasmCall('WasmRenderKernel.createSampler', () =>
          this.raw.register_sampler(1),
        );
        if (!idRes.ok) return idRes;
        const r = this.executor.createSampler(idRes.value, desc);
        if (!r.ok) {
          this.raw.destroy_sampler(idRes.value);
          return r;
        }
        return ok(idRes.value as SamplerId);
      },
      destroySampler: (id: SamplerId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroySampler',
          () => this.raw.destroy_sampler(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroySampler(id);
        return ok(undefined);
      },
      registerShaderProgram: (desc: KernelShaderProgramDesc) => {
        const idRes = wrapWasmCall('WasmRenderKernel.registerShaderProgram', () =>
          this.raw.register_shader(desc.layoutFamilyId),
        );
        if (!idRes.ok) return idRes;
        const r = this.executor.registerShaderProgram(idRes.value, desc);
        if (!r.ok) {
          this.raw.destroy_shader(idRes.value);
          return r;
        }
        return ok(idRes.value as ShaderProgramId);
      },
      destroyShaderProgram: (id: ShaderProgramId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroyShaderProgram',
          () => this.raw.destroy_shader(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroyShaderProgram(id);
        return ok(undefined);
      },
      createMaterial: (desc: KernelMaterialDesc, initialParamBytes: Uint8Array) => {
        const idRes = wrapWasmCall('WasmRenderKernel.createMaterial', () =>
          this.raw.register_material(
            desc.shaderProgramId,
            desc.layoutFamilyId,
            desc.renderStateBits,
            desc.variantFlags ?? 0,
            desc.queue ?? 1000,
            initialParamBytes.byteLength,
          ),
        );
        if (!idRes.ok) return idRes;
        const r = this.executor.createMaterial(idRes.value, desc, initialParamBytes);
        if (!r.ok) {
          this.raw.destroy_material(idRes.value);
          return r;
        }
        return ok(idRes.value as MaterialId);
      },
      updateMaterialParams: (id: MaterialId, paramBytes: Uint8Array) =>
        this.executor.updateMaterialParams(id, paramBytes),
      destroyMaterial: (id: MaterialId) => {
        const res = wrapWasmCall(
          'WasmRenderKernel.destroyMaterial',
          () => this.raw.destroy_material(id),
          id,
        );
        if (!res.ok) return res;
        this.executor.destroyMaterial(id);
        return ok(undefined);
      },
      setSkinJoints: (slotOffset: number, jointMatrices: Float32Array) =>
        this.executor.uploadSkinJoints(slotOffset, jointMatrices),
      registerExternalSurface: (
        texture: Texture,
        view: TextureView,
        width: number,
        height: number,
      ) => this.executor.registerExternalSurface(texture, view, width, height) as SurfaceId,
      registerExternalPipeline: (pipeline) =>
        this.executor.registerExternalPipeline(pipeline) as PipelineId,
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
      return kernelErr('kernel-disposed', 'WasmRenderKernel', 'live kernel', 'disposed');
    const slice = writer.finish();
    // If the caller wrote into a standalone writer, copy into WASM staging buffer.
    if (slice.buffer !== this.mem()) {
      const ptr = this.raw.ensure_delta_buffer(slice.byteLength);
      new Uint8Array(this.mem(), ptr, slice.byteLength).set(slice);
    }
    const res = wrapWasmCall('WasmRenderKernel.commitSceneDelta', () =>
      this.raw.commit_scene_delta_len(slice.byteLength),
    );
    if (res.ok) {
      this.lastRevision = res.value;
      if (
        this.executor.supportsScene4Bgl &&
        typeof this.raw.pack_scene_objects_gpu === 'function' &&
        typeof this.raw.scene_objects_gpu_ptr === 'function'
      ) {
        const objBytes = this.raw.pack_scene_objects_gpu();
        if (objBytes > 0) {
          this.executor.uploadSceneObjects(
            new Uint8Array(this.mem(), this.raw.scene_objects_gpu_ptr(), objBytes),
          );
        }
      }
      if (
        this.executor.supportsScene4Bgl &&
        typeof this.raw.pack_scene_lights_gpu === 'function' &&
        typeof this.raw.scene_lights_gpu_ptr === 'function'
      ) {
        const lgtBytes = this.raw.pack_scene_lights_gpu();
        if (lgtBytes > 0) {
          this.executor.uploadSceneLights(
            new Uint8Array(this.mem(), this.raw.scene_lights_gpu_ptr(), lgtBytes),
          );
        }
      }
    }
    return res;
  }

  beginFrame(
    frameId: number,
    surfaceWidth: number,
    surfaceHeight: number,
  ): Result<FrameRecorder, KernelError> {
    if (this.disposed)
      return kernelErr('kernel-disposed', 'WasmRenderKernel', 'live kernel', 'disposed');
    const res = wrapWasmCall('WasmRenderKernel.beginFrame', () =>
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
    const res = wrapWasmCall('WasmRenderKernel.cull', () =>
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
    const visibleLights: KernelVisibleLightSummary[] = [];
    if (lightCount > 0) {
      const lPtr = this.raw.cull_lights_ptr();
      const lWords = new Uint32Array(this.mem(), lPtr, lightCount * 3);
      for (let i = 0; i < lightCount; i++) {
        const b = i * 3;
        const meta = lWords[b + 1] as number;
        visibleLights.push({
          lightId: lWords[b] as number as LightId,
          kind: (meta & 0xff) as 0 | 1 | 2,
          castShadow: ((meta >>> 8) & 1) !== 0,
          cascadeCount: (meta >>> 16) & 0xff,
          screenCoverage: bitsToF32(lWords[b + 2] as number),
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
      visibleLights,
    });
  }

  submitFrame(recorder: FrameRecorder): Result<FrameSubmitReceipt, KernelError> {
    if (this.activeFrameId === undefined) {
      return kernelErr(
        'kernel-command-stream-malformed',
        'WasmRenderKernel.submitFrame',
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

    const lenRes = wrapWasmCall('WasmRenderKernel.submitFrame', () =>
      this.raw.submit_frame_words(slice.length),
    );
    if (!lenRes.ok) return lenRes;

    if (
      this.executor.supportsScene4Bgl &&
      typeof this.raw.instance_rows_ptr === 'function' &&
      typeof this.raw.instance_rows_len === 'function'
    ) {
      const instLen = this.raw.instance_rows_len();
      if (instLen > 0) {
        this.executor.uploadInstanceRows(
          new Uint32Array(this.mem(), this.raw.instance_rows_ptr(), instLen),
        );
      }
    }

    const physPtr = this.raw.resolved_cmds_ptr();
    const physLen = this.raw.resolved_cmds_len();
    const physView = new Uint32Array(this.mem(), physPtr, physLen);
    const execRes = this.executor.executePhysicalStream(physView, recorder.uniformDataSlice);
    if (!execRes.ok) return execRes;

    const rPtr = this.raw.receipt_ptr();
    const r = new Uint32Array(this.mem(), rPtr, 10);
    const bPtr = this.raw.submitted_bitmap_ptr();
    const bLen = this.raw.submitted_bitmap_len();

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
      resolvedPhysicalCommands: new Uint32Array(physView),
      submittedBitmap: new Uint32Array(new Uint32Array(this.mem(), bPtr, bLen)),
    });
  }

  getPoolTexture(poolSlotId: number): Texture | undefined {
    return this.executor.getPoolTexture(poolSlotId);
  }

  readbackTicket(
    ticketId: number,
  ): Promise<Result<import('./contract.js').KernelReadbackResult, KernelError>> {
    return this.executor.readbackTicket(ticketId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.executor.dispose();
    this.raw.free();
  }
}
