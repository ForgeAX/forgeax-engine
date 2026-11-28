// Device-agnostic Standard 3D PBR Scene Renderer built directly on RenderKernel + KernelRenderGraph.
// Runs identically on Desktop Native (Metal/DX12/Vulkan), WebGPU/Dawn (RhiPhysicalExecutor),
// and Browser WebGL2 WASM closure (WasmWgpuRenderKernel) with hot-pluggable KernelRenderFeatures.

import type {
  FrameSubmitReceipt,
  KernelAssetApi,
  KernelMaterialDesc,
  KernelReadbackResult,
  RenderKernelExecutionTarget,
} from '../contract.js';
import { TEXTURE_FORMAT_RGBA8_UNORM, type TextureFormatCode } from '../dynamic-texture.js';
import { type KernelError, kernelErr, ok, type Result } from '../errors.js';
import { KernelGraphCache } from '../graph/cache.js';
import type { CompiledKernelGraphInfo, KernelRenderFeature } from '../graph/types.js';
import type {
  BufferId,
  CullId,
  DynamicTextureId,
  LightId,
  MaterialId,
  MeshId,
  RenderObjectId,
  SamplerId,
  ShaderProgramId,
  TextureId,
} from '../handles.js';
import {
  LAYOUT_FAMILY_SCENE_4BGL,
  RENDER_STATE_ALPHA_BLEND,
  RENDER_STATE_CULL_BACK,
  RENDER_STATE_CULL_NONE,
  RENDER_STATE_DEPTH_LESS_EQUAL,
  RENDER_STATE_DEPTH_WRITE,
} from '../pso-key.js';
import {
  DELTA_FLAG_BASELINE,
  LIGHT_KIND_DIRECTIONAL,
  LIGHT_KIND_POINT,
  LIGHT_KIND_SPOT,
  type LightInput,
  OBJ_FLAG_CAST_SHADOW,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_MASKED,
  OBJ_FLAG_RECEIVE_SHADOW,
  OBJ_FLAG_TRANSPARENT,
  OBJ_FLAG_VISIBLE,
  type SceneDeltaWriter,
  type UpsertObjectInput,
} from '../scene-delta.js';
import {
  computeInterleavedBounds,
  kernelMat4Invert,
  kernelMat4LookAt,
  kernelMat4Multiply,
  kernelMat4Ortho,
} from './math.js';
import {
  KERNEL_VERTEX_LAYOUT_DEBUG_LINES,
  KERNEL_VERTEX_LAYOUT_SKINNED,
  KERNEL_VERTEX_LAYOUT_STANDARD,
  WGSL_KERNEL_4BGL_PBR,
  WGSL_KERNEL_4BGL_PBR_SKINNED,
  WGSL_KERNEL_BLOOM_BLUR_V,
  WGSL_KERNEL_BLOOM_COMPOSITE,
  WGSL_KERNEL_BLOOM_EXTRACT_H,
  WGSL_KERNEL_DEBUG_LINES,
  WGSL_KERNEL_FXAA,
  WGSL_KERNEL_SHADOW_DEPTH,
  WGSL_KERNEL_SHADOW_SKINNED,
  WGSL_KERNEL_SKYBOX,
  WGSL_KERNEL_TONEMAP_OUTPUT,
  WGSL_KERNEL_UI_OVERLAY,
  WGSL_KERNEL_UNIFORM_PBR,
} from './shaders.js';
import {
  createKernelStandardPipeline,
  type KernelStandardGraphTopology,
} from './standard-graph.js';
import type {
  KernelResourceKey,
  KernelStandardCameraInput,
  KernelStandardCustomShaderOptions,
  KernelStandardFogInput,
  KernelStandardFrameInput,
  KernelStandardLightInput,
  KernelStandardMaterialInput,
  KernelStandardMeshInput,
  KernelStandardPipelineFrame,
  KernelStandardRendererOptions,
  KernelStandardRenderObjectInput,
  KernelStandardSceneStats,
  KernelStandardTextureInput,
  KernelTonemapMode,
  KernelUniformFallbackDraw,
} from './types.js';

const VIEW_UBO_BYTES = 544;
const SHADOW_VIEW_UBO_BYTES = 128;
const MATERIAL_UBO_FLOATS = 16;
const GPU_USAGE_VERTEX = 0x20;
const GPU_USAGE_COPY_DST = 0x08;

interface CachedMeshRecord {
  readonly meshId: MeshId;
  readonly skinned: boolean;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly isUint32Index: boolean;
  readonly submeshes: readonly {
    readonly firstIndex: number;
    readonly indexCount: number;
    readonly baseVertex: number;
    readonly firstVertex: number;
    readonly vertexCount: number;
  }[];
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
}

