// Zero-allocation linear physical command stream executor onto any @forgeax/engine-rhi device.
// Because every GPU command executes through RhiDevice/RhiCommandEncoder, @forgeax/engine-rhi-debug
// captures, decodes, inspects, and replays both TS Kernel and Rust WASM Kernel frames natively.

import type {
  BindGroup,
  BindGroupEntry,
  Buffer,
  ComputePipeline,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RenderPipeline,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiComputePipelineOps,
  RhiDevice,
  RhiRenderPassEncoder,
  RhiRenderPipelineOps,
  Sampler,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  BINDING_KIND_BUFFER,
  BINDING_KIND_DYNAMIC_TEXTURE,
  BINDING_KIND_SAMPLER,
  BINDING_KIND_TEMP_TEXTURE,
  BINDING_KIND_TEXTURE,
  BINDING_KIND_UNIFORM_SLICE,
  BINDING_TEX_SUBRESOURCE_FLAG,
  bitsToF32,
  LOAD_OP_LOAD,
  PHYS_BEGIN_COMPUTE_PASS,
  PHYS_BEGIN_RENDER_PASS,
  PHYS_COPY_BUFFER,
  PHYS_COPY_TEXTURE,
  PHYS_DEF_BINDING_SET,
  PHYS_DISPATCH,
  PHYS_DISPATCH_INDIRECT,
  PHYS_DRAW,
  PHYS_DRAW_FULLSCREEN,
  PHYS_DRAW_INDEXED,
  PHYS_DRAW_INDIRECT,
  PHYS_END_COMPUTE_PASS,
  PHYS_END_RENDER_PASS,
  PHYS_ENSURE_POOL_TEX,
  PHYS_GENERATE_MIPS,
  PHYS_REQUEST_READBACK,
  PHYS_RETIRE_POOL_TEX,
  PHYS_SET_BIND_GROUP,
  PHYS_SET_IB,
  PHYS_SET_PSO,
  PHYS_SET_SCISSOR,
  PHYS_SET_VB,
  PHYS_SET_VIEWPORT,
  STORE_OP_DISCARD,
} from './command-stream.js';
import type {
  KernelBlendMode,
  KernelBufferDesc,
  KernelCreateShaderModuleImmediate,
  KernelMaterialDesc,
  KernelMeshDesc,
  KernelReadbackResult,
  KernelSamplerDesc,
  KernelShaderProgramDesc,
  KernelTextureDesc,
} from './contract.js';
import {
  type DynamicTextureDesc,
  type DynamicTextureUploadSource,
  isByteDynamicSource,
  textureFormatBytesPerPixel,
  textureFormatCodeToGPUTextureFormat,
} from './dynamic-texture.js';
import { type KernelError, kernelErr, ok, type Result } from './errors.js';
import { INVALID_HANDLE, TEMP_TEXTURE_TAG_BIT } from './handles.js';
import {
  BGL_SLOT_INSTANCES,
  BGL_SLOT_MATERIAL,
  BGL_SLOT_MESH_SCENE,
  BGL_SLOT_VIEW,
  LAYOUT_FAMILY_SCENE_4BGL,
  PASS_TAG_DEPTH_PREPASS,
  PASS_TAG_SHADOW_DEPTH,
  psoKeyBigInt,
  RENDER_STATE_ALPHA_BLEND,
} from './pso-key.js';
import { RhiScene4BglState } from './rhi-scene-4bgl.js';

interface RhiMeshRecord {
  readonly vb: Buffer;
  readonly ib?: Buffer;
  readonly isUint32Index: boolean;
  readonly desc: KernelMeshDesc;
}

interface RhiTexRecord {
  texture: Texture;
  view: TextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  mipLevelCount: number;
  arrayLayerCount: number;
}

interface RhiShaderRecord {
  readonly module: ShaderModule;
  readonly desc: KernelShaderProgramDesc;
  fullscreenPipeline?: RenderPipeline;
  computePipeline?: ComputePipeline;
}

interface RhiMaterialRecord {
  readonly desc: KernelMaterialDesc;
  readonly uniformBuffer: Buffer;
  bindGroup?: BindGroup;
}

interface RhiPoolTexRecord {
  texture: Texture;
  view: TextureView;
  width: number;
  height: number;
  format: GPUTextureFormat;
  samples: number;
  mipLevelCount: number;
  arrayLayerCount: number;
}

interface PendingRhiReadback {
  readonly staging: Buffer;
  readonly width: number;
  readonly height: number;
  readonly unpaddedRow: number;
  readonly paddedRow: number;
  readonly format: GPUTextureFormat;
}

const MIPGEN_WGSL = /* wgsl */ `
@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_smp: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(src_tex, src_smp, in.uv);
}
`;

const GPU_USAGE_MAP_READ = 0x0001;
const GPU_USAGE_COPY_DST = 0x0008;
const GPU_USAGE_INDEX = 0x0010;
const GPU_USAGE_VERTEX = 0x0020;
const GPU_USAGE_UNIFORM = 0x0040;
const GPU_TEX_COPY_SRC = 0x01;
const GPU_TEX_COPY_DST = 0x02;
const GPU_TEX_TEXTURE_BINDING = 0x04;
const GPU_TEX_RENDER_ATTACHMENT = 0x10;