interface CachedMaterialRecord {
  readonly materialId: MaterialId;
  readonly transparent: boolean;
  readonly masked: boolean;
  readonly skinned: boolean;
  readonly queue: number;
  readonly baseColor: [number, number, number, number];
  readonly emissive: [number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly baseColorTexId: TextureId | undefined;
}

interface TrackedObjectState {
  readonly objectId: RenderObjectId;
  meshId: MeshId;
  submeshIndex: number;
  materialId: MaterialId;
  layerMask: number;
  flags: number;
  queue: number;
  skinSlot: number;
  readonly worldMatrix: Float32Array;
}

function resolveSupportsScene4Bgl(kernel: RenderKernelExecutionTarget): boolean {
  if (typeof kernel.supportsScene4Bgl === 'function') return kernel.supportsScene4Bgl();
  if (typeof kernel.supportsScene4Bgl === 'boolean') return kernel.supportsScene4Bgl;
  return false;
}

function tonemapModeToCode(mode: KernelTonemapMode | undefined): number {
  switch (mode) {
    case 'agx':
      return 1;
    case 'reinhard':
      return 2;
    case 'neutral':
      return 3;
    case 'none':
      return 4;
    default:
      return 0;
  }
}

function fogModeToCode(mode: KernelStandardFogInput['mode'] | undefined): number {
  if (mode === 'exp') return 1;
  if (mode === 'exp2') return 2;
  if (mode === 'linear') return 3;
  return 0;
}

function writeMaterialUbo(
  out: Float32Array,
  input: KernelStandardMaterialInput,
  hasNormalMap: boolean,
): void {
  const transparent = input.transparent === true || input.alphaMode === 'blend';
  const masked = input.alphaMode === 'mask';
  out[0] = input.baseColor[0];
  out[1] = input.baseColor[1];
  out[2] = input.baseColor[2];
  out[3] = input.baseColor[3];
  out[4] = input.roughness ?? 0.5;
  out[5] = input.metallic ?? 0.0;
  out[6] = input.alphaCutoff ?? 0.5;
  out[7] = (transparent ? 1 : 0) | (masked ? 2 : 0) | (hasNormalMap ? 4 : 0);
  out[8] = input.emissive?.[0] ?? 0;
  out[9] = input.emissive?.[1] ?? 0;
  out[10] = input.emissive?.[2] ?? 0;
  out[11] = input.occlusionStrength ?? 1.0;
  out[12] = input.normalScale ?? 1.0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 0;
}

function matsDiffer(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

function encodeFeatureTopologyKey(
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
): string {
  const parts: string[] = [];
  for (const f of features) {
    if (f.enabled !== false) parts.push(`${f.stage}:${f.name}`);
  }
  return parts.join(',');
}

function registerStandardSceneShaders(
  assets: KernelAssetApi,
  supports4Bgl: boolean,
  hdrFormat: GPUTextureFormat,
): Result<
  {
    readonly pbr: ShaderProgramId;
    readonly skinnedPbr: ShaderProgramId;
    readonly shadow: ShaderProgramId;
    readonly skinnedShadow: ShaderProgramId;
    readonly uniformPbrOpaque: ShaderProgramId;
    readonly uniformPbrTransparent: ShaderProgramId;
  },
  KernelError
> {
  const pbr = supports4Bgl
    ? assets.registerShaderProgram({
        code: WGSL_KERNEL_4BGL_PBR,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: 'fs_main',
        layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
        vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_STANDARD,
        colorFormats: [hdrFormat],
        depthFormat: 'depth32float',
        label: 'standard.4bgl-pbr',
      })
    : ok(0 as ShaderProgramId);
  if (!pbr.ok) return pbr;

  const skinnedPbr = supports4Bgl
    ? assets.registerShaderProgram({
        code: WGSL_KERNEL_4BGL_PBR_SKINNED,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: 'fs_main',
        layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
        vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_SKINNED,
        colorFormats: [hdrFormat],
        depthFormat: 'depth32float',
        label: 'standard.4bgl-pbr-skinned',
      })
    : ok(0 as ShaderProgramId);
  if (!skinnedPbr.ok) return skinnedPbr;

  const shadow = supports4Bgl
    ? assets.registerShaderProgram({
        code: WGSL_KERNEL_SHADOW_DEPTH,
        vertexEntryPoint: 'vs_shadow',
        layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
        vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_STANDARD,
        colorFormats: [],
        depthFormat: 'depth32float',
        label: 'standard.shadow',
      })
    : ok(0 as ShaderProgramId);
  if (!shadow.ok) return shadow;

  const skinnedShadow = supports4Bgl
    ? assets.registerShaderProgram({
        code: WGSL_KERNEL_SHADOW_SKINNED,
        vertexEntryPoint: 'vs_shadow',
        layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
        vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_SKINNED,
        colorFormats: [],
        depthFormat: 'depth32float',
        label: 'standard.shadow-skinned',
      })
    : ok(0 as ShaderProgramId);
  if (!skinnedShadow.ok) return skinnedShadow;

  const uniformPbrOpaque = assets.registerShaderProgram({
    code: WGSL_KERNEL_UNIFORM_PBR,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_STANDARD,
    colorFormats: [hdrFormat],
    depthFormat: 'depth32float',
    cullMode: 'back',
    label: 'standard.uniform-pbr-opaque',
  });
  if (!uniformPbrOpaque.ok) return uniformPbrOpaque;

  const uniformPbrTransparent = assets.registerShaderProgram({
    code: WGSL_KERNEL_UNIFORM_PBR,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_STANDARD,
    colorTargets: [{ format: hdrFormat, blendMode: 'alpha' }],
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    },
    label: 'standard.uniform-pbr-transparent',
  });
  if (!uniformPbrTransparent.ok) return uniformPbrTransparent;

  return ok({
    pbr: pbr.value,
    skinnedPbr: skinnedPbr.value,
    shadow: shadow.value,
    skinnedShadow: skinnedShadow.value,
    uniformPbrOpaque: uniformPbrOpaque.value,
    uniformPbrTransparent: uniformPbrTransparent.value,
  });
}

function registerStandardPostShaders(
  assets: KernelAssetApi,
  hdrFormat: GPUTextureFormat,
  outputFormat: GPUTextureFormat,
): Result<
  {
    readonly skybox: ShaderProgramId;
    readonly bloomExtractH: ShaderProgramId;
    readonly bloomBlurV: ShaderProgramId;
    readonly bloomComposite: ShaderProgramId;
    readonly tonemapLdr: ShaderProgramId;
    readonly tonemapOutput: ShaderProgramId;
    readonly fxaaOutput: ShaderProgramId;
    readonly debugLines: ShaderProgramId;
    readonly uiOverlayOutput: ShaderProgramId;
  },
  KernelError
> {
  const skybox = assets.registerShaderProgram({
    code: WGSL_KERNEL_SKYBOX,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [hdrFormat],
    label: 'standard.skybox',
  });
  if (!skybox.ok) return skybox;

  const bloomExtractH = assets.registerShaderProgram({
    code: WGSL_KERNEL_BLOOM_EXTRACT_H,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [hdrFormat],
    label: 'standard.bloom-extract-h',
  });
  if (!bloomExtractH.ok) return bloomExtractH;

  const bloomBlurV = assets.registerShaderProgram({
    code: WGSL_KERNEL_BLOOM_BLUR_V,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [hdrFormat],
    label: 'standard.bloom-blur-v',
  });
  if (!bloomBlurV.ok) return bloomBlurV;

  const bloomComposite = assets.registerShaderProgram({
    code: WGSL_KERNEL_BLOOM_COMPOSITE,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [hdrFormat],
    blendMode: 'additive',
    label: 'standard.bloom-composite',
  });
  if (!bloomComposite.ok) return bloomComposite;

  const tonemapLdr = assets.registerShaderProgram({
    code: WGSL_KERNEL_TONEMAP_OUTPUT,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: ['rgba8unorm'],
    label: 'standard.tonemap-ldr',
  });
  if (!tonemapLdr.ok) return tonemapLdr;

  const tonemapOutput = assets.registerShaderProgram({
    code: WGSL_KERNEL_TONEMAP_OUTPUT,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [outputFormat],
    label: 'standard.tonemap-output',
  });
  if (!tonemapOutput.ok) return tonemapOutput;

  const fxaaOutput = assets.registerShaderProgram({
    code: WGSL_KERNEL_FXAA,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [outputFormat],
    label: 'standard.fxaa-output',
  });
  if (!fxaaOutput.ok) return fxaaOutput;

  const debugLines = assets.registerShaderProgram({
    code: WGSL_KERNEL_DEBUG_LINES,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    vertexBufferLayouts: KERNEL_VERTEX_LAYOUT_DEBUG_LINES,
    colorTargets: [{ format: hdrFormat, blendMode: 'alpha' }],
    depthStencil: {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    },
    primitiveTopology: 'line-list',
    label: 'standard.debug-lines',
  });
  if (!debugLines.ok) return debugLines;

  const uiOverlayOutput = assets.registerShaderProgram({
    code: WGSL_KERNEL_UI_OVERLAY,
    vertexEntryPoint: 'vs_main',
    fragmentEntryPoint: 'fs_main',
    layoutFamilyId: 0,
    colorFormats: [outputFormat],
    blendMode: 'alpha',
    label: 'standard.ui-overlay',
  });
  if (!uiOverlayOutput.ok) return uiOverlayOutput;

  return ok({
    skybox: skybox.value,
    bloomExtractH: bloomExtractH.value,
    bloomBlurV: bloomBlurV.value,
    bloomComposite: bloomComposite.value,
    tonemapLdr: tonemapLdr.value,
    tonemapOutput: tonemapOutput.value,
    fxaaOutput: fxaaOutput.value,
    debugLines: debugLines.value,
    uiOverlayOutput: uiOverlayOutput.value,
  });
}

function updateCachedMaterialRecord(
  existing: CachedMaterialRecord,
  input: KernelStandardMaterialInput,
): void {
  existing.baseColor[0] = input.baseColor[0];
  existing.baseColor[1] = input.baseColor[1];
  existing.baseColor[2] = input.baseColor[2];
  existing.baseColor[3] = input.baseColor[3];
  existing.emissive[0] = input.emissive?.[0] ?? 0;
  existing.emissive[1] = input.emissive?.[1] ?? 0;
  existing.emissive[2] = input.emissive?.[2] ?? 0;
}

function lookupOptionalTexture(
  textures: ReadonlyMap<KernelResourceKey, TextureId>,
  key: KernelResourceKey | undefined,
): TextureId | undefined {
  return key === undefined ? undefined : textures.get(key);
}

function resolveNewMaterialSetup(
  input: KernelStandardMaterialInput,
  customShaders: ReadonlyMap<
    KernelResourceKey,
    { readonly shaderId: ShaderProgramId; readonly skinned: boolean }
  >,
  textures: ReadonlyMap<KernelResourceKey, TextureId>,
  pbrShader: ShaderProgramId,
  skinnedPbrShader: ShaderProgramId,
): {
  readonly transparent: boolean;
  readonly masked: boolean;
  readonly skinned: boolean;
  readonly queue: number;
  readonly baseColorTexId: TextureId | undefined;
  readonly desc: KernelMaterialDesc;
} {
  const transparent = input.transparent === true || input.alphaMode === 'blend';
  const masked = input.alphaMode === 'mask';
  const custom =
    input.customShaderKey === undefined ? undefined : customShaders.get(input.customShaderKey);
  const skinned = custom !== undefined ? custom.skinned : input.skinned === true;
  const shaderProgramId =
    custom !== undefined ? custom.shaderId : skinned ? skinnedPbrShader : pbrShader;
  const renderStateBits =
    RENDER_STATE_DEPTH_LESS_EQUAL |
    (transparent ? RENDER_STATE_ALPHA_BLEND : RENDER_STATE_DEPTH_WRITE) |
    (input.doubleSided === true || masked ? RENDER_STATE_CULL_NONE : RENDER_STATE_CULL_BACK);
  const queue = input.queue ?? (transparent ? 3000 : masked ? 2450 : 2000);
  const baseColorTexId = lookupOptionalTexture(textures, input.baseColorTextureKey);
  const normalTexId = lookupOptionalTexture(textures, input.normalTextureKey);
  const mrTexId = lookupOptionalTexture(textures, input.metallicRoughnessTextureKey);
  const emissiveTexId = lookupOptionalTexture(textures, input.emissiveTextureKey);
  const occTexId = lookupOptionalTexture(textures, input.occlusionTextureKey);
  const desc: KernelMaterialDesc = {
    shaderProgramId,
    layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
    renderStateBits,
    queue,
    ...(baseColorTexId === undefined ? {} : { baseColorTextureId: baseColorTexId }),
    ...(normalTexId === undefined ? {} : { normalTextureId: normalTexId }),
    ...(mrTexId === undefined ? {} : { metallicRoughnessTextureId: mrTexId }),
    ...(emissiveTexId === undefined ? {} : { emissiveTextureId: emissiveTexId }),
    ...(occTexId === undefined ? {} : { occlusionTextureId: occTexId }),
    ...(input.label === undefined ? {} : { label: input.label }),
  };
  return { transparent, masked, skinned, queue, baseColorTexId, desc };
}

function packCascadeViewUniforms(
  f: Float32Array,
  cascadeVps: readonly Float32Array[],
  cascadeCount: number,
  maxDist: number,
): void {
  for (let c = 0; c < 4; c++) {
    f.set(cascadeVps[Math.min(c, cascadeCount - 1)] as Float32Array, 16 + c * 16);
  }
  f[80] = maxDist * 0.25;
  f[81] = maxDist * 0.5;
  f[82] = maxDist * 0.75;
  f[83] = maxDist;
  const isTiled = cascadeCount > 1;
  for (let c = 0; c < 4; c++) {
    const base = 84 + c * 4;
    f[base] = isTiled ? (c & 1) * 0.5 : 0;
    f[base + 1] = isTiled ? ((c >> 1) & 1) * 0.5 : 0;
    f[base + 2] = isTiled ? 0.5 : 1;
    f[base + 3] = isTiled ? 0.5 : 1;
  }
}

function packSkylightAndShadowMetaUniforms(
  f: Float32Array,
  u: Uint32Array,
  input: KernelStandardFrameInput,
  shadowLightIdx: number,
  cascadeCount: number,
  shadowMapSize: number,
): void {
  const sky = input.skylight;
  f[104] = sky?.skyColor[0] ?? 0.2;
  f[105] = sky?.skyColor[1] ?? 0.22;
  f[106] = sky?.skyColor[2] ?? 0.25;
  f[107] = sky?.intensity ?? 0.35;
  f[108] = sky?.groundColor?.[0] ?? sky?.skyColor[0] ?? 0.1;
  f[109] = sky?.groundColor?.[1] ?? sky?.skyColor[1] ?? 0.1;
  f[110] = sky?.groundColor?.[2] ?? sky?.skyColor[2] ?? 0.12;
  f[111] = 0.0025;

  u[112] = Math.min(input.lights.length, 16);
  u[113] = shadowLightIdx >= 0 ? 1 : 0;
  u[114] = shadowLightIdx >= 0 ? shadowLightIdx : 0;
  u[115] = cascadeCount;

  const atlasDim = cascadeCount > 1 ? shadowMapSize * 2 : shadowMapSize;
  f[116] = 1 / atlasDim;
  f[117] = 1 / atlasDim;
  f[118] = atlasDim;
  f[119] = atlasDim;
}

function packFogUniforms(f: Float32Array, fog: KernelStandardFogInput | undefined): void {
  f[120] = fog?.color[0] ?? 0;
  f[121] = fog?.color[1] ?? 0;
  f[122] = fog?.color[2] ?? 0;
  f[123] = fogModeToCode(fog?.mode);
  f[124] = fog?.density ?? 0.02;
  f[125] = fog?.heightFalloff ?? 0;
  f[126] = fog?.near ?? 10;
  f[127] = fog?.far ?? 100;
  f[128] = fog?.maxOpacity ?? 1;
}

function collectUniformFallbackDraws(
  objects: readonly KernelStandardRenderObjectInput[],
  meshes: ReadonlyMap<KernelResourceKey, CachedMeshRecord>,
  materials: ReadonlyMap<KernelResourceKey, CachedMaterialRecord>,
): {
  readonly hasTransparent: boolean;
  readonly skinnedCount: number;
  readonly fallbackDraws: readonly KernelUniformFallbackDraw[];
} {
  let hasTransparent = false;
  const fallbackDraws: KernelUniformFallbackDraw[] = [];
  for (const obj of objects) {
    if (obj.visible === false) continue;
    const mesh = meshes.get(obj.meshKey);
    const mat = materials.get(obj.materialKey);
    if (mesh === undefined || mat === undefined) continue;
    if (mat.transparent) hasTransparent = true;
    const sub = mesh.submeshes[obj.submeshIndex ?? 0] ?? mesh.submeshes[0];
    if (sub === undefined) continue;
    fallbackDraws.push({
      meshId: mesh.meshId,
      indexCount: sub.indexCount,
      vertexCount: sub.vertexCount,
      isUint32Index: mesh.isUint32Index,
      firstIndex: sub.firstIndex,
      baseVertex: sub.baseVertex,
      firstVertex: sub.firstVertex,
      transparent: mat.transparent,
      baseColor: mat.baseColor,
      emissive: mat.emissive,
      roughness: mat.roughness,
      metallic: mat.metallic,
      worldMatrix: obj.worldMatrix,
      baseColorTexId: mat.baseColorTexId,
    });
  }
  return { hasTransparent, skinnedCount: 0, fallbackDraws };
}

interface SceneObjectDiffResult {
  readonly hasTransparent: boolean;
  readonly skinnedCount: number;
  readonly upserts: readonly UpsertObjectInput[];
  readonly removed: readonly RenderObjectId[];
  readonly dirtyTransforms: readonly {
    readonly objectId: RenderObjectId;
    readonly worldMatrix: Float32Array;
  }[];
  readonly dirtyDrawParams: readonly {
    readonly objectId: RenderObjectId;
    readonly params: Float32Array;
  }[];
}

function computeObjectFlags(
  obj: KernelStandardRenderObjectInput,
  mat: CachedMaterialRecord,
): number {
  return (
    (obj.visible === false ? 0 : OBJ_FLAG_VISIBLE) |
    (obj.castShadow === false ? 0 : OBJ_FLAG_CAST_SHADOW) |
    (obj.receiveShadow === false ? 0 : OBJ_FLAG_RECEIVE_SHADOW) |
    (obj.frustumCulled === false ? 0 : OBJ_FLAG_FRUSTUM_CULLED) |
    (mat.transparent ? OBJ_FLAG_TRANSPARENT : 0) |
    (mat.masked ? OBJ_FLAG_MASKED : 0)
  );
}

function trackedObjectNeedsUpsert(
  prev: TrackedObjectState | undefined,
  meshId: MeshId,
  subIdx: number,
  materialId: MaterialId,
  layerMask: number,
  flags: number,
  queue: number,
  skinSlot: number,
): boolean {
  return (
    prev === undefined ||
    prev.meshId !== meshId ||
    prev.submeshIndex !== subIdx ||
    prev.materialId !== materialId ||
    prev.layerMask !== layerMask ||
    prev.flags !== flags ||
    prev.queue !== queue ||
    prev.skinSlot !== skinSlot
  );
}

function buildObjectDrawParams(
  obj: KernelStandardRenderObjectInput,
  skinSlot: number,
): Float32Array {
  const drawParams = new Float32Array(8);
  if (obj.tint !== undefined) {
    drawParams[0] = obj.tint[0];
    drawParams[1] = obj.tint[1];
    drawParams[2] = obj.tint[2];
    drawParams[3] = obj.tint[3];
  }
  drawParams[6] = obj.skinInLocalSpace === true ? 1 : 0;
  drawParams[7] = skinSlot;
  return drawParams;
}

function diffTrackedSceneObjects(
  objects: readonly KernelStandardRenderObjectInput[],
  meshes: ReadonlyMap<KernelResourceKey, CachedMeshRecord>,
  materials: ReadonlyMap<KernelResourceKey, CachedMaterialRecord>,
  trackedObjects: Map<number, TrackedObjectState>,
  idAlloc: { next: number },
): SceneObjectDiffResult {
  let hasTransparent = false;
  let skinnedCount = 0;
  const seen = new Set<number>();
  const upserts: UpsertObjectInput[] = [];
  const dirtyTransforms: {
    readonly objectId: RenderObjectId;
    readonly worldMatrix: Float32Array;
  }[] = [];
  const dirtyDrawParams: { readonly objectId: RenderObjectId; readonly params: Float32Array }[] =
    [];

  for (const obj of objects) {
    const mesh = meshes.get(obj.meshKey);
    const mat = materials.get(obj.materialKey);
    if (mesh === undefined || mat === undefined) continue;
    if (mat.transparent && obj.visible !== false) hasTransparent = true;
    const skinSlot = obj.skinSlot ?? 0;
    if (mesh.skinned && skinSlot > 0) skinnedCount += 1;

    seen.add(obj.entityId);
    const subIdx = obj.submeshIndex ?? 0;
    const layerMask = (obj.layerMask ?? 0xffff_ffff) >>> 0;
    const flags = computeObjectFlags(obj, mat);
    const queue = mesh.skinned ? Math.max(2451, Math.min(2490, mat.queue)) : mat.queue;
    const prev = trackedObjects.get(obj.entityId);

    if (
      trackedObjectNeedsUpsert(
        prev,
        mesh.meshId,
        subIdx,
        mat.materialId,
        layerMask,
        flags,
        queue,
        skinSlot,
      )
    ) {
      const objectId = prev?.objectId ?? (idAlloc.next++ as RenderObjectId);
      const storedWorld = prev?.worldMatrix ?? new Float32Array(16);
      storedWorld.set(obj.worldMatrix.subarray(0, 16), 0);
      trackedObjects.set(obj.entityId, {
        objectId,
        meshId: mesh.meshId,
        submeshIndex: subIdx,
        materialId: mat.materialId,
        layerMask,
        flags,
        queue,
        skinSlot,
        worldMatrix: storedWorld,
      });
      upserts.push({
        objectId,
        meshId: mesh.meshId,
        submeshStart: subIdx,
        submeshCount: 1,
        materialId: mat.materialId,
        layerMask,
        objFlags: flags,
        queue,
        entityOrder: obj.entityId & 0xffff,
        localBoundsMin: mesh.boundsMin,
        localBoundsMax: mesh.boundsMax,
        skinSlot,
      });
      dirtyTransforms.push({ objectId, worldMatrix: storedWorld });
      dirtyDrawParams.push({ objectId, params: buildObjectDrawParams(obj, skinSlot) });
    } else if (prev !== undefined && matsDiffer(prev.worldMatrix, obj.worldMatrix)) {
      prev.worldMatrix.set(obj.worldMatrix.subarray(0, 16), 0);
      dirtyTransforms.push({ objectId: prev.objectId, worldMatrix: prev.worldMatrix });
    }
  }

  const removed: RenderObjectId[] = [];
  for (const [entityId, state] of trackedObjects) {
    if (!seen.has(entityId)) {
      removed.push(state.objectId);
      trackedObjects.delete(entityId);
    }
  }
  return { hasTransparent, skinnedCount, upserts, removed, dirtyTransforms, dirtyDrawParams };
}

function encodeSceneLightInputs(lights: readonly KernelStandardLightInput[]): LightInput[] {
  return lights.map((l) => ({
    lightId: l.id as LightId,
    kind:
      l.kind === 'directional'
        ? LIGHT_KIND_DIRECTIONAL
        : l.kind === 'point'
          ? LIGHT_KIND_POINT
          : LIGHT_KIND_SPOT,
    position: l.position ?? [0, 0, 0],
    direction: l.direction ?? [0, -1, 0],
    color: l.color,
    intensity: l.intensity,
    range: l.range ?? 1e9,
    outerConeCos: l.outerConeCos ?? 0.5,
    castShadow: l.castShadow === true,
    cascadeCount: l.cascadeCount ?? 1,
    layerMask: 0xffff_ffff,
  }));
}

function writeSceneDeltaOperations(
  writer: SceneDeltaWriter,
  sceneRevision: number,
  prevRevision: number,
  baselineCommitted: boolean,
  diff: SceneObjectDiffResult,
  lightInputs: readonly LightInput[],
): void {
  writer.reset(
    1,
    sceneRevision,
    baselineCommitted ? prevRevision : 0,
    baselineCommitted ? 0 : DELTA_FLAG_BASELINE,
  );
  if (diff.removed.length > 0) writer.removeObjects(diff.removed);
  if (diff.upserts.length > 0) writer.upsertObjects(diff.upserts);
  if (diff.dirtyTransforms.length > 0) {
    const ids = new Uint32Array(diff.dirtyTransforms.length);
    const mats = new Float32Array(diff.dirtyTransforms.length * 16);
    for (let i = 0; i < diff.dirtyTransforms.length; i++) {
      const entry = diff.dirtyTransforms[i];
      if (entry === undefined) continue;
      ids[i] = entry.objectId;
      mats.set(entry.worldMatrix.subarray(0, 16), i * 16);
    }
    writer.setTransforms(ids, mats, diff.dirtyTransforms.length);
  }
  if (diff.dirtyDrawParams.length > 0) {
    const ids = new Uint32Array(diff.dirtyDrawParams.length);
    const flat = new Float32Array(diff.dirtyDrawParams.length * 8);
    for (let i = 0; i < diff.dirtyDrawParams.length; i++) {
      const entry = diff.dirtyDrawParams[i];
      if (entry === undefined) continue;
      ids[i] = entry.objectId;
      flat.set(entry.params.subarray(0, 8), i * 8);
    }
    writer.setDrawParams(ids, flat, diff.dirtyDrawParams.length);
  }
  writer.setLights(lightInputs);
}

function buildStandardTopologyKey(
  input: KernelStandardFrameInput,
  base: {
    readonly hdrFormat: GPUTextureFormat;
    readonly outputFormat: GPUTextureFormat;
    readonly headless: boolean;
    readonly supportsScene4Bgl: boolean;
    readonly hasShadowLight: boolean;
    readonly shadowAtlasDim: number;
    readonly hasTransparent: boolean;
    readonly hasDebugLines: boolean;
    readonly hasUiOverlay: boolean;
  },
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
): { readonly topology: KernelStandardGraphTopology; readonly topoKey: string } {
  const topology: KernelStandardGraphTopology = {
    ...base,
    hasSkybox: input.skybox !== undefined,
    bloomEnabled: input.camera.bloom?.enabled === true,
    fxaaEnabled: input.camera.fxaa === true,
    hasReadback: input.readbackTicketId !== undefined,
  };
  const topoKey = [
    topology.hdrFormat,
    topology.outputFormat,
    Number(topology.headless),
    Number(topology.supportsScene4Bgl),
    topology.hasShadowLight ? topology.shadowAtlasDim : 0,
    Number(topology.hasSkybox),
    Number(topology.hasTransparent),
    Number(topology.bloomEnabled),
    Number(topology.fxaaEnabled),
    Number(topology.hasDebugLines),
    Number(topology.hasUiOverlay),
    Number(topology.hasReadback),
    encodeFeatureTopologyKey(features),
  ].join(':');
  return { topology, topoKey };
}

function runStandardFrameCulls(
  kernel: RenderKernelExecutionTarget,
  supportsScene4Bgl: boolean,
  hasShadowLight: boolean,
  cascadeCount: number,
  cascadeVps: readonly Float32Array[],
  cascadeCamPositions: readonly [number, number, number][],
  camera: KernelStandardCameraInput,
): Result<{ readonly mainCullId: CullId; readonly shadowCullIds: readonly CullId[] }, KernelError> {
  if (!supportsScene4Bgl) {
    return ok({ mainCullId: 1 as CullId, shadowCullIds: [] });
  }
  const shadowCullIds: CullId[] = [];
  if (hasShadowLight) {
    for (let c = 0; c < cascadeCount; c++) {
      const sc = kernel.cull({
        viewProj: cascadeVps[c] as Float32Array,
        cameraPos: cascadeCamPositions[c] as readonly [number, number, number],
      });
      if (!sc.ok) return sc;
      shadowCullIds.push(sc.value.cullId);
    }
  }
  const mc = kernel.cull({
    viewProj: camera.viewProj,
    cameraPos: camera.position,
    layerMask: camera.cullMask ?? 0xffff_ffff,
  });
  if (!mc.ok) return mc;
  return ok({ mainCullId: mc.value.cullId, shadowCullIds });
}

function buildFallbackLightingPayload(input: KernelStandardFrameInput): {
  readonly fallbackLightDir: readonly [number, number, number];
  readonly fallbackLightColorIntensity: readonly [number, number, number, number];
  readonly fallbackAmbient: readonly [number, number, number, number];
  readonly fallbackFog0: readonly [number, number, number, number];
  readonly fallbackFog1: readonly [number, number, number, number];
} {
  const primaryDir = input.lights.find((l) => l.kind === 'directional') ?? input.lights[0];
  const sky = input.skylight;
  const fog = input.fog;
  return {
    fallbackLightDir: primaryDir?.direction ?? [-0.5, -1, -0.3],
    fallbackLightColorIntensity: [
      primaryDir?.color[0] ?? 1,
      primaryDir?.color[1] ?? 1,
      primaryDir?.color[2] ?? 1,
      primaryDir?.intensity ?? 2.5,
    ],
    fallbackAmbient: [
      sky?.skyColor[0] ?? 0.2,
      sky?.skyColor[1] ?? 0.22,
      sky?.skyColor[2] ?? 0.25,
      sky?.intensity ?? 0.35,
    ],
    fallbackFog0: [
      fog?.color[0] ?? 0,
      fog?.color[1] ?? 0,
      fog?.color[2] ?? 0,
      fogModeToCode(fog?.mode),
    ],
    fallbackFog1: [fog?.density ?? 0.02, fog?.heightFalloff ?? 0, fog?.near ?? 10, fog?.far ?? 100],
  };
}

export class KernelStandardSceneRenderer {
  readonly kernel: RenderKernelExecutionTarget;
  readonly supportsScene4Bgl: boolean;
  private readonly assets: KernelAssetApi;
  private readonly shadowMapSize: number;
  private readonly hdrFormat: GPUTextureFormat;
  private readonly outputFormat: GPUTextureFormat;
  private readonly headless: boolean;
  private readonly defaultClearColor: readonly [number, number, number, number];

  private readonly postSampler: SamplerId;
  private readonly defaultWhiteTexture: TextureId;
  private readonly pbrShader: ShaderProgramId;
  private readonly skinnedPbrShader: ShaderProgramId;
  private readonly shadowShader: ShaderProgramId;
  private readonly skinnedShadowShader: ShaderProgramId;
  private readonly uniformPbrOpaqueShader: ShaderProgramId;
  private readonly uniformPbrTransparentShader: ShaderProgramId;
  private readonly skyboxShader: ShaderProgramId;
  private readonly bloomExtractHShader: ShaderProgramId;
  private readonly bloomBlurVShader: ShaderProgramId;
  private readonly bloomCompositeShader: ShaderProgramId;
  private readonly tonemapLdrShader: ShaderProgramId;
  private readonly tonemapOutputShader: ShaderProgramId;
  private readonly fxaaOutputShader: ShaderProgramId;
  private readonly debugLinesShader: ShaderProgramId;
  private readonly uiOverlayOutputShader: ShaderProgramId;

  private readonly meshes = new Map<KernelResourceKey, CachedMeshRecord>();
  private readonly textures = new Map<KernelResourceKey, TextureId>();
  private readonly materials = new Map<KernelResourceKey, CachedMaterialRecord>();
  private readonly customShaders = new Map<
    KernelResourceKey,
    { readonly shaderId: ShaderProgramId; readonly skinned: boolean }
  >();
  private readonly trackedObjects = new Map<number, TrackedObjectState>();
  private readonly features: KernelRenderFeature<KernelStandardPipelineFrame>[] = [];
  private readonly graphCache = new KernelGraphCache<KernelStandardPipelineFrame>();