function toGpuBlendState(mode?: KernelBlendMode): GPUBlendState | undefined {
  if (mode === 'alpha') {
    return {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
  }
  if (mode === 'premultiplied') {
    return {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
  }
  if (mode === 'additive') {
    return {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
  }
  return undefined;
}

function buildRhiColorTargets(desc: KernelShaderProgramDesc): GPUColorTargetState[] {
  const defaultBlend = toGpuBlendState(desc.blendMode);
  if (desc.colorTargets !== undefined && desc.colorTargets.length > 0) {
    return desc.colorTargets.map((ct) => {
      const blend =
        ct.blendMode === 'none' ? undefined : (toGpuBlendState(ct.blendMode) ?? defaultBlend);
      return {
        format: ct.format,
        ...(blend === undefined ? {} : { blend }),
        ...(ct.writeMask === undefined ? {} : { writeMask: ct.writeMask }),
      };
    });
  }
  const formats = desc.colorFormats ?? ['rgba8unorm'];
  return formats.map((format) => ({
    format,
    ...(defaultBlend === undefined ? {} : { blend: defaultBlend }),
  }));
}

function buildRhiDepthStencil(
  desc: KernelShaderProgramDesc,
  defaultWrite: boolean,
  defaultCompare: GPUCompareFunction,
): GPUDepthStencilState | undefined {
  if (desc.depthStencil !== undefined) {
    const ds = desc.depthStencil;
    return {
      format: ds.format,
      depthWriteEnabled: ds.depthWriteEnabled ?? defaultWrite,
      depthCompare: ds.depthCompare ?? defaultCompare,
      ...(ds.depthBias === undefined ? {} : { depthBias: ds.depthBias }),
      ...(ds.depthBiasSlopeScale === undefined
        ? {}
        : { depthBiasSlopeScale: ds.depthBiasSlopeScale }),
      ...(ds.depthBiasClamp === undefined ? {} : { depthBiasClamp: ds.depthBiasClamp }),
    };
  }
  if (desc.depthFormat === undefined) return undefined;
  return {
    format: desc.depthFormat,
    depthWriteEnabled: defaultWrite,
    depthCompare: defaultCompare,
  };
}

function isDepthOnlyShaderDesc(desc: KernelShaderProgramDesc): boolean {
  if (desc.fragmentEntryPoint !== undefined) return false;
  if (desc.colorFormats !== undefined && desc.colorFormats.length > 0) return false;
  if (desc.colorTargets !== undefined && desc.colorTargets.length > 0) return false;
  return desc.depthFormat !== undefined || desc.depthStencil !== undefined;
}

function decodeRenderStateDepthCompare(renderStateBits: number): GPUCompareFunction {
  const code = (renderStateBits >>> 1) & 0x3;
  if (code === 1) return 'greater-equal';
  if (code === 2) return 'less';
  if (code === 3) return 'always';
  return 'less-equal';
}

function decodeRenderStateCullMode(renderStateBits: number): GPUCullMode | undefined {
  const code = (renderStateBits >>> 3) & 0x3;
  if (code === 1) return 'back';
  if (code === 2) return 'front';
  return undefined;
}

function buildRhiPrimitiveState(
  desc: KernelShaderProgramDesc,
  renderStateBits: number,
): GPUPrimitiveState {
  const cullMode = desc.cullMode ?? decodeRenderStateCullMode(renderStateBits);
  return {
    topology: desc.primitiveTopology ?? 'triangle-list',
    ...(cullMode === undefined ? {} : { cullMode }),
    ...(desc.frontFace === undefined ? {} : { frontFace: desc.frontFace }),
  };
}

function buildRhiRenderPipelineDesc(
  shader: { desc: KernelShaderProgramDesc; module: ShaderModule },
  slotId: number,
  passTag: number,
  renderStateBits: number,
  pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout | 'auto',
): Parameters<RhiDevice['createRenderPipeline']>[0] {
  const { desc, module } = shader;
  const depthOnly =
    passTag === PASS_TAG_SHADOW_DEPTH ||
    passTag === PASS_TAG_DEPTH_PREPASS ||
    isDepthOnlyShaderDesc(desc);
  const depthWrite = renderStateBits === 0 || (renderStateBits & 1) !== 0;
  const depthCompare = decodeRenderStateDepthCompare(renderStateBits);
  const rawDepthStencil = buildRhiDepthStencil(desc, depthWrite, depthCompare);
  const depthStencil =
    rawDepthStencil !== undefined && depthOnly && desc.depthStencil === undefined
      ? { ...rawDepthStencil, depthBias: 2, depthBiasSlopeScale: 2.0, depthBiasClamp: 0.0 }
      : rawDepthStencil;
  const alphaBlendDesc =
    (renderStateBits & RENDER_STATE_ALPHA_BLEND) !== 0 && desc.blendMode === undefined
      ? { ...desc, blendMode: 'alpha' as const }
      : desc;
  const label = desc.label ? `${desc.label}.pso.${slotId}` : `kernel.pso.${slotId}`;
  return {
    label,
    layout: pipelineLayout,
    vertex: {
      module,
      entryPoint: desc.vertexEntryPoint ?? 'vs_main',
      buffers: [...(desc.vertexBufferLayouts ?? [])],
    },
    ...(depthOnly
      ? {}
      : {
          fragment: {
            module,
            entryPoint: desc.fragmentEntryPoint ?? 'fs_main',
            targets: buildRhiColorTargets(alphaBlendDesc),
          },
        }),
    primitive: buildRhiPrimitiveState(desc, renderStateBits),
    ...(depthStencil === undefined ? {} : { depthStencil }),
    multisample: { count: desc.sampleCount ?? 1 },
  };
}

function alignBufferBytes4(bytes: Uint8Array): Uint8Array {
  const alignedLen = (bytes.byteLength + 3) & ~3;
  if (alignedLen === bytes.byteLength) return bytes;
  const padded = new Uint8Array(alignedLen);
  padded.set(bytes);
  return padded;
}

/**
 * Owns physical `@forgeax/engine-rhi` handles indexed by kernel `u32` IDs and executes
 * resolved `PHYS_*` streams from either `TsRenderKernel` or `WasmRenderKernel`.
 */
export class RhiPhysicalExecutor {
  readonly device: RhiDevice;
  private readonly createShaderModuleImmediateFn: KernelCreateShaderModuleImmediate | undefined;
  private readonly meshes = new Map<number, RhiMeshRecord>();
  private readonly textures = new Map<number, RhiTexRecord>();
  private readonly dynamicTextures = new Map<number, RhiTexRecord>();
  private readonly buffers = new Map<number, Buffer>();
  private readonly samplers = new Map<number, Sampler>();
  private readonly shaders = new Map<number, RhiShaderRecord>();
  private readonly materials = new Map<number, RhiMaterialRecord>();
  private readonly poolTextures = new Map<number, RhiPoolTexRecord>();
  private readonly externalSurfaces = new Map<
    number,
    { texture: Texture; view: TextureView; width: number; height: number }
  >();
  private readonly externalPipelines = new Map<number, RenderPipeline>();
  private readonly psoByKey = new Map<
    bigint,
    { readonly pipeline: RenderPipeline; readonly is4Bgl: boolean }
  >();
  private readonly psoBySlot = new Map<
    number,
    { readonly pipeline: RenderPipeline; readonly is4Bgl: boolean }
  >();
  private readonly frameBindingSets = new Map<
    number,
    readonly { slot: number; kind: number; handle: number; offset: number }[]
  >();
  private readonly scene4Bgl: RhiScene4BglState | undefined;
  private frameUniformBuffer: Buffer | undefined;
  private frameUniformCapacity = 0;
  private activeRenderPass: RhiRenderPassEncoder | undefined;
  private activeRenderPipeline: RenderPipeline | undefined;
  private activePsoIs4Bgl = false;
  private boundScene4BglGroups = false;
  private currentViewOffset = 0;
  private currentExtraBindings = 0;
  private activeComputePass: RhiComputePassEncoder | undefined;
  private mipgenShader: ShaderModule | undefined;
  private mipgenSampler: Sampler | undefined;
  private readonly mipgenPipelines = new Map<GPUTextureFormat, RenderPipeline>();
  private readonly pendingReadbacks = new Map<number, PendingRhiReadback>();
  private nextSurfaceId = 1;
  private nextExternalPsoId = 100_000;

  constructor(device: RhiDevice, createShaderModuleImmediate?: KernelCreateShaderModuleImmediate) {
    this.device = device;
    this.createShaderModuleImmediateFn = createShaderModuleImmediate;
    this.scene4Bgl = RhiScene4BglState.create(device);
  }

  get supportsScene4Bgl(): boolean {
    return this.scene4Bgl !== undefined;
  }

  uploadSceneObjects(packedBytes: Uint8Array): void {
    this.scene4Bgl?.uploadSceneObjects(packedBytes);
  }

  uploadSceneLights(packedBytes: Uint8Array): void {
    this.scene4Bgl?.uploadSceneLights(packedBytes);
  }

  uploadSkinJoints(slotOffset: number, jointMatrices: Float32Array): Result<void, KernelError> {
    this.scene4Bgl?.uploadSkinJoints(slotOffset, jointMatrices);
    return ok(undefined);
  }

  uploadInstanceRows(rows: Uint32Array): void {
    this.scene4Bgl?.uploadInstanceRows(rows);
  }

  updateMaterialParams(id: number, paramBytes: Uint8Array): Result<void, KernelError> {
    const rec = this.materials.get(id);
    if (rec === undefined) {
      return kernelErr(
        'kernel-handle-invalid',
        'RhiPhysicalExecutor.updateMaterialParams',
        'live MaterialId',
        'create material first',
        id,
      );
    }
    if (paramBytes.byteLength > 0) {
      const w = this.device.queue.writeBuffer(rec.uniformBuffer, 0, alignBufferBytes4(paramBytes));
      if (!w.ok) {
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor.updateMaterialParams',
          'material UBO write',
          w.error.hint,
          id,
        );
      }
    }
    return ok(undefined);
  }

  registerExternalSurface(
    texture: Texture,
    view: TextureView,
    width: number,
    height: number,
  ): number {
    const id = this.nextSurfaceId++;
    this.externalSurfaces.set(id, { texture, view, width, height });
    return id;
  }

  registerExternalPipeline(pipeline: RenderPipeline): number {
    const id = this.nextExternalPsoId++;
    this.externalPipelines.set(id, pipeline);
    return id;
  }

  getPoolTexture(poolSlotId: number): Texture | undefined {
    return this.poolTextures.get(poolSlotId)?.texture;
  }

  getDynamicTextureView(id: number): TextureView | undefined {
    return this.dynamicTextures.get(id)?.view;
  }

  createMesh(
    id: number,
    desc: KernelMeshDesc,
    vertexBytes: Uint8Array,
    indexBytes?: Uint8Array,
  ): Result<void, KernelError> {
    const vbSize = Math.max(4, (vertexBytes.byteLength + 3) & ~3);
    const vbRes = this.device.createBuffer({
      label: desc.label ? `${desc.label}.vb` : 'kernel.mesh.vb',
      size: vbSize,
      usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST,
    });
    if (!vbRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'vertex buffer creation',
        vbRes.error.hint,
        id,
      );
    }
    if (vertexBytes.byteLength > 0) {
      const wVb = this.device.queue.writeBuffer(vbRes.value, 0, alignBufferBytes4(vertexBytes));
      if (!wVb.ok) {
        this.device.destroyBuffer(vbRes.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'vertex buffer write',
          wVb.error.hint,
          id,
        );
      }
    }
    let ib: Buffer | undefined;
    if (indexBytes !== undefined && indexBytes.byteLength > 0) {
      const ibSize = Math.max(4, (indexBytes.byteLength + 3) & ~3);
      const ibRes = this.device.createBuffer({
        label: desc.label ? `${desc.label}.ib` : 'kernel.mesh.ib',
        size: ibSize,
        usage: GPU_USAGE_INDEX | GPU_USAGE_COPY_DST,
      });
      if (!ibRes.ok) {
        this.device.destroyBuffer(vbRes.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'index buffer creation',
          ibRes.error.hint,
          id,
        );
      }
      const wIb = this.device.queue.writeBuffer(ibRes.value, 0, alignBufferBytes4(indexBytes));
      if (!wIb.ok) {
        this.device.destroyBuffer(vbRes.value);
        this.device.destroyBuffer(ibRes.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'index buffer write',
          wIb.error.hint,
          id,
        );
      }
      ib = ibRes.value;
    }
    this.meshes.set(id, {
      vb: vbRes.value,
      ...(ib === undefined ? {} : { ib }),
      isUint32Index: desc.isUint32Index === true,
      desc,
    });
    return ok(undefined);
  }

  destroyMesh(id: number): void {
    const rec = this.meshes.get(id);
    if (rec === undefined) return;
    this.device.destroyBuffer(rec.vb);
    if (rec.ib !== undefined) this.device.destroyBuffer(rec.ib);
    this.meshes.delete(id);
  }

  createTexture(
    id: number,
    desc: KernelTextureDesc,
    initialBytes?: Uint8Array,
  ): Result<void, KernelError> {
    const format = textureFormatCodeToGPUTextureFormat(desc.format);
    const usage =
      (desc.usage ?? GPU_TEX_TEXTURE_BINDING | GPU_TEX_COPY_DST | GPU_TEX_COPY_SRC) |
      GPU_TEX_COPY_DST;
    const texRes = this.device.createTexture({
      label: desc.label ?? 'kernel.texture',
      size: {
        width: Math.max(1, desc.width),
        height: Math.max(1, desc.height),
        depthOrArrayLayers: Math.max(1, desc.arrayLayerCount ?? 1),
      },
      mipLevelCount: Math.max(1, desc.mipLevelCount ?? 1),
      sampleCount: desc.sampleCount ?? 1,
      format,
      usage,
    });
    if (!texRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'texture creation',
        texRes.error.hint,
        id,
      );
    }
    const viewRes = this.device.createTextureView(texRes.value, {});
    if (!viewRes.ok) {
      this.device.destroyTexture(texRes.value);
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'texture view creation',
        viewRes.error.hint,
        id,
      );
    }
    if (initialBytes !== undefined && initialBytes.byteLength > 0) {
      const bpp = textureFormatBytesPerPixel(format);
      this.device.queue.writeTexture(
        { texture: texRes.value },
        initialBytes,
        { bytesPerRow: Math.max(1, desc.width) * bpp, rowsPerImage: Math.max(1, desc.height) },
        { width: Math.max(1, desc.width), height: Math.max(1, desc.height), depthOrArrayLayers: 1 },
      );
    }
    this.textures.set(id, {
      texture: texRes.value,
      view: viewRes.value,
      width: Math.max(1, desc.width),
      height: Math.max(1, desc.height),
      format,
      mipLevelCount: Math.max(1, desc.mipLevelCount ?? 1),
      arrayLayerCount: Math.max(1, desc.arrayLayerCount ?? 1),
    });
    return ok(undefined);
  }

  destroyTexture(id: number): void {
    const rec = this.textures.get(id);
    if (rec === undefined) return;
    this.device.destroyTexture(rec.texture);
    this.textures.delete(id);
  }

  createDynamicTexture(id: number, desc: DynamicTextureDesc): Result<void, KernelError> {
    const format = textureFormatCodeToGPUTextureFormat(desc.format);
    const texRes = this.device.createTexture({
      label: desc.label ?? 'kernel.dynamic-texture',
      size: {
        width: Math.max(1, desc.width),
        height: Math.max(1, desc.height),
        depthOrArrayLayers: 1,
      },
      format,
      usage:
        GPU_TEX_TEXTURE_BINDING | GPU_TEX_COPY_DST | GPU_TEX_COPY_SRC | GPU_TEX_RENDER_ATTACHMENT,
    });
    if (!texRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'dynamic texture creation',
        texRes.error.hint,
        id,
      );
    }
    const viewRes = this.device.createTextureView(texRes.value, {});
    if (!viewRes.ok) {
      this.device.destroyTexture(texRes.value);
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'dynamic texture view',
        viewRes.error.hint,
        id,
      );
    }
    this.dynamicTextures.set(id, {
      texture: texRes.value,
      view: viewRes.value,
      width: Math.max(1, desc.width),
      height: Math.max(1, desc.height),
      format,
      mipLevelCount: 1,
      arrayLayerCount: 1,
    });
    return ok(undefined);
  }

  uploadDynamicTexture(
    id: number,
    reallocated: boolean,
    width: number,
    height: number,
    source: DynamicTextureUploadSource,
  ): Result<void, KernelError> {
    const rec = this.dynamicTextures.get(id);
    if (rec === undefined) {
      return kernelErr(
        'kernel-handle-invalid',
        'RhiPhysicalExecutor',
        'live DynamicTextureId',
        'create dynamic texture first',
        id,
      );
    }
    if (reallocated) {
      const nextRes = this.device.createTexture({
        label: 'kernel.dynamic-texture.resized',
        size: { width: Math.max(1, width), height: Math.max(1, height), depthOrArrayLayers: 1 },
        format: rec.format,
        usage:
          GPU_TEX_TEXTURE_BINDING | GPU_TEX_COPY_DST | GPU_TEX_COPY_SRC | GPU_TEX_RENDER_ATTACHMENT,
      });
      if (!nextRes.ok) {
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'dynamic texture resize',
          nextRes.error.hint,
          id,
        );
      }
      const nextView = this.device.createTextureView(nextRes.value, {});
      if (!nextView.ok) {
        this.device.destroyTexture(nextRes.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'dynamic texture view',
          nextView.error.hint,
          id,
        );
      }
      this.device.destroyTexture(rec.texture);
      rec.texture = nextRes.value;
      rec.view = nextView.value;
      rec.width = width;
      rec.height = height;
    }

    if (isByteDynamicSource(source)) {
      if (source.byteLength > 0) {
        this.device.queue.writeTexture(
          { texture: rec.texture },
          source,
          { bytesPerRow: Math.max(1, width) * 4, rowsPerImage: Math.max(1, height) },
          { width: Math.max(1, width), height: Math.max(1, height), depthOrArrayLayers: 1 },
        );
      }
    } else {
      const copyRes = this.device.queue.copyExternalImageToTexture(
        { source: source as GPUCopyExternalImageSource },
        { texture: rec.texture },
        { width: Math.max(1, width), height: Math.max(1, height) },
      );
      if (!copyRes.ok) {
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'external image copy',
          copyRes.error.hint,
          id,
        );
      }
    }
    return ok(undefined);
  }

  destroyDynamicTexture(id: number): void {
    const rec = this.dynamicTextures.get(id);
    if (rec === undefined) return;
    this.device.destroyTexture(rec.texture);
    this.dynamicTextures.delete(id);
  }

  createBuffer(
    id: number,
    desc: KernelBufferDesc,
    initialBytes?: Uint8Array,
  ): Result<void, KernelError> {
    const size = Math.max(4, (desc.size + 3) & ~3);
    const res = this.device.createBuffer({
      label: desc.label ?? 'kernel.buffer',
      size,
      usage: desc.usage | GPU_USAGE_COPY_DST,
    });
    if (!res.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'buffer creation',
        res.error.hint,
        id,
      );
    }
    if (initialBytes !== undefined && initialBytes.byteLength > 0) {
      const w = this.device.queue.writeBuffer(res.value, 0, alignBufferBytes4(initialBytes));
      if (!w.ok) {
        this.device.destroyBuffer(res.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'buffer write',
          w.error.hint,
          id,
        );
      }
    }
    this.buffers.set(id, res.value);
    return ok(undefined);
  }

  writeBuffer(id: number, offset: number, bytes: Uint8Array): Result<void, KernelError> {
    const buf = this.buffers.get(id);
    if (buf === undefined) {
      return kernelErr(
        'kernel-handle-invalid',
        'RhiPhysicalExecutor',
        'live BufferId',
        'create buffer first',
        id,
      );
    }
    const res = this.device.queue.writeBuffer(buf, offset, alignBufferBytes4(bytes));
    if (!res.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'writeBuffer',
        res.error.hint,
        id,
      );
    }
    return ok(undefined);
  }

  destroyBuffer(id: number): void {
    const buf = this.buffers.get(id);
    if (buf === undefined) return;
    this.device.destroyBuffer(buf);
    this.buffers.delete(id);
  }

  createSampler(id: number, desc: KernelSamplerDesc): Result<void, KernelError> {
    const res = this.device.createSampler({
      label: desc.label ?? 'kernel.sampler',
      ...(desc.magFilter === undefined ? {} : { magFilter: desc.magFilter }),
      ...(desc.minFilter === undefined ? {} : { minFilter: desc.minFilter }),
      ...(desc.mipmapFilter === undefined ? {} : { mipmapFilter: desc.mipmapFilter }),
      ...(desc.addressModeU === undefined ? {} : { addressModeU: desc.addressModeU }),
      ...(desc.addressModeV === undefined ? {} : { addressModeV: desc.addressModeV }),
      ...(desc.addressModeW === undefined ? {} : { addressModeW: desc.addressModeW }),
      ...(desc.compare === undefined ? {} : { compare: desc.compare }),
    });
    if (!res.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'sampler creation',
        res.error.hint,
        id,
      );
    }
    this.samplers.set(id, res.value);
    return ok(undefined);
  }

  destroySampler(id: number): void {
    this.samplers.delete(id);
  }

  registerShaderProgram(id: number, desc: KernelShaderProgramDesc): Result<void, KernelError> {
    const shaderDesc = {
      label: desc.label ?? `kernel.shader.${id}`,
      code: desc.code,
    };
    let modRes: Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>;
    if (this.createShaderModuleImmediateFn !== undefined) {
      modRes = this.createShaderModuleImmediateFn(this.device, shaderDesc);
    } else {
      const duck = this.device as RhiDevice & {
        createShaderModule?: (d: {
          label?: string | undefined;
          code: string;
        }) => Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>;
      };
      if (typeof duck.createShaderModule !== 'function') {
        return kernelErr(
          'kernel-shader-compile-failed',
          'RhiPhysicalExecutor',
          'createShaderModuleImmediate backend factory',
          'pass createShaderModuleImmediate (e.g. from @forgeax/engine-rhi-webgpu, @forgeax/engine-rhi-null, or attachRecorder)',
          id,
        );
      }
      modRes = duck.createShaderModule(shaderDesc);
    }
    if (!modRes.ok) {
      return kernelErr(
        'kernel-shader-compile-failed',
        'RhiPhysicalExecutor',
        'valid WGSL module',
        modRes.error.hint,
        id,
      );
    }
    this.shaders.set(id, { module: modRes.value, desc });
    return ok(undefined);
  }

  destroyShaderProgram(id: number): void {
    this.shaders.delete(id);
  }

  createMaterial(
    id: number,
    desc: KernelMaterialDesc,
    initialParamBytes: Uint8Array,
  ): Result<void, KernelError> {
    const size = Math.max(16, (initialParamBytes.byteLength + 15) & ~15);
    const bufRes = this.device.createBuffer({
      label: desc.label ? `${desc.label}.ubo` : `kernel.material.${id}.ubo`,
      size,
      usage: GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST,
    });
    if (!bufRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'material UBO',
        bufRes.error.hint,
        id,
      );
    }
    if (initialParamBytes.byteLength > 0) {
      const w = this.device.queue.writeBuffer(
        bufRes.value,
        0,
        alignBufferBytes4(initialParamBytes),
      );
      if (!w.ok) {
        this.device.destroyBuffer(bufRes.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'material UBO write',
          w.error.hint,
          id,
        );
      }
    }
    this.materials.set(id, { desc, uniformBuffer: bufRes.value });
    return ok(undefined);
  }

  destroyMaterial(id: number): void {
    const rec = this.materials.get(id);
    if (rec === undefined) return;
    this.device.destroyBuffer(rec.uniformBuffer);
    this.materials.delete(id);
  }

  private resolveTextureMeta(handle: number):
    | {
        texture: Texture;
        view: TextureView;
        width: number;
        height: number;
        format: GPUTextureFormat;
        mipLevelCount: number;
        arrayLayerCount: number;
      }
    | undefined {
    if (handle === INVALID_HANDLE) return undefined;
    if ((handle & TEMP_TEXTURE_TAG_BIT) !== 0) {
      const slot = handle & ~TEMP_TEXTURE_TAG_BIT;
      const pool = this.poolTextures.get(slot);
      return pool;
    }
    const ext = this.externalSurfaces.get(handle);
    if (ext !== undefined) {
      return {
        texture: ext.texture,
        view: ext.view,
        width: ext.width,
        height: ext.height,
        format: 'rgba8unorm',
        mipLevelCount: 1,
        arrayLayerCount: 1,
      };
    }
    return this.textures.get(handle) ?? this.dynamicTextures.get(handle);
  }

  private resolveAttachmentView(
    handle: number,
    mipLevel: number,
    arrayLayer: number,
  ): TextureView | undefined {
    const meta = this.resolveTextureMeta(handle);
    if (meta === undefined) return undefined;
    if (
      mipLevel === 0 &&
      arrayLayer === 0 &&
      meta.mipLevelCount <= 1 &&
      meta.arrayLayerCount <= 1
    ) {
      return meta.view;
    }
    const viewRes = this.device.createTextureView(meta.texture, {
      dimension: '2d',
      baseMipLevel: Math.min(mipLevel, Math.max(0, meta.mipLevelCount - 1)),
      mipLevelCount: 1,
      baseArrayLayer: Math.min(arrayLayer, Math.max(0, meta.arrayLayerCount - 1)),
      arrayLayerCount: 1,
    });
    return viewRes.ok ? viewRes.value : meta.view;
  }

  private resolveBindingTextureView(
    handle: number,
    packedSubresource: number,
  ): TextureView | undefined {
    const meta = this.resolveTextureMeta(handle);
    if (meta === undefined) return undefined;
    if ((packedSubresource & BINDING_TEX_SUBRESOURCE_FLAG) === 0) return meta.view;
    const baseMipLevel = Math.min(packedSubresource & 0xff, Math.max(0, meta.mipLevelCount - 1));
    const rawMipCount = (packedSubresource >>> 8) & 0xff;
    const mipLevelCount =
      rawMipCount === 0
        ? undefined
        : Math.min(rawMipCount, Math.max(1, meta.mipLevelCount - baseMipLevel));
    const baseArrayLayer = Math.min(
      (packedSubresource >>> 16) & 0xfff,
      Math.max(0, meta.arrayLayerCount - 1),
    );
    const aspectCode = (packedSubresource >>> 28) & 0x3;
    const aspect: GPUTextureAspect =
      aspectCode === 1 ? 'depth-only' : aspectCode === 2 ? 'stencil-only' : 'all';
    const viewRes = this.device.createTextureView(meta.texture, {
      aspect,
      baseMipLevel,
      ...(mipLevelCount === undefined ? {} : { mipLevelCount }),
      baseArrayLayer,
      ...(meta.arrayLayerCount > 1 ? { dimension: '2d', arrayLayerCount: 1 } : {}),
    });
    return viewRes.ok ? viewRes.value : meta.view;
  }

  private getOrCreateRenderPipeline(
    w0: number,
    w1: number,
    w2: number,
    w3: number,
    slotId: number,
  ): { readonly pipeline: RenderPipeline; readonly is4Bgl: boolean } | undefined {
    const ext = this.externalPipelines.get(slotId);
    if (ext !== undefined) return { pipeline: ext, is4Bgl: false };
    const bySlot = this.psoBySlot.get(slotId);
    if (bySlot !== undefined) return bySlot;
    const key = psoKeyBigInt(w0, w1, w2, w3);
    const cached = this.psoByKey.get(key);
    if (cached !== undefined) {
      this.psoBySlot.set(slotId, cached);
      return cached;
    }
    const shaderId = (w1 >>> 8) & 0x00ff_ffff;
    const shader = this.shaders.get(shaderId);
    if (shader === undefined) return undefined;
    const passTag = w0 & 0xff;
    const renderStateBits = (((w3 & 0xffff) << 16) | ((w2 >>> 16) & 0xffff)) >>> 0;
    const layoutFamilyId = (w3 >>> 16) & 0xffff;
    const is4Bgl =
      layoutFamilyId === LAYOUT_FAMILY_SCENE_4BGL ||
      shader.desc.layoutFamilyId === LAYOUT_FAMILY_SCENE_4BGL;
    if (is4Bgl && this.scene4Bgl === undefined) return undefined;
    const layout = is4Bgl && this.scene4Bgl !== undefined ? this.scene4Bgl.pipelineLayout : 'auto';
    const psoRes = this.device.createRenderPipeline(
      buildRhiRenderPipelineDesc(shader, slotId, passTag, renderStateBits, layout),
    );
    if (!psoRes.ok) return undefined;
    const entry = { pipeline: psoRes.value, is4Bgl };
    this.psoByKey.set(key, entry);
    this.psoBySlot.set(slotId, entry);
    return entry;
  }

  private getOrCreateFullscreenPipeline(shaderId: number): RenderPipeline | undefined {
    const shader = this.shaders.get(shaderId);
    if (shader === undefined) return undefined;
    if (shader.fullscreenPipeline !== undefined) return shader.fullscreenPipeline;
    const colorTargets = buildRhiColorTargets(shader.desc);
    const depthStencil = buildRhiDepthStencil(shader.desc, false, 'always');
    const res = this.device.createRenderPipeline({
      label: shader.desc.label ? `${shader.desc.label}.fullscreen` : `kernel.fs.${shaderId}`,
      layout: 'auto',
      vertex: {
        module: shader.module,
        entryPoint: shader.desc.vertexEntryPoint ?? 'vs_main',
        buffers: [],
      },
      fragment: {
        module: shader.module,
        entryPoint: shader.desc.fragmentEntryPoint ?? 'fs_main',
        targets: colorTargets,
      },
      ...(depthStencil === undefined ? {} : { depthStencil }),
      multisample: { count: shader.desc.sampleCount ?? 1 },
    });
    if (!res.ok) return undefined;
    shader.fullscreenPipeline = res.value;
    return res.value;
  }

  private getOrCreateComputePipeline(shaderId: number): ComputePipeline | undefined {
    const shader = this.shaders.get(shaderId);
    if (shader === undefined) return undefined;
    if (shader.computePipeline !== undefined) return shader.computePipeline;
    const res = this.device.createComputePipeline({
      label: shader.desc.label ? `${shader.desc.label}.compute` : `kernel.cs.${shaderId}`,
      layout: 'auto',
      compute: {
        module: shader.module,
        entryPoint: shader.desc.computeEntryPoint ?? 'cs_main',
      },
    });
    if (!res.ok) return undefined;
    shader.computePipeline = res.value;
    return res.value;
  }

  private uploadFrameUniforms(uniformData: Uint8Array): Result<void, KernelError> | undefined {
    if (uniformData.byteLength === 0) return undefined;
    if (
      this.frameUniformBuffer === undefined ||
      this.frameUniformCapacity < uniformData.byteLength
    ) {
      if (this.frameUniformBuffer !== undefined) {
        this.device.destroyBuffer(this.frameUniformBuffer);
      }
      const cap = Math.max(4096, uniformData.byteLength * 2);
      const bufRes = this.device.createBuffer({
        label: 'kernel.frame-uniform-ring',
        size: cap,
        usage: GPU_USAGE_UNIFORM | GPU_USAGE_COPY_DST,
      });
      if (!bufRes.ok) {
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'frame uniform ring',
          bufRes.error.hint,
        );
      }
      this.frameUniformBuffer = bufRes.value;
      this.frameUniformCapacity = cap;
    }
    const w = this.device.queue.writeBuffer(
      this.frameUniformBuffer,
      0,
      alignBufferBytes4(uniformData),
    );
    if (!w.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'frame uniform write',
        w.error.hint,
      );
    }
    return undefined;
  }

  private execEnsurePoolTexture(
    physCmds: Uint32Array,
    cursor: number,
  ): Result<void, KernelError> | undefined {
    const slotId = physCmds[cursor + 1] as number;
    const fsd = physCmds[cursor + 2] as number;
    const format = textureFormatCodeToGPUTextureFormat(fsd & 0xff);
    const samples = Math.max(1, (fsd >>> 8) & 0xff);
    const width = Math.max(1, physCmds[cursor + 3] as number);
    const height = Math.max(1, physCmds[cursor + 4] as number);
    const lm = physCmds[cursor + 5] as number;
    const layers = Math.max(1, lm & 0xffff);
    const mips = Math.max(1, (lm >>> 16) & 0xffff);
    const usage =
      ((physCmds[cursor + 6] as number) | GPU_TEX_COPY_SRC | GPU_TEX_RENDER_ATTACHMENT) >>> 0;
    const existing = this.poolTextures.get(slotId);
    if (
      existing === undefined ||
      existing.width !== width ||
      existing.height !== height ||
      existing.format !== format ||
      existing.samples !== samples ||
      existing.mipLevelCount !== mips ||
      existing.arrayLayerCount !== layers
    ) {
      if (existing !== undefined) this.device.destroyTexture(existing.texture);
      const texRes = this.device.createTexture({
        label: `kernel.pool.${slotId}`,
        size: { width, height, depthOrArrayLayers: layers },
        mipLevelCount: mips,
        sampleCount: samples,
        format,
        usage,
      });
      if (!texRes.ok) {
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'pool texture',
          texRes.error.hint,
          slotId,
        );
      }
      const viewRes = this.device.createTextureView(texRes.value, {});
      if (!viewRes.ok) {
        this.device.destroyTexture(texRes.value);
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor',
          'pool view',
          viewRes.error.hint,
          slotId,
        );
      }
      this.poolTextures.set(slotId, {
        texture: texRes.value,
        view: viewRes.value,
        width,
        height,
        format,
        samples,
        mipLevelCount: mips,
        arrayLayerCount: layers,
      });
    }
    return undefined;
  }

  private execResourceAndBindingOp(opcode: number, physCmds: Uint32Array, cursor: number): boolean {
    switch (opcode) {
      case PHYS_RETIRE_POOL_TEX: {
        const slotId = physCmds[cursor + 1] as number;
        const existing = this.poolTextures.get(slotId);
        if (existing !== undefined) {
          this.device.destroyTexture(existing.texture);
          this.poolTextures.delete(slotId);
        }
        return true;
      }
      case PHYS_DEF_BINDING_SET: {
        const setId = physCmds[cursor + 1] as number;
        const count = physCmds[cursor + 2] as number;
        const entries: { slot: number; kind: number; handle: number; offset: number }[] = [];
        for (let i = 0; i < count; i++) {
          const b = cursor + 3 + i * 3;
          const sk = physCmds[b] as number;
          entries.push({
            slot: sk & 0xffff,
            kind: sk >>> 16,
            handle: physCmds[b + 1] as number,
            offset: physCmds[b + 2] as number,
          });
        }
        this.frameBindingSets.set(setId, entries);
        return true;
      }
      default:
        return false;
    }
  }

  private beginRenderPass(
    encoder: RhiCommandEncoder,
    physCmds: Uint32Array,
    cursor: number,
  ): RhiRenderPassEncoder {
    const labelId = physCmds[cursor + 1] as number;
    const meta = physCmds[cursor + 2] as number;
    const colorCount = meta & 0xff;
    const hasDepth = ((meta >>> 8) & 1) !== 0;
    const colorAttachments: RenderPassColorAttachment[] = [];
    for (let c = 0; c < colorCount; c++) {
      const b = cursor + 3 + c * 8;
      const mipLayer = physCmds[b + 2] as number;
      const mip = mipLayer & 0xffff;
      const layer = (mipLayer >>> 16) & 0xffff;
      const view = this.resolveAttachmentView(physCmds[b] as number, mip, layer);
      const resolveView = this.resolveAttachmentView(physCmds[b + 1] as number, mip, layer);
      const ls = physCmds[b + 3] as number;
      const loadOp = (ls & 0xff) === LOAD_OP_LOAD ? 'load' : 'clear';
      const storeOp = ((ls >>> 8) & 0xff) === STORE_OP_DISCARD ? 'discard' : 'store';
      if (view !== undefined) {
        colorAttachments.push({
          view,
          ...(resolveView === undefined ? {} : { resolveTarget: resolveView }),
          loadOp,
          storeOp,
          clearValue: {
            r: bitsToF32(physCmds[b + 4] as number),
            g: bitsToF32(physCmds[b + 5] as number),
            b: bitsToF32(physCmds[b + 6] as number),
            a: bitsToF32(physCmds[b + 7] as number),
          },
        });
      }
    }
    let depthAttachment: RenderPassDepthStencilAttachment | undefined;
    if (hasDepth) {
      const b = cursor + 3 + colorCount * 8;
      const mipLayer = physCmds[b + 1] as number;
      const view = this.resolveAttachmentView(
        physCmds[b] as number,
        mipLayer & 0xffff,
        (mipLayer >>> 16) & 0xffff,
      );
      const lsr = physCmds[b + 2] as number;
      const readOnly = ((lsr >>> 16) & 1) !== 0;
      if (view !== undefined) {
        depthAttachment = {
          view,
          ...(readOnly
            ? { depthReadOnly: true }
            : {
                depthLoadOp: (lsr & 0xff) === LOAD_OP_LOAD ? 'load' : 'clear',
                depthStoreOp: ((lsr >>> 8) & 0xff) === STORE_OP_DISCARD ? 'discard' : 'store',
                depthClearValue: bitsToF32(physCmds[b + 3] as number),
              }),
        };
      }
    }
    return encoder.beginRenderPass({
      label: `kernel.pass.${labelId}`,
      colorAttachments,
      ...(depthAttachment === undefined ? {} : { depthStencilAttachment: depthAttachment }),
    });
  }

  private execPassLifecycleOp(
    encoder: RhiCommandEncoder,
    opcode: number,
    physCmds: Uint32Array,
    cursor: number,
  ): boolean {
    switch (opcode) {
      case PHYS_BEGIN_RENDER_PASS: {
        this.activeRenderPipeline = undefined;
        this.activePsoIs4Bgl = false;
        this.boundScene4BglGroups = false;
        this.currentViewOffset = 0;
        this.currentExtraBindings = 0;
        this.activeRenderPass = this.beginRenderPass(encoder, physCmds, cursor);
        return true;
      }
      case PHYS_END_RENDER_PASS: {
        if (this.activeRenderPass !== undefined) {
          this.activeRenderPass.end();
          this.activeRenderPass = undefined;
        }
        this.activeRenderPipeline = undefined;
        this.activePsoIs4Bgl = false;
        this.boundScene4BglGroups = false;
        return true;
      }
      case PHYS_BEGIN_COMPUTE_PASS: {
        const labelId = physCmds[cursor + 1] as number;
        this.activeComputePass = encoder.beginComputePass({ label: `kernel.compute.${labelId}` });
        return true;
      }
      case PHYS_END_COMPUTE_PASS: {
        if (this.activeComputePass !== undefined) {
          this.activeComputePass.end();
          this.activeComputePass = undefined;
        }
        return true;
      }
      default:
        return false;
    }
  }

  private execRenderStateOp(
    pass: RhiRenderPassEncoder,
    opcode: number,
    physCmds: Uint32Array,
    cursor: number,
  ): boolean {
    switch (opcode) {
      case PHYS_SET_PSO: {
        const entry = this.getOrCreateRenderPipeline(
          physCmds[cursor + 1] as number,
          physCmds[cursor + 2] as number,
          physCmds[cursor + 3] as number,
          physCmds[cursor + 4] as number,
          physCmds[cursor + 5] as number,
        );
        if (entry !== undefined) {
          pass.setPipeline(entry.pipeline);
          this.activeRenderPipeline = entry.pipeline;
          this.activePsoIs4Bgl = entry.is4Bgl;
          if (entry.is4Bgl && !this.boundScene4BglGroups) {
            this.bindScene4BglPassGroups(pass);
          }
        }
        return true;
      }
      case PHYS_SET_BIND_GROUP: {
        this.execRenderBindGroup(pass, physCmds, cursor);
        return true;
      }
      case PHYS_SET_VB: {
        const slot = physCmds[cursor + 1] as number;
        const meshOrBuf = physCmds[cursor + 2] as number;
        const offset = physCmds[cursor + 3] as number;
        const mesh = this.meshes.get(meshOrBuf);
        const buf = mesh?.vb ?? this.buffers.get(meshOrBuf);
        if (buf !== undefined) pass.setVertexBuffer(slot, buf, offset);
        return true;
      }
      case PHYS_SET_IB: {
        const meshOrBuf = physCmds[cursor + 1] as number;
        const isU32 = (physCmds[cursor + 2] as number) !== 0;
        const offset = physCmds[cursor + 3] as number;
        const mesh = this.meshes.get(meshOrBuf);
        const buf = mesh?.ib ?? this.buffers.get(meshOrBuf);
        if (buf !== undefined) {
          pass.setIndexBuffer(buf, isU32 ? 'uint32' : 'uint16', offset);
        }
        return true;
      }
      case PHYS_SET_VIEWPORT: {
        const rp = pass as RhiRenderPassEncoder & {
          setViewport?: (
            x: number,
            y: number,
            w: number,
            h: number,
            minD: number,
            maxD: number,
          ) => void;
        };
        rp.setViewport?.(
          bitsToF32(physCmds[cursor + 1] as number),
          bitsToF32(physCmds[cursor + 2] as number),
          bitsToF32(physCmds[cursor + 3] as number),
          bitsToF32(physCmds[cursor + 4] as number),
          bitsToF32(physCmds[cursor + 5] as number),
          bitsToF32(physCmds[cursor + 6] as number),
        );
        return true;
      }
      case PHYS_SET_SCISSOR: {
        const rp = pass as RhiRenderPassEncoder & {
          setScissorRect?: (x: number, y: number, w: number, h: number) => void;
        };
        rp.setScissorRect?.(
          physCmds[cursor + 1] as number,
          physCmds[cursor + 2] as number,
          physCmds[cursor + 3] as number,
          physCmds[cursor + 4] as number,
        );
        return true;
      }
      default:
        return false;
    }
  }

  private execRenderDrawOp(
    pass: RhiRenderPassEncoder,
    opcode: number,
    physCmds: Uint32Array,
    cursor: number,
  ): boolean {
    switch (opcode) {
      case PHYS_DRAW: {
        pass.draw(
          physCmds[cursor + 1] as number,
          physCmds[cursor + 2] as number,
          physCmds[cursor + 3] as number,
          physCmds[cursor + 4] as number,
        );
        return true;
      }
      case PHYS_DRAW_INDEXED: {
        pass.drawIndexed(
          physCmds[cursor + 1] as number,
          physCmds[cursor + 2] as number,
          physCmds[cursor + 3] as number,
          (physCmds[cursor + 4] as number) | 0,
          physCmds[cursor + 5] as number,
        );
        return true;
      }
      case PHYS_DRAW_INDIRECT: {
        const buf = this.buffers.get(physCmds[cursor + 1] as number);
        if (buf !== undefined) pass.drawIndirect(buf, physCmds[cursor + 2] as number);
        return true;
      }
      case PHYS_DRAW_FULLSCREEN: {
        const shaderId = physCmds[cursor + 1] as number;
        const bindingSetId = physCmds[cursor + 2] as number;
        const pso = this.getOrCreateFullscreenPipeline(shaderId);
        if (pso !== undefined) {
          this.activePsoIs4Bgl = false;
          this.boundScene4BglGroups = false;
          this.activeRenderPipeline = pso;
          pass.setPipeline(pso);
          this.bindFrameSetToRenderPass(pass, pso, bindingSetId);
          pass.draw(3, 1, 0, 0);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private execComputeAndCopyOp(
    encoder: RhiCommandEncoder,
    opcode: number,
    physCmds: Uint32Array,
    cursor: number,
  ): void {
    switch (opcode) {
      case PHYS_DISPATCH: {
        if (this.activeComputePass !== undefined) {
          const shaderId = physCmds[cursor + 1] as number;
          const bindingSetId = physCmds[cursor + 2] as number;
          const pso = this.getOrCreateComputePipeline(shaderId);
          if (pso !== undefined) {
            this.activeComputePass.setPipeline(pso);
            this.bindFrameSetToComputePass(this.activeComputePass, pso, bindingSetId);
            this.activeComputePass.dispatchWorkgroups(
              physCmds[cursor + 5] as number,
              physCmds[cursor + 6] as number,
              physCmds[cursor + 7] as number,
            );
          }
        }
        break;
      }
      case PHYS_DISPATCH_INDIRECT: {
        if (this.activeComputePass !== undefined) {
          const shaderId = physCmds[cursor + 1] as number;
          const bindingSetId = physCmds[cursor + 2] as number;
          const buf = this.buffers.get(physCmds[cursor + 3] as number);
          const pso = this.getOrCreateComputePipeline(shaderId);
          if (pso !== undefined && buf !== undefined) {
            this.activeComputePass.setPipeline(pso);
            this.bindFrameSetToComputePass(this.activeComputePass, pso, bindingSetId);
            this.activeComputePass.dispatchWorkgroupsIndirect(buf, physCmds[cursor + 4] as number);
          }
        }
        break;
      }
      case PHYS_COPY_TEXTURE: {
        const src = this.resolveTextureMeta(physCmds[cursor + 1] as number);
        const dst = this.resolveTextureMeta(physCmds[cursor + 3] as number);
        if (src !== undefined && dst !== undefined) {
          const srcMeta = physCmds[cursor + 2] as number;
          const dstMeta = physCmds[cursor + 4] as number;
          encoder.copyTextureToTexture(
            {
              texture: src.texture,
              mipLevel: srcMeta & 0xffff,
              origin: { x: 0, y: 0, z: (srcMeta >>> 16) & 0xffff },
            },
            {
              texture: dst.texture,
              mipLevel: dstMeta & 0xffff,
              origin: { x: 0, y: 0, z: (dstMeta >>> 16) & 0xffff },
            },
            {
              width: Math.max(1, physCmds[cursor + 5] as number),
              height: Math.max(1, physCmds[cursor + 6] as number),
              depthOrArrayLayers: Math.max(1, physCmds[cursor + 7] as number),
            },
          );
        }
        break;
      }
      case PHYS_COPY_BUFFER: {
        const src = this.buffers.get(physCmds[cursor + 1] as number);
        const dst = this.buffers.get(physCmds[cursor + 3] as number);
        if (src !== undefined && dst !== undefined) {
          encoder.copyBufferToBuffer(
            src,
            physCmds[cursor + 2] as number,
            dst,
            physCmds[cursor + 4] as number,
            physCmds[cursor + 5] as number,
          );
        }
        break;
      }
      case PHYS_GENERATE_MIPS: {
        this.execGenerateMips(encoder, physCmds[cursor + 1] as number);
        break;
      }
      case PHYS_REQUEST_READBACK: {
        this.execRequestReadback(
          encoder,
          physCmds[cursor + 1] as number,
          physCmds[cursor + 2] as number,
          physCmds[cursor + 3] as number,
        );
        break;
      }
      default:
        break;
    }
  }

  private ensureMipgenPipeline(format: GPUTextureFormat): RenderPipeline | undefined {
    const cached = this.mipgenPipelines.get(format);
    if (cached !== undefined) return cached;
    if (this.mipgenShader === undefined) {
      const modRes = this.compileShaderModule({ label: 'kernel.mipgen.shader', code: MIPGEN_WGSL });
      if (modRes === undefined || !modRes.ok) return undefined;
      this.mipgenShader = modRes.value;
    }
    if (this.mipgenSampler === undefined) {
      const smpRes = this.device.createSampler({
        label: 'kernel.mipgen.sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      if (!smpRes.ok) return undefined;
      this.mipgenSampler = smpRes.value;
    }
    const psoRes = this.device.createRenderPipeline({
      label: `kernel.mipgen.${format}`,
      layout: 'auto',
      vertex: { module: this.mipgenShader, entryPoint: 'vs_main', buffers: [] },
      fragment: { module: this.mipgenShader, entryPoint: 'fs_main', targets: [{ format }] },
      multisample: { count: 1 },
    });
    if (!psoRes.ok) return undefined;
    this.mipgenPipelines.set(format, psoRes.value);
    return psoRes.value;
  }

  private compileShaderModule(desc: {
    label?: string | undefined;
    code: string;
  }): Result<ShaderModule, import('@forgeax/engine-rhi').RhiError> | undefined {
    if (this.createShaderModuleImmediateFn !== undefined) {
      return this.createShaderModuleImmediateFn(this.device, desc);
    }
    const duck = this.device as RhiDevice & {
      createShaderModule?: (d: {
        label?: string | undefined;
        code: string;
      }) => Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>;
    };
    return duck.createShaderModule?.(desc);
  }

  private execGenerateMips(encoder: RhiCommandEncoder, texHandle: number): void {
    const meta = this.resolveTextureMeta(texHandle);
    if (meta === undefined || meta.mipLevelCount <= 1) return;
    const pso = this.ensureMipgenPipeline(meta.format);
    if (pso === undefined || this.mipgenSampler === undefined) return;
    const ops = pso as RenderPipeline & Partial<RhiRenderPipelineOps>;
    if (typeof ops.getBindGroupLayout !== 'function') return;
    const layout = ops.getBindGroupLayout(0);
    for (let layer = 0; layer < meta.arrayLayerCount; layer++) {
      for (let mip = 1; mip < meta.mipLevelCount; mip++) {
        const srcViewRes = this.device.createTextureView(meta.texture, {
          dimension: '2d',
          baseMipLevel: mip - 1,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        });
        const dstViewRes = this.device.createTextureView(meta.texture, {
          dimension: '2d',
          baseMipLevel: mip,
          mipLevelCount: 1,
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        });
        if (!srcViewRes.ok || !dstViewRes.ok) continue;
        const bgRes = this.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: srcViewRes.value } },
            { binding: 1, resource: { kind: 'sampler', value: this.mipgenSampler } },
          ],
        });
        if (!bgRes.ok) continue;
        const pass = encoder.beginRenderPass({
          label: `kernel.mipgen.${layer}.${mip}`,
          colorAttachments: [
            {
              view: dstViewRes.value,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
          ],
        });
        pass.setPipeline(pso);
        pass.setBindGroup(0, bgRes.value);
        pass.draw(3, 1, 0, 0);
        pass.end();
      }
    }
  }

  private execRequestReadback(
    encoder: RhiCommandEncoder,
    texHandle: number,
    ticketId: number,
    layerMip: number,
  ): void {
    const meta = this.resolveTextureMeta(texHandle);
    if (meta === undefined) return;
    const mip = layerMip & 0xffff;
    const layer = (layerMip >>> 16) & 0xffff;
    const width = Math.max(1, meta.width >>> mip);
    const height = Math.max(1, meta.height >>> mip);
    const bpp = textureFormatBytesPerPixel(meta.format);
    const unpaddedRow = width * bpp;
    const paddedRow = (unpaddedRow + 255) & ~255;
    const size = Math.max(4, paddedRow * height);
    const old = this.pendingReadbacks.get(ticketId);
    if (old !== undefined) {
      this.device.destroyBuffer(old.staging);
      this.pendingReadbacks.delete(ticketId);
    }
    const bufRes = this.device.createBuffer({
      label: `kernel.readback.${ticketId}`,
      size,
      usage: GPU_USAGE_COPY_DST | GPU_USAGE_MAP_READ,
    });
    if (!bufRes.ok) return;
    encoder.copyTextureToBuffer(
      { texture: meta.texture, mipLevel: mip, origin: { x: 0, y: 0, z: layer } },
      { buffer: bufRes.value, offset: 0, bytesPerRow: paddedRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    this.pendingReadbacks.set(ticketId, {
      staging: bufRes.value,
      width,
      height,
      unpaddedRow,
      paddedRow,
      format: meta.format,
    });
  }

  async readbackTicket(ticketId: number): Promise<Result<KernelReadbackResult, KernelError>> {
    const pending = this.pendingReadbacks.get(ticketId);
    if (pending === undefined) {
      return kernelErr(
        'kernel-handle-invalid',
        'RhiPhysicalExecutor.readbackTicket',
        'queued readback ticket',
        'call requestReadback in frame before reading ticket',
        ticketId,
      );
    }
    this.pendingReadbacks.delete(ticketId);
    const totalBytes = pending.paddedRow * pending.height;
    try {
      const mapped = await pending.staging.mapAsync(1 /* GPUMapMode.READ */, 0, totalBytes);
      if (!mapped.ok) {
        return kernelErr(
          'kernel-backend-runtime-error',
          'RhiPhysicalExecutor.readbackTicket',
          'buffer readback mapAsync',
          mapped.error.hint,
          ticketId,
        );
      }
      try {
        const range = mapped.value.getMappedRange(0, totalBytes);
        if (!range.ok) {
          return kernelErr(
            'kernel-backend-runtime-error',
            'RhiPhysicalExecutor.readbackTicket',
            'buffer readback getMappedRange',
            range.error.hint,
            ticketId,
          );
        }
        const src = new Uint8Array(range.value);
        const out = new Uint8Array(pending.unpaddedRow * pending.height);
        for (let row = 0; row < pending.height; row++) {
          out.set(
            src.subarray(row * pending.paddedRow, row * pending.paddedRow + pending.unpaddedRow),
            row * pending.unpaddedRow,
          );
        }
        return ok({
          width: pending.width,
          height: pending.height,
          format: pending.format,
          pixels: out,
        });
      } finally {
        mapped.value.unmap();
      }
    } finally {
      this.device.destroyBuffer(pending.staging);
    }
  }

  private executeCommand(
    encoder: RhiCommandEncoder,
    opcode: number,
    physCmds: Uint32Array,
    cursor: number,
  ): Result<void, KernelError> | undefined {
    if (opcode === PHYS_ENSURE_POOL_TEX) {
      return this.execEnsurePoolTexture(physCmds, cursor);
    }
    if (this.execResourceAndBindingOp(opcode, physCmds, cursor)) return undefined;
    if (this.execPassLifecycleOp(encoder, opcode, physCmds, cursor)) return undefined;
    if (this.activeRenderPass !== undefined) {
      if (this.execRenderStateOp(this.activeRenderPass, opcode, physCmds, cursor)) return undefined;
      if (this.execRenderDrawOp(this.activeRenderPass, opcode, physCmds, cursor)) return undefined;
    }
    this.execComputeAndCopyOp(encoder, opcode, physCmds, cursor);
    return undefined;
  }

  /**
   * Replays one resolved physical command stream (`PHYS_*`) onto `this.device`
   * and submits a single command buffer.
   */
  executePhysicalStream(physCmds: Uint32Array, uniformData: Uint8Array): Result<void, KernelError> {
    const uniformErr = this.uploadFrameUniforms(uniformData);
    if (uniformErr !== undefined) return uniformErr;
    this.scene4Bgl?.uploadViewUniforms(uniformData);

    this.frameBindingSets.clear();
    const encRes = this.device.createCommandEncoder({ label: 'kernel.frame' });
    if (!encRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'command encoder',
        encRes.error.hint,
      );
    }
    const encoder = encRes.value;

    this.activeRenderPass = undefined;
    this.activeComputePass = undefined;
    try {
      let cursor = 0;
      while (cursor < physCmds.length) {
        const hdr = physCmds[cursor] as number;
        const opcode = hdr & 0xffff;
        const wordLen = hdr >>> 16;
        if (wordLen === 0 || cursor + wordLen > physCmds.length) {
          return kernelErr(
            'kernel-command-stream-malformed',
            'RhiPhysicalExecutor',
            'valid physical command',
            'word length out of bounds',
          );
        }
        const cmdErr = this.executeCommand(encoder, opcode, physCmds, cursor);
        if (cmdErr !== undefined) return cmdErr;
        cursor += wordLen;
      }
    } finally {
      this.activeRenderPass = undefined;
      this.activeComputePass = undefined;
    }

    const finRes = encoder.finish();
    if (!finRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'encoder.finish',
        finRes.error.hint,
      );
    }
    const subRes = this.device.queue.submit([finRes.value]);
    if (!subRes.ok) {
      return kernelErr(
        'kernel-backend-runtime-error',
        'RhiPhysicalExecutor',
        'queue.submit',
        subRes.error.hint,
      );
    }
    return ok(undefined);
  }

  private buildBindGroupEntries(setId: number): BindGroupEntry[] | undefined {
    if (setId === INVALID_HANDLE) return undefined;
    const raw = this.frameBindingSets.get(setId);
    if (raw === undefined || raw.length === 0) return undefined;
    const entries: BindGroupEntry[] = [];
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i] as { slot: number; kind: number; handle: number; offset: number };
      if (e.kind === BINDING_KIND_DYNAMIC_TEXTURE) {
        const dyn = this.dynamicTextures.get(e.handle);
        if (dyn !== undefined)
          entries.push({ binding: e.slot, resource: { kind: 'textureView', value: dyn.view } });
      } else if (e.kind === BINDING_KIND_TEXTURE || e.kind === BINDING_KIND_TEMP_TEXTURE) {
        const view = this.resolveBindingTextureView(e.handle, e.offset);
        if (view !== undefined)
          entries.push({ binding: e.slot, resource: { kind: 'textureView', value: view } });
      } else if (e.kind === BINDING_KIND_BUFFER) {
        const buf = this.buffers.get(e.handle);
        if (buf !== undefined)
          entries.push({
            binding: e.slot,
            resource: { kind: 'buffer', value: { buffer: buf, offset: e.offset } },
          });
      } else if (e.kind === BINDING_KIND_UNIFORM_SLICE) {
        if (this.frameUniformBuffer !== undefined) {
          entries.push({
            binding: e.slot,
            resource: {
              kind: 'buffer',
              value: {
                buffer: this.frameUniformBuffer,
                offset: e.handle,
                ...(e.offset > 0 ? { size: e.offset } : {}),
              },
            },
          });
        }
      } else if (e.kind === BINDING_KIND_SAMPLER) {
        const s = this.samplers.get(e.handle);
        if (s !== undefined)
          entries.push({ binding: e.slot, resource: { kind: 'sampler', value: s } });
      }
    }
    return entries.length > 0 ? entries : undefined;
  }

  private resolveShadowViewFromBindingSet(setId: number): TextureView | undefined {
    if (setId === INVALID_HANDLE) return undefined;
    const raw = this.frameBindingSets.get(setId);
    if (raw === undefined) return undefined;
    for (const e of raw) {
      if (e.kind === BINDING_KIND_TEXTURE || e.kind === BINDING_KIND_TEMP_TEXTURE) {
        return this.resolveBindingTextureView(e.handle, e.offset);
      }
    }
    return undefined;
  }

  private bindScene4BglPassGroups(pass: RhiRenderPassEncoder): void {
    const s4 = this.scene4Bgl;
    if (s4 === undefined) return;
    pass.setBindGroup(BGL_SLOT_VIEW, s4.viewBindGroup, [this.currentViewOffset]);
    const shadowView = this.resolveShadowViewFromBindingSet(this.currentExtraBindings);
    const sceneBg = s4.createMeshSceneBindGroup(shadowView);
    if (sceneBg !== undefined) pass.setBindGroup(BGL_SLOT_MESH_SCENE, sceneBg);
    pass.setBindGroup(BGL_SLOT_INSTANCES, s4.instancesBindGroup);
    this.boundScene4BglGroups = true;
  }

  private getOrCreateMaterialBindGroup(matId: number): BindGroup | undefined {
    const s4 = this.scene4Bgl;
    const mat = this.materials.get(matId);
    if (s4 === undefined || mat === undefined) return undefined;
    if (mat.bindGroup !== undefined) return mat.bindGroup;
    const d = mat.desc;
    const bg = s4.createMaterialBindGroup({
      uniformBuffer: mat.uniformBuffer,
      baseColor:
        d.baseColorTextureId === undefined
          ? undefined
          : this.textures.get(d.baseColorTextureId)?.view,
      normal:
        d.normalTextureId === undefined ? undefined : this.textures.get(d.normalTextureId)?.view,
      metallicRoughness:
        d.metallicRoughnessTextureId === undefined
          ? undefined
          : this.textures.get(d.metallicRoughnessTextureId)?.view,
      emissive:
        d.emissiveTextureId === undefined
          ? undefined
          : this.textures.get(d.emissiveTextureId)?.view,
      occlusion:
        d.occlusionTextureId === undefined
          ? undefined
          : this.textures.get(d.occlusionTextureId)?.view,
      sampler: d.samplerId === undefined ? undefined : this.samplers.get(d.samplerId),
    });
    if (bg !== undefined) mat.bindGroup = bg;
    return bg;
  }

  private execRenderBindGroup(
    pass: RhiRenderPassEncoder,
    physCmds: Uint32Array,
    cursor: number,
  ): void {
    const slot = physCmds[cursor + 1] as number;
    const setId = physCmds[cursor + 2] as number;
    const dynCount = physCmds[cursor + 3] as number;
    if (
      slot === BGL_SLOT_VIEW &&
      (this.activeRenderPipeline === undefined || this.activePsoIs4Bgl)
    ) {
      this.currentExtraBindings = setId;
      this.currentViewOffset = dynCount > 0 ? (physCmds[cursor + 4] as number) : 0;
      if (this.activePsoIs4Bgl) {
        this.bindScene4BglPassGroups(pass);
      }
      return;
    }
    if (slot === BGL_SLOT_MATERIAL && this.activePsoIs4Bgl) {
      const matBg = this.getOrCreateMaterialBindGroup(setId);
      if (matBg !== undefined) pass.setBindGroup(BGL_SLOT_MATERIAL, matBg);
      return;
    }
    if (this.activeRenderPipeline !== undefined && setId !== INVALID_HANDLE) {
      this.bindFrameSetToRenderPass(pass, this.activeRenderPipeline, setId, slot);
    }
  }

  private bindFrameSetToRenderPass(
    pass: RhiRenderPassEncoder,
    pso: RenderPipeline,
    setId: number,
    groupIndex = 0,
  ): void {
    const entries = this.buildBindGroupEntries(setId);
    if (entries === undefined) return;
    const ops = pso as RenderPipeline & Partial<RhiRenderPipelineOps>;
    if (typeof ops.getBindGroupLayout !== 'function') return;
    const layout = ops.getBindGroupLayout(groupIndex);
    const bgRes = this.device.createBindGroup({ layout, entries });
    if (bgRes.ok) pass.setBindGroup(groupIndex, bgRes.value);
  }

  private bindFrameSetToComputePass(
    pass: RhiComputePassEncoder,
    pso: ComputePipeline,
    setId: number,
  ): void {
    const entries = this.buildBindGroupEntries(setId);
    if (entries === undefined) return;
    const ops = pso as ComputePipeline & Partial<RhiComputePipelineOps>;
    if (typeof ops.getBindGroupLayout !== 'function') return;
    const layout = ops.getBindGroupLayout(0);
    const bgRes = this.device.createBindGroup({ layout, entries });
    if (bgRes.ok) pass.setBindGroup(0, bgRes.value);
  }

  dispose(): void {
    for (const m of this.meshes.values()) {
      this.device.destroyBuffer(m.vb);
      if (m.ib !== undefined) this.device.destroyBuffer(m.ib);
    }
    for (const t of this.textures.values()) this.device.destroyTexture(t.texture);
    for (const t of this.dynamicTextures.values()) this.device.destroyTexture(t.texture);
    for (const b of this.buffers.values()) this.device.destroyBuffer(b);
    for (const m of this.materials.values()) this.device.destroyBuffer(m.uniformBuffer);
    for (const p of this.poolTextures.values()) this.device.destroyTexture(p.texture);
    for (const rb of this.pendingReadbacks.values()) this.device.destroyBuffer(rb.staging);
    if (this.frameUniformBuffer !== undefined) {
      this.device.destroyBuffer(this.frameUniformBuffer);
      this.frameUniformBuffer = undefined;
    }
    this.scene4Bgl?.dispose();
    this.pendingReadbacks.clear();
    this.mipgenPipelines.clear();
    this.mipgenShader = undefined;
    this.mipgenSampler = undefined;
    this.meshes.clear();
    this.textures.clear();
    this.dynamicTextures.clear();
    this.buffers.clear();
    this.samplers.clear();
    this.shaders.clear();
    this.materials.clear();
    this.poolTextures.clear();
    this.psoByKey.clear();
    this.psoBySlot.clear();
  }
}