  private uiDynamicTexId: DynamicTextureId | undefined;
  private uiRevision = 0;
  private uiOverlayActive = false;
  private debugLineBuffer: BufferId | undefined;
  private debugLineCapacityBytes = 0;
  private debugLineVertexCount = 0;

  private nextObjectId = 1;
  private framesSubmitted = 0;
  private sceneRevision = 0;
  private baselineCommitted = false;
  private disposed = false;

  // Persistent zero-alloc UBO scratch views
  private readonly viewUboBuf = new ArrayBuffer(VIEW_UBO_BYTES);
  private readonly viewUboF32 = new Float32Array(this.viewUboBuf);
  private readonly viewUboU32 = new Uint32Array(this.viewUboBuf);
  private readonly viewUboBytes = new Uint8Array(this.viewUboBuf);
  private readonly cascadeVps: readonly Float32Array[] = [
    new Float32Array(16),
    new Float32Array(16),
    new Float32Array(16),
    new Float32Array(16),
  ];
  private readonly cascadeCamPositions: readonly [number, number, number][] = [
    [0, 10, 0],
    [0, 10, 0],
    [0, 10, 0],
    [0, 10, 0],
  ];
  private readonly cascadeViewUboF32: readonly Float32Array[] = [
    new Float32Array(SHADOW_VIEW_UBO_BYTES / 4),
    new Float32Array(SHADOW_VIEW_UBO_BYTES / 4),
    new Float32Array(SHADOW_VIEW_UBO_BYTES / 4),
    new Float32Array(SHADOW_VIEW_UBO_BYTES / 4),
  ];
  private readonly cascadeViewUboBytes: readonly Uint8Array[];
  private readonly shadowViewScratch = new Float32Array(16);
  private readonly shadowOrthoScratch = new Float32Array(16);
  private readonly invViewProjScratch = new Float32Array(16);
  private readonly skyboxUboF32 = new Float32Array(28);
  private readonly skyboxUboBytes: Uint8Array;
  private readonly bloomUboF32 = new Float32Array(4);
  private readonly bloomUboBytes: Uint8Array;
  private readonly tonemapUboF32 = new Float32Array(4);
  private readonly tonemapUboBytes: Uint8Array;
  private readonly fxaaUboF32 = new Float32Array(4);
  private readonly fxaaUboBytes: Uint8Array;

  private constructor(
    kernel: RenderKernelExecutionTarget,
    assets: KernelAssetApi,
    options: KernelStandardRendererOptions,
    shaders: {
      readonly postSampler: SamplerId;
      readonly defaultWhiteTexture: TextureId;
      readonly pbr: ShaderProgramId;
      readonly skinnedPbr: ShaderProgramId;
      readonly shadow: ShaderProgramId;
      readonly skinnedShadow: ShaderProgramId;
      readonly uniformPbrOpaque: ShaderProgramId;
      readonly uniformPbrTransparent: ShaderProgramId;
      readonly skybox: ShaderProgramId;
      readonly bloomExtractH: ShaderProgramId;
      readonly bloomBlurV: ShaderProgramId;
      readonly bloomComposite: ShaderProgramId;
      readonly tonemapLdr: ShaderProgramId;
      readonly tonemapOutput: ShaderProgramId;
      readonly fxaaOutput: ShaderProgramId;
      readonly debugLines: ShaderProgramId;
      readonly uiOverlayOutput: ShaderProgramId;
    },
    hdrFormat: GPUTextureFormat,
    outputFormat: GPUTextureFormat,
  ) {
    this.kernel = kernel;
    this.assets = assets;
    this.supportsScene4Bgl = resolveSupportsScene4Bgl(kernel);
    this.shadowMapSize = Math.max(256, options.shadowMapSize ?? 1024);
    this.hdrFormat = hdrFormat;
    this.outputFormat = outputFormat;
    this.headless = options.headless === true;
    this.defaultClearColor = options.defaultClearColor ?? [0.05, 0.06, 0.08, 1];

    this.postSampler = shaders.postSampler;
    this.defaultWhiteTexture = shaders.defaultWhiteTexture;
    this.pbrShader = shaders.pbr;
    this.skinnedPbrShader = shaders.skinnedPbr;
    this.shadowShader = shaders.shadow;
    this.skinnedShadowShader = shaders.skinnedShadow;
    this.uniformPbrOpaqueShader = shaders.uniformPbrOpaque;
    this.uniformPbrTransparentShader = shaders.uniformPbrTransparent;
    this.skyboxShader = shaders.skybox;
    this.bloomExtractHShader = shaders.bloomExtractH;
    this.bloomBlurVShader = shaders.bloomBlurV;
    this.bloomCompositeShader = shaders.bloomComposite;
    this.tonemapLdrShader = shaders.tonemapLdr;
    this.tonemapOutputShader = shaders.tonemapOutput;
    this.fxaaOutputShader = shaders.fxaaOutput;
    this.debugLinesShader = shaders.debugLines;
    this.uiOverlayOutputShader = shaders.uiOverlayOutput;

    this.cascadeViewUboBytes = this.cascadeViewUboF32.map(
      (f) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength),
    );
    this.skyboxUboBytes = new Uint8Array(
      this.skyboxUboF32.buffer,
      this.skyboxUboF32.byteOffset,
      this.skyboxUboF32.byteLength,
    );
    this.bloomUboBytes = new Uint8Array(
      this.bloomUboF32.buffer,
      this.bloomUboF32.byteOffset,
      this.bloomUboF32.byteLength,
    );
    this.tonemapUboBytes = new Uint8Array(
      this.tonemapUboF32.buffer,
      this.tonemapUboF32.byteOffset,
      this.tonemapUboF32.byteLength,
    );
    this.fxaaUboBytes = new Uint8Array(
      this.fxaaUboF32.buffer,
      this.fxaaUboF32.byteOffset,
      this.fxaaUboF32.byteLength,
    );
  }

  static create(
    kernel: RenderKernelExecutionTarget,
    options: KernelStandardRendererOptions = {},
  ): Result<KernelStandardSceneRenderer, KernelError> {
    const assets = kernel.assets as KernelAssetApi | undefined;
    if (assets === undefined) {
      return kernelErr(
        'kernel-capability-unsupported',
        'KernelStandardSceneRenderer.create',
        'RenderKernelExecutionTarget with assets API',
        'pass a NativeRenderKernel, WasmRenderKernel, TsRenderKernel, or WasmWgpuRenderKernel',
      );
    }
    const supports4Bgl = resolveSupportsScene4Bgl(kernel);
    const hdrFormat: GPUTextureFormat =
      options.hdrFormat ?? (supports4Bgl ? 'rgba16float' : 'rgba8unorm');
    const outputFormat: GPUTextureFormat = options.outputFormat ?? 'rgba8unorm';

    const smpRes = assets.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      label: 'standard.post-sampler',
    });
    if (!smpRes.ok) return smpRes;

    const whiteRes = assets.createTexture(
      {
        width: 1,
        height: 1,
        format: TEXTURE_FORMAT_RGBA8_UNORM as TextureFormatCode,
        label: 'standard.default-white',
      },
      new Uint8Array([255, 255, 255, 255]),
    );
    if (!whiteRes.ok) return whiteRes;

    const sceneShaders = registerStandardSceneShaders(assets, supports4Bgl, hdrFormat);
    if (!sceneShaders.ok) return sceneShaders;
    const postShaders = registerStandardPostShaders(assets, hdrFormat, outputFormat);
    if (!postShaders.ok) return postShaders;

    return ok(
      new KernelStandardSceneRenderer(
        kernel,
        assets,
        options,
        {
          postSampler: smpRes.value,
          defaultWhiteTexture: whiteRes.value,
          ...sceneShaders.value,
          ...postShaders.value,
        },
        hdrFormat,
        outputFormat,
      ),
    );
  }

  registerFeature(
    feature: KernelRenderFeature<KernelStandardPipelineFrame>,
  ): Result<void, KernelError> {
    if (this.features.some((f) => f.name === feature.name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelStandardSceneRenderer.registerFeature',
        'unique feature name',
        `feature '${feature.name}' is already registered`,
      );
    }
    this.features.push(feature);
    this.graphCache.invalidate();
    return ok(undefined);
  }

  unregisterFeature(name: string): boolean {
    const idx = this.features.findIndex((f) => f.name === name);
    if (idx < 0) return false;
    this.features.splice(idx, 1);
    this.graphCache.invalidate();
    return true;
  }

  setFeatureEnabled(name: string, enabled: boolean): boolean {
    const idx = this.features.findIndex((f) => f.name === name);
    if (idx < 0) return false;
    const prev = this.features[idx];
    if (prev === undefined) return false;
    this.features[idx] = { ...prev, enabled };
    this.graphCache.invalidate();
    return true;
  }

  listFeatures(): readonly {
    readonly name: string;
    readonly stage: string;
    readonly enabled: boolean;
  }[] {
    return this.features.map((f) => ({
      name: f.name,
      stage: f.stage,
      enabled: f.enabled !== false,
    }));
  }

  ensureMesh(input: KernelStandardMeshInput): Result<MeshId, KernelError> {
    const existing = this.meshes.get(input.key);
    if (existing !== undefined) return ok(existing.meshId);
    const skinned = input.skinned === true;
    const stride = skinned ? 20 : 12;
    const vertexCount = Math.floor(input.vertices.length / stride);
    const indexCount = input.indices?.length ?? 0;
    const isUint32Index = input.indices instanceof Uint32Array;
    const submeshes = (
      input.submeshes && input.submeshes.length > 0
        ? input.submeshes
        : [{ firstIndex: 0, indexCount, baseVertex: 0, firstVertex: 0, vertexCount }]
    ).map((s) => ({
      firstIndex: s.firstIndex ?? 0,
      indexCount: s.indexCount ?? indexCount,
      baseVertex: s.baseVertex ?? 0,
      firstVertex: s.firstVertex ?? 0,
      vertexCount: s.vertexCount ?? vertexCount,
    }));
    const vBytes = new Uint8Array(
      input.vertices.buffer,
      input.vertices.byteOffset,
      input.vertices.byteLength,
    );
    const iBytes =
      input.indices !== undefined
        ? new Uint8Array(input.indices.buffer, input.indices.byteOffset, input.indices.byteLength)
        : undefined;
    const res = this.assets.createMesh(
      {
        vertexLayoutId: skinned ? 2 : 1,
        vertexCount,
        indexCount,
        isUint32Index,
        submeshes,
        ...(input.label === undefined ? {} : { label: input.label }),
      },
      vBytes,
      iBytes,
    );
    if (!res.ok) return res;
    const bounds =
      input.boundsMin !== undefined && input.boundsMax !== undefined
        ? { min: input.boundsMin, max: input.boundsMax }
        : computeInterleavedBounds(input.vertices, stride);
    this.meshes.set(input.key, {
      meshId: res.value,
      skinned,
      indexCount,
      vertexCount,
      isUint32Index,
      submeshes,
      boundsMin: bounds.min,
      boundsMax: bounds.max,
    });
    return res;
  }

  ensureTexture(input: KernelStandardTextureInput): Result<TextureId, KernelError> {
    const existing = this.textures.get(input.key);
    if (existing !== undefined) return ok(existing);
    const res = this.assets.createTexture(
      {
        width: Math.max(1, input.width | 0),
        height: Math.max(1, input.height | 0),
        format: TEXTURE_FORMAT_RGBA8_UNORM as TextureFormatCode,
        ...(input.label === undefined ? {} : { label: input.label }),
      },
      input.rgbaBytes,
    );
    if (!res.ok) return res;
    this.textures.set(input.key, res.value);
    return res;
  }

  registerCustomShader(
    key: KernelResourceKey,
    code: string,
    options?: KernelStandardCustomShaderOptions,
  ): Result<ShaderProgramId, KernelError> {
    const skinned = options?.skinned === true;
    const res = this.assets.registerShaderProgram({
      code,
      vertexEntryPoint: options?.vertexEntryPoint ?? 'vs_main',
      fragmentEntryPoint: options?.fragmentEntryPoint ?? 'fs_main',
      layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
      vertexBufferLayouts: skinned ? KERNEL_VERTEX_LAYOUT_SKINNED : KERNEL_VERTEX_LAYOUT_STANDARD,
      colorFormats: [this.hdrFormat],
      depthFormat: 'depth32float',
      ...(options?.blendMode === undefined ? {} : { blendMode: options.blendMode }),
      label: options?.label ?? `standard.custom.${String(key)}`,
    });
    if (!res.ok) return res;
    this.customShaders.set(key, { shaderId: res.value, skinned });
    return res;
  }

  ensureMaterial(input: KernelStandardMaterialInput): Result<MaterialId, KernelError> {
    const existing = this.materials.get(input.key);
    const params = new Float32Array(MATERIAL_UBO_FLOATS);
    writeMaterialUbo(params, input, input.normalTextureKey !== undefined);
    const paramBytes = new Uint8Array(params.buffer, params.byteOffset, params.byteLength);

    if (existing !== undefined) {
      updateCachedMaterialRecord(existing, input);
      this.assets.updateMaterialParams?.(existing.materialId, paramBytes);
      return ok(existing.materialId);
    }

    const resolved = resolveNewMaterialSetup(
      input,
      this.customShaders,
      this.textures,
      this.pbrShader,
      this.skinnedPbrShader,
    );
    const matIdRes = this.supportsScene4Bgl
      ? this.assets.createMaterial(resolved.desc, paramBytes)
      : ok((this.materials.size + 1) as MaterialId);
    if (!matIdRes.ok) return matIdRes;

    this.materials.set(input.key, {
      materialId: matIdRes.value,
      transparent: resolved.transparent,
      masked: resolved.masked,
      skinned: resolved.skinned,
      queue: resolved.queue,
      baseColor: [input.baseColor[0], input.baseColor[1], input.baseColor[2], input.baseColor[3]],
      emissive: [input.emissive?.[0] ?? 0, input.emissive?.[1] ?? 0, input.emissive?.[2] ?? 0],
      roughness: input.roughness ?? 0.5,
      metallic: input.metallic ?? 0.0,
      baseColorTexId: resolved.baseColorTexId,
    });
    return matIdRes;
  }

  setSkinJoints(slotOffset: number, jointMatrices: Float32Array): Result<void, KernelError> {
    if (this.assets.setSkinJoints === undefined) return ok(undefined);
    return this.assets.setSkinJoints(slotOffset, jointMatrices);
  }

  setUiOverlayRgba(
    width: number,
    height: number,
    rgbaBytes: Uint8Array,
  ): Result<void, KernelError> {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (this.uiDynamicTexId === undefined) {
      const created = this.assets.createDynamicTexture({
        width: w,
        height: h,
        format: TEXTURE_FORMAT_RGBA8_UNORM as TextureFormatCode,
        label: 'standard.ui-overlay',
      });
      if (!created.ok) return created;
      this.uiDynamicTexId = created.value;
    }
    this.uiRevision += 1;
    const up = this.assets.uploadDynamicTexture(
      this.uiDynamicTexId,
      this.uiRevision,
      w,
      h,
      rgbaBytes,
    );
    if (!up.ok) return up;
    if (!this.uiOverlayActive) {
      this.uiOverlayActive = true;
      this.graphCache.invalidate();
    }
    return ok(undefined);
  }

  clearUiOverlay(): void {
    if (this.uiOverlayActive) {
      this.uiOverlayActive = false;
      this.graphCache.invalidate();
    }
  }

  setDebugLines(vertices: Float32Array | null): Result<void, KernelError> {
    if (vertices === null || vertices.length < 7) {
      if (this.debugLineVertexCount > 0) {
        this.debugLineVertexCount = 0;
        this.graphCache.invalidate();
      }
      return ok(undefined);
    }
    const bytes = new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    if (this.debugLineBuffer === undefined || bytes.byteLength > this.debugLineCapacityBytes) {
      if (this.debugLineBuffer !== undefined) this.assets.destroyBuffer(this.debugLineBuffer);
      const cap = Math.max(4096, bytes.byteLength * 2);
      const created = this.assets.createBuffer(
        { size: cap, usage: GPU_USAGE_VERTEX | GPU_USAGE_COPY_DST, label: 'standard.debug-lines' },
        bytes,
      );
      if (!created.ok) return created;
      this.debugLineBuffer = created.value;
      this.debugLineCapacityBytes = cap;
    } else {
      const w = this.assets.writeBuffer(this.debugLineBuffer, 0, bytes);
      if (!w.ok) return w;
    }
    const hadLines = this.debugLineVertexCount > 0;
    this.debugLineVertexCount = Math.floor(vertices.length / 7);
    if (!hadLines && this.debugLineVertexCount > 0) this.graphCache.invalidate();
    return ok(undefined);
  }

  clearDebugLines(): void {
    if (this.debugLineVertexCount > 0) {
      this.debugLineVertexCount = 0;
      this.graphCache.invalidate();
    }
  }

  private computeCascadeShadowMatrices(
    camera: KernelStandardCameraInput,
    light: KernelStandardLightInput,
  ): number {
    const cascadeCount = Math.max(1, Math.min(4, light.cascadeCount ?? 1));
    const dir = light.direction ?? [-0.5, -1.0, -0.3];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const dx = len > 1e-5 ? dir[0] / len : 0;
    const dy = len > 1e-5 ? dir[1] / len : -1;
    const dz = len > 1e-5 ? dir[2] / len : 0;
    const target = light.shadowTarget ?? [0, 0, 0];
    const baseDist = Math.max(2, light.shadowDistance ?? 24);
    const up: readonly [number, number, number] = Math.abs(dy) > 0.95 ? [0, 0, 1] : [0, 1, 0];

    for (let c = 0; c < cascadeCount; c++) {
      const vpOut = this.cascadeVps[c] as Float32Array;
      if (c === 0 && light.shadowViewProj !== undefined) {
        vpOut.set(light.shadowViewProj.subarray(0, 16), 0);
      } else {
        const scale = cascadeCount === 1 ? 1 : (c + 1) / cascadeCount;
        const halfExtent = baseDist * 0.5 * scale;
        const eye: [number, number, number] = [
          target[0] - dx * baseDist,
          target[1] - dy * baseDist,
          target[2] - dz * baseDist,
        ];
        (this.cascadeCamPositions[c] as [number, number, number])[0] = eye[0];
        (this.cascadeCamPositions[c] as [number, number, number])[1] = eye[1];
        (this.cascadeCamPositions[c] as [number, number, number])[2] = eye[2];
        kernelMat4Ortho(
          -halfExtent,
          halfExtent,
          -halfExtent,
          halfExtent,
          0.5,
          baseDist * 2.5,
          this.shadowOrthoScratch,
        );
        kernelMat4LookAt(eye, target, up, this.shadowViewScratch);
        kernelMat4Multiply(this.shadowOrthoScratch, this.shadowViewScratch, vpOut);
      }
      const cUbo = this.cascadeViewUboF32[c] as Float32Array;
      cUbo.set(camera.viewProj, 0);
      cUbo.set(vpOut, 16);
    }
    return cascadeCount;
  }

  private packViewUniforms(
    input: KernelStandardFrameInput,
    shadowLightIdx: number,
    cascadeCount: number,
  ): void {
    const f = this.viewUboF32;
    const u = this.viewUboU32;
    f.fill(0);
    f.set(input.camera.viewProj, 0);
    packCascadeViewUniforms(
      f,
      this.cascadeVps,
      cascadeCount,
      Math.max(2, input.lights[shadowLightIdx]?.shadowDistance ?? 24),
    );
    f[100] = input.camera.position[0];
    f[101] = input.camera.position[1];
    f[102] = input.camera.position[2];
    f[103] = input.camera.exposure ?? 1.0;
    packSkylightAndShadowMetaUniforms(
      f,
      u,
      input,
      shadowLightIdx,
      cascadeCount,
      this.shadowMapSize,
    );
    packFogUniforms(f, input.fog);
  }

  private packPostUniforms(input: KernelStandardFrameInput, width: number, height: number): void {
    if (input.skybox !== undefined) {
      kernelMat4Invert(input.camera.viewProj, this.invViewProjScratch);
      this.skyboxUboF32.set(this.invViewProjScratch, 0);
      this.skyboxUboF32[16] = input.skybox.zenithColor[0];
      this.skyboxUboF32[17] = input.skybox.zenithColor[1];
      this.skyboxUboF32[18] = input.skybox.zenithColor[2];
      this.skyboxUboF32[19] = input.skybox.intensity ?? 1.0;
      this.skyboxUboF32[20] = input.skybox.horizonColor[0];
      this.skyboxUboF32[21] = input.skybox.horizonColor[1];
      this.skyboxUboF32[22] = input.skybox.horizonColor[2];
      this.skyboxUboF32[23] = 0;
      const g = input.skybox.groundColor ?? input.skybox.horizonColor;
      this.skyboxUboF32[24] = g[0];
      this.skyboxUboF32[25] = g[1];
      this.skyboxUboF32[26] = g[2];
      this.skyboxUboF32[27] = 0;
    }
    const bw = Math.max(1, width >> 1);
    const bh = Math.max(1, height >> 1);
    this.bloomUboF32[0] = input.camera.bloom?.threshold ?? 1.0;
    this.bloomUboF32[1] = input.camera.bloom?.intensity ?? 0.65;
    this.bloomUboF32[2] = 1 / bw;
    this.bloomUboF32[3] = 1 / bh;

    this.tonemapUboF32[0] = tonemapModeToCode(input.camera.tonemap);
    this.tonemapUboF32[1] =
      input.camera.vignette?.enabled === true ? (input.camera.vignette.intensity ?? 0.35) : 0;
    this.tonemapUboF32[2] = input.camera.vignette?.smoothness ?? 0.45;
    this.tonemapUboF32[3] = 1.0;

    this.fxaaUboF32[0] = 1 / Math.max(1, width);
    this.fxaaUboF32[1] = 1 / Math.max(1, height);
    this.fxaaUboF32[2] = width;
    this.fxaaUboF32[3] = height;
  }

  private syncSceneDelta(input: KernelStandardFrameInput): Result<
    {
      readonly hasTransparent: boolean;
      readonly skinnedCount: number;
      readonly fallbackDraws: readonly KernelUniformFallbackDraw[];
    },
    KernelError
  > {
    if (!this.supportsScene4Bgl) {
      return ok(collectUniformFallbackDraws(input.objects, this.meshes, this.materials));
    }

    const beginDelta = this.kernel.beginSceneDelta?.bind(this.kernel);
    const commitDelta = this.kernel.commitSceneDelta?.bind(this.kernel);
    if (beginDelta === undefined || commitDelta === undefined) {
      return ok({ hasTransparent: false, skinnedCount: 0, fallbackDraws: [] });
    }

    const idAlloc = { next: this.nextObjectId };
    const diff = diffTrackedSceneObjects(
      input.objects,
      this.meshes,
      this.materials,
      this.trackedObjects,
      idAlloc,
    );
    this.nextObjectId = idAlloc.next;

    const writer: SceneDeltaWriter = beginDelta();
    const prevRevision = this.sceneRevision;
    this.sceneRevision += 1;
    writeSceneDeltaOperations(
      writer,
      this.sceneRevision,
      prevRevision,
      this.baselineCommitted,
      diff,
      encodeSceneLightInputs(input.lights),
    );

    const commitRes = commitDelta(writer);
    if (!commitRes.ok) return commitRes;
    this.baselineCommitted = true;
    return ok({
      hasTransparent: diff.hasTransparent,
      skinnedCount: diff.skinnedCount,
      fallbackDraws: [],
    });
  }

  renderFrame(input: KernelStandardFrameInput): Result<FrameSubmitReceipt, KernelError> {
    if (this.disposed) {
      return kernelErr(
        'kernel-disposed',
        'KernelStandardSceneRenderer.renderFrame',
        'live renderer',
        'renderer has been disposed',
      );
    }
    const width = Math.max(1, input.width | 0);
    const height = Math.max(1, input.height | 0);
    const syncRes = this.syncSceneDelta(input);
    if (!syncRes.ok) return syncRes;

    const shadowLightIdx = input.lights.findIndex(
      (l) => l.kind === 'directional' && l.castShadow === true,
    );
    const hasShadowLight = shadowLightIdx >= 0 && this.supportsScene4Bgl;
    const cascadeCount = hasShadowLight
      ? this.computeCascadeShadowMatrices(
          input.camera,
          input.lights[shadowLightIdx] as KernelStandardLightInput,
        )
      : 1;
    const shadowAtlasDim = cascadeCount > 1 ? this.shadowMapSize * 2 : this.shadowMapSize;

    this.packViewUniforms(input, shadowLightIdx, cascadeCount);
    this.packPostUniforms(input, width, height);

    const { topology, topoKey } = buildStandardTopologyKey(
      input,
      {
        hdrFormat: this.hdrFormat,
        outputFormat: this.outputFormat,
        headless: this.headless,
        supportsScene4Bgl: this.supportsScene4Bgl,
        hasShadowLight,
        shadowAtlasDim,
        hasTransparent: syncRes.value.hasTransparent,
        hasDebugLines: this.debugLineVertexCount > 0 && this.debugLineBuffer !== undefined,
        hasUiOverlay: this.uiOverlayActive && this.uiDynamicTexId !== undefined,
      },
      this.features,
    );

    const graphRes = this.graphCache.getOrCompile(
      createKernelStandardPipeline(topology),
      this.features,
      width,
      height,
      topoKey,
    );
    if (!graphRes.ok) return graphRes;

    const frameId = ++this.framesSubmitted;
    const recRes = this.kernel.beginFrame(frameId, width, height);
    if (!recRes.ok) return recRes;
    const rec = recRes.value;

    const cullsRes = runStandardFrameCulls(
      this.kernel,
      this.supportsScene4Bgl,
      hasShadowLight,
      cascadeCount,
      this.cascadeVps,
      this.cascadeCamPositions,
      input.camera,
    );
    if (!cullsRes.ok) return cullsRes;

    const vSlice = rec.writeUniform(this.viewUboBytes);
    const fallbackLighting = buildFallbackLightingPayload(input);
    const framePayload: KernelStandardPipelineFrame = {
      width,
      height,
      camera: input.camera,
      skybox: input.skybox,
      clearColor: input.camera.clearColor ?? this.defaultClearColor,
      viewUniformOffset: vSlice.offset,
      viewUniformLength: vSlice.length,
      mainCullId: cullsRes.value.mainCullId,
      shadowCullIds: cullsRes.value.shadowCullIds,
      cascadeCount,
      shadowMapSize: this.shadowMapSize,
      hasShadowLight,
      hasTransparent: syncRes.value.hasTransparent,
      skinnedObjectCount: syncRes.value.skinnedCount,
      supportsScene4Bgl: this.supportsScene4Bgl,
      postSampler: this.postSampler,
      shaders: {
        shadow: this.shadowShader,
        skinnedShadow: this.skinnedShadowShader,
        uniformPbrOpaque: this.uniformPbrOpaqueShader,
        uniformPbrTransparent: this.uniformPbrTransparentShader,
        skybox: this.skyboxShader,
        bloomExtractH: this.bloomExtractHShader,
        bloomBlurV: this.bloomBlurVShader,
        bloomComposite: this.bloomCompositeShader,
        tonemapLdr: this.tonemapLdrShader,
        tonemapOutput: this.tonemapOutputShader,
        fxaaOutput: this.fxaaOutputShader,
        debugLines: this.debugLinesShader,
        uiOverlayOutput: this.uiOverlayOutputShader,
      },
      defaultWhiteTexture: this.defaultWhiteTexture,
      uiOverlayTexId: this.uiDynamicTexId,
      uiOverlayActive: this.uiOverlayActive,
      debugLineBuffer: this.debugLineBuffer,
      debugLineVertexCount: this.debugLineVertexCount,
      readbackTicketId: input.readbackTicketId,
      fallbackDraws: syncRes.value.fallbackDraws,
      ...fallbackLighting,
      cascadeViewUboBytes: this.cascadeViewUboBytes,
      skyboxUboBytes: this.skyboxUboBytes,
      bloomUboBytes: this.bloomUboBytes,
      tonemapUboBytes: this.tonemapUboBytes,
      fxaaUboBytes: this.fxaaUboBytes,
      shadowBindSet: 0,
      userData: input.userData,
      recorder: rec,
    };

    graphRes.value.record(rec, framePayload);
    return this.kernel.submitFrame(rec);
  }

  readbackTicket(ticketId: number): Promise<Result<KernelReadbackResult, KernelError>> {
    if (this.kernel.readbackTicket === undefined) {
      return Promise.resolve(
        kernelErr(
          'kernel-capability-unsupported',
          'KernelStandardSceneRenderer.readbackTicket',
          'kernel with readbackTicket support',
          'backend does not expose readbackTicket',
          ticketId,
        ),
      );
    }
    return this.kernel.readbackTicket(ticketId);
  }

  inspectGraph(): CompiledKernelGraphInfo | undefined {
    return this.graphCache.current?.inspect();
  }

  stats(): KernelStandardSceneStats {
    const cacheStats = this.graphCache.stats();
    return {
      supportsScene4Bgl: this.supportsScene4Bgl,
      graphCompilations: cacheStats.compilations,
      graphCacheHits: cacheStats.cacheHits,
      installedFeatureCount: this.features.filter((f) => f.enabled !== false).length,
      objectCount: this.trackedObjects.size,
      meshCount: this.meshes.size,
      materialCount: this.materials.size,
      textureCount: this.textures.size,
      framesSubmitted: this.framesSubmitted,
      sceneRevision: this.sceneRevision,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.meshes.values()) this.assets.destroyMesh(m.meshId);
    for (const t of this.textures.values()) this.assets.destroyTexture(t);
    if (this.supportsScene4Bgl) {
      for (const mat of this.materials.values()) this.assets.destroyMaterial(mat.materialId);
    }
    for (const cs of this.customShaders.values()) this.assets.destroyShaderProgram(cs.shaderId);
    if (this.uiDynamicTexId !== undefined) this.assets.destroyDynamicTexture(this.uiDynamicTexId);
    if (this.debugLineBuffer !== undefined) this.assets.destroyBuffer(this.debugLineBuffer);
    this.assets.destroyTexture(this.defaultWhiteTexture);
    this.assets.destroySampler(this.postSampler);
    this.meshes.clear();
    this.textures.clear();
    this.materials.clear();
    this.customShaders.clear();
    this.trackedObjects.clear();
    this.features.length = 0;
    this.graphCache.invalidate();
  }
}
