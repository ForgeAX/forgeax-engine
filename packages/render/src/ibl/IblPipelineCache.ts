// IblPipelineCache.ts -- DeviceScope-generation cache for IBL precompute.
//
// Plan-strategy D-1/D-7: cache for 4 GPU passes (equirect->cube /
// irradiance / prefilter / BRDF LUT). M2 provides the cache skeleton;
// M3 (t18/t20) wires real shader math from ibl.wgsl.
//
// The cache is keyed by the renderer-owned DeviceScope generation. Raw device
// handles are inputs to pipeline creation, never cache or lifecycle owners.
//
// Public surface (M3):
//   - getOrCreateIblCache(scope): get or initialize the generation cache
//   - iblCacheSize(): introspection hook
//   - hasIblCache(scope): introspection hook
//   - setIblWgslSource(source): set the ibl.wgsl WGSL source string
//   - createIblShaderModules(device, factory): create shader modules from ibl.wgsl
//   - createIblPipelines(scope, device, factory, modules): create 4 render pipelines
//   - runIblPrecompute(opts): execute 4 GPU precompute passes (M3 t20)
//
// M3 t20: pipeline slots are filled with real render pipelines loaded from
// ibl.wgsl, replacing the M2 stub undefined slots. The 4 GPU passes are
// executed in the standard order (equirect->cube -> irradiance -> prefilter
// -> BRDF LUT), with counters set post-execution per AC-04/05/06.

// ─── RHI-owned handles ───────────────────────────────────────────────────────

import { mat4 } from '@forgeax/engine-math';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  type Buffer,
  err,
  ok,
  type RenderPipeline,
  type Result,
  type RhiCommandEncoder,
  type RhiDevice,
  type RhiError,
  type RhiRenderPassEncoder,
  type Sampler,
  type ShaderModule,
  type Texture,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import { createIblKernelCache, type IblKernelCache } from './kernel-cache';

export {
  createIblKernelCache,
  type IblKernelCache,
  resetIblKernelCaches,
} from './kernel-cache';

import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from '../gpu-texture-usage';

/**
 * Shader module factory (async, injected via configureGpuDevice).
 * Mirrors `MipmapShaderModuleFactory` from mipmap-generator.
 */
/**
 * IBL is assembled by the renderer's device owner, so it consumes the full
 * opaque RHI device rather than a structurally-compatible raw/shim split.
 * Keeping the owner as RhiDevice makes the backend boundary explicit: raw
 * GPU handles can only exist inside an RHI implementation or a test readback.
 */
export type IblRhiOwner = RhiDevice;

export type IblShaderModuleFactory = (
  device: IblRhiOwner,
  desc: { code: string; label?: string },
) => Promise<Result<ShaderModule, RhiError>>;

export interface IblPipelineSet {
  readonly equirectToCubePipeline: RenderPipeline;
  readonly irradiancePipeline: RenderPipeline;
  readonly prefilterPipeline: RenderPipeline;
  readonly brdfLutPipeline: RenderPipeline;
}

export interface IblPipelineError {
  readonly code: 'ibl-pipeline-create-failed' | 'ibl-shader-module-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly stage: string; readonly rhiCode?: RhiError['code'] };
}

/**
 * Per-DeviceScope-generation IBL pipeline cache instance.
 *
 * M3.5 (round-2 t52): the 4 pipeline slots are mutable so createIblPipelines
 * can fill them after construction. The output textures and views are
 * promoted here only after a completed precompute submission.
 */
export interface IblPipelineCache {
  /** Reusable generation-scoped kernel state; per-probe outputs stay elsewhere. */
  readonly probeKernel: IblKernelCache;
  /** Color format shared by all precompute outputs for this device. */
  outputFormat?: TextureFormat;
  /** Equirectangular-to-cubemap pipeline. */
  equirectToCubePipeline?: RenderPipeline;
  /** Diffuse irradiance convolution pipeline. */
  irradiancePipeline?: RenderPipeline;
  /** Specular prefilter pipeline. */
  prefilterPipeline?: RenderPipeline;
  /** BRDF integration LUT pipeline. */
  brdfLutPipeline?: RenderPipeline;

  /** Face uniforms BGL (shared across equirect/irradiance/prefilter, D-9). */
  faceUniformsBgl?: BindGroupLayout;
  /** group(1) BGL for the equirect-to-cube pass (texture_2d + sampler). */
  equirectGroup1Bgl?: BindGroupLayout;
  /** group(1) BGL for irradiance + prefilter (texture_cube + sampler). */
  cubeGroup1Bgl?: BindGroupLayout;
  /** group(0) BGL for prefilter (face + prefilter uniforms). */
  prefilterGroup0Bgl?: BindGroupLayout;

  /** Irradiance cubemap texture (32x32; outputFormat, cube). */
  irradianceTexture?: Texture;
  /** Irradiance cubemap view (dimension:cube). */
  irradianceView?: TextureView;
  /** Per-face 2D views for irradiance (render-attachment use). */
  irradianceFaceViews?: ReadonlyArray<TextureView>;
  /** Specular prefilter cubemap (128x128, 5 mip levels). */
  prefilterTexture?: Texture;
  /** Prefilter cubemap view (dimension:cube, all mips). */
  prefilterView?: TextureView;
  /** Per-face 2D views per mip for prefilter (5 mips x 6 faces). */
  prefilterFaceViewsByMip?: ReadonlyArray<ReadonlyArray<TextureView>>;
  /** BRDF LUT (256x256; outputFormat). */
  brdfLutTexture?: Texture;
  /** BRDF LUT view. */
  brdfLutView?: TextureView;

  /** Counter: times irradiance pass has executed. AC-04: == 1 after first cook. */
  irradianceBakeCount: number;
  /** Counter: times prefilter pass has executed. AC-05: == 1 after first cook. */
  prefilterBakeCount: number;
  /** Counter: times BRDF LUT pass has executed. AC-06: == 1 after first cook. */
  brdfLutBakeCount: number;
}

/**
 * Cache ownership follows the renderer's DeviceScope generation. A cache is
 * never recovered by looking up an opaque device handle, so every pipeline and
 * side texture is born under the same lifecycle owner as the rest of the
 * renderer resources.
 */
const scopeCaches: WeakMap<DeviceScope, IblPipelineCache> = new WeakMap();

/**
 * Get or create the current-generation IBL pipeline cache.
 */
export function getOrCreateIblCache(scope: DeviceScope): IblPipelineCache {
  const existing = scopeCaches.get(scope);
  if (existing !== undefined) return existing;

  const cache: IblPipelineCache = {
    probeKernel: createIblKernelCache(scope.generation),
    irradianceBakeCount: 0,
    prefilterBakeCount: 0,
    brdfLutBakeCount: 0,
  };
  scopeCaches.set(scope, cache);
  return cache;
}

/**
 * Check whether a DeviceScope generation has an active cache entry.
 */
export function hasIblCache(scope: DeviceScope): boolean {
  return scopeCaches.has(scope);
}

// ─── M3.5 composed ibl-* shader source registry ─────────────────────────────
//
// 4 composed WGSL strings -- one per render pipeline. Each string is the
// output of @forgeax/engine-naga composeShader after merging ibl_shared +
// the per-pass module. Built by ShaderCatalog / vite-plugin-shader at
// build-time so the runtime cache never reaches into engine-naga
// (AGENTS.md grep gate forbids).

export interface IblComposedShaders {
  /** ibl-equirect-to-cube composed (cubemap_vs + equirectToCube_fs). */
  readonly equirectToCube: string;
  /** ibl-irradiance composed (cubemap_vs + irradianceConvolve_fs). */
  readonly irradiance: string;
  /** ibl-prefilter composed (cubemap_vs + prefilterEnv_fs). */
  readonly prefilter: string;
  /** ibl-brdf-lut composed (fullscreen_vs + brdfLutBake_fs). */
  readonly brdfLut: string;
  readonly probeBackground?: string;
}

let iblComposedShadersCache: IblComposedShaders | undefined;

export function getIblProbeBackgroundSource(): string | undefined {
  return iblComposedShadersCache?.probeBackground;
}

/**
 * Inject the composed ibl-* shader sources used by createIblPipelines.
 * Called once by the engine bootstrap (createRenderer step "shader-load")
 * with the 4 composed entries from ShaderCatalog.
 */
export function setIblComposedShaders(sources: IblComposedShaders): void {
  iblComposedShadersCache = sources;
}

// ─── Standard cube vertices for cubemap face rendering ───────────────────────
// 36 vertices (6 faces * 2 triangles * 3 vertices), vec3<f32> format.
// Unit cube [-1, 1]^3 centered at origin.
export const CUBEMAP_FACE_VERTICES = new Float32Array([
  // +X face (+1, 0, 0)
  1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0,
  // -X face (-1, 0, 0)
  -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0,
  1.0,
  // +Y face (0, +1, 0)
  -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0,
  // -Y face (0, -1, 0)
  -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0,
  1.0,
  // +Z face (0, 0, +1)
  -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0,
  // -Z face (0, 0, -1)
  1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0,
  -1.0,
]);

// 6 capture view-projection matrices (right-handed, from origin).
// Projection Y is negated for WebGPU top-left framebuffer origin.
// Target directions: +X, -X, +Y, -Y, +Z, -Z.
// Up vectors: -Y for X/Z faces, +Z for +Y, -Z for -Y.
export const CAPTURE_VIEW_PROJS = buildCaptureViewProjs();

function buildCaptureViewProjs(): Float32Array[] {
  const targets: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const ups: [number, number, number][] = [
    [0, -1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [0, -1, 0],
  ];

  const proj = cubemapCaptureProjection(Math.PI / 2, 0.1, 10.0);

  return targets.map((_t, i) => {
    const t = _t;
    const u = ups[i] ?? [0, -1, 0];
    const view = lookAtMatrix([0, 0, 0], t, u);
    return mulMat4(proj, view);
  });
}

function cubemapCaptureProjection(fovy: number, near: number, far: number): Float32Array {
  const projection = mat4.perspectiveReverseZ(mat4.create(), fovy, 1, near, far);
  projection[5] = -(projection[5] ?? 0);
  return projection;
}

function lookAtMatrix(
  eye: readonly number[],
  target: readonly number[],
  up: readonly number[],
): Float32Array {
  const [ex, ey0, ez] = [eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0];
  const [tx, ty, tz] = [target[0] ?? 0, target[1] ?? 0, target[2] ?? 0];
  const [upx, upy, upz] = [up[0] ?? 0, up[1] ?? 0, up[2] ?? 0];
  let fx = ex - tx,
    fy = ey0 - ty,
    fz = ez - tz;
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= fLen;
  fy /= fLen;
  fz /= fLen;

  let rx = upy * fz - upz * fy;
  let ry = upz * fx - upx * fz;
  let rz = upx * fy - upy * fx;
  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= rLen;
  ry /= rLen;
  rz /= rLen;

  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  return new Float32Array([
    rx,
    ux,
    fx,
    0,
    ry,
    uy,
    fy,
    0,
    rz,
    uz,
    fz,
    0,
    -(rx * ex + ry * ey0 + rz * ez),
    -(ux * ex + uy * ey0 + uz * ez),
    -(fx * ex + fy * ey0 + fz * ez),
    1,
  ]);
}

// Column-major matrix product `r = a * b` where each Float32Array stores
// 4 contiguous column vectors of 4 floats (WGSL `mat4x4<f32>` uniform
// layout). For column-major storage `flat[c*4 + row] = M[col=c, row]`, so:
//   (a * b)[col=c, row=r] = sum_k a[col=k, row=r] * b[col=c, row=k]
//   flat_out[c*4 + r]     = sum_k a[k*4 + r] * b[c*4 + k]
//
// The prior row-major iteration silently transposed the result, producing
// `b * a` in WGSL's view -- IBL equirect-to-cube vertices then projected
// to clip with w=0 / w=-1, every face fell outside the [-1,1] frustum, no
// fragments drew, and every downstream IBL texture (irradiance / prefilter)
// inherited the clearValue=(0,0,0,1). Demo 3x3 sphere matrix rendered
// pure black because `ambient = kD * 0 + specular * 0 = 0` and there are
// no direct lights in the IBL demo scene.
function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] ?? 0) * (b[c * 4 + k] ?? 0);
      }
      r[c * 4 + row] = sum;
    }
  }
  return r;
}

// ─── M3.5 t52: createIblPipelines (4 independent GPURenderPipelines) ─────────

// IBL output texture sizes (plan D-10 SSOT, mirrored in ibl-brdf-lut.wgsl).
export const IRRADIANCE_SIZE = 32;
export const PREFILTER_SIZE = 128;
export const PREFILTER_MIP_LEVELS = 5;
export const BRDF_LUT_SIZE = 256;

/** Face (mat4x4f) and prefilter (vec4f) uniforms each own one dynamic-offset-aligned slot. */
export const IBL_UNIFORM_SLOT_STRIDE = 256;
const FACE_UNIFORM_BYTES = 64;
const PREFILTER_UNIFORM_BYTES = 16;

export function prefilterSubpassIndex(mip: number, face: number): number {
  return mip * 6 + face;
}

export function iblFaceUniformEntry(buffer: Buffer, face: number): BindGroupEntry {
  return {
    binding: 0,
    resource: {
      kind: 'buffer',
      value: { buffer, offset: face * IBL_UNIFORM_SLOT_STRIDE, size: FACE_UNIFORM_BYTES },
    },
  };
}

export function iblPrefilterGroup0Entries(
  faceUniforms: Buffer,
  prefilterUniforms: Buffer,
  mip: number,
  face: number,
): BindGroupEntry[] {
  return [
    iblFaceUniformEntry(faceUniforms, face),
    {
      binding: 1,
      resource: {
        kind: 'buffer',
        value: {
          buffer: prefilterUniforms,
          offset: prefilterSubpassIndex(mip, face) * IBL_UNIFORM_SLOT_STRIDE,
          size: PREFILTER_UNIFORM_BYTES,
        },
      },
    },
  ];
}

/**
 * Create 4 independent GPURenderPipelines + their shared / per-pass bind
 * group layouts. Pipeline slots are stored on the per-device cache and
 * survive across calls (D-1 startup-once cook).
 *
 * D-9: faceUniforms BGL (@group(0) for equirect/irradiance/prefilter) is
 * a single instance reused across 3 pipelines (binary-compatible).
 * group(1) is per-pipeline: texture_2d for equirect, texture_cube for
 * irradiance + prefilter, none for brdf-lut.
 */
export async function createIblPipelines(
  scope: DeviceScope,
  device: IblRhiOwner,
  factory: IblShaderModuleFactory,
  cubeOutputFormat: TextureFormat = 'rgba16float',
): Promise<Result<IblPipelineSet, RhiError | IblPipelineError>> {
  const cache = getOrCreateIblCache(scope);
  if (
    cache.equirectToCubePipeline !== undefined &&
    cache.irradiancePipeline !== undefined &&
    cache.prefilterPipeline !== undefined &&
    cache.brdfLutPipeline !== undefined
  ) {
    return ok({
      equirectToCubePipeline: cache.equirectToCubePipeline,
      irradiancePipeline: cache.irradiancePipeline,
      prefilterPipeline: cache.prefilterPipeline,
      brdfLutPipeline: cache.brdfLutPipeline,
    });
  }
  // Keep the output format on the per-device cache so the four pipelines and
  // their lazily-created side textures cannot drift. WebGL2 may need the
  // renderable rgba8 fallback even when the source equirect remains float.
  const outputFormat = cubeOutputFormat;
  cache.outputFormat = outputFormat;

  const composed = iblComposedShadersCache;
  // Mock-device path: factory returns synthetic modules. Both production
  // (composed) and unit-test (placeholder code) paths converge here.
  const fallbackCode = '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';
  const src = composed ?? {
    equirectToCube: fallbackCode,
    irradiance: fallbackCode,
    prefilter: fallbackCode,
    brdfLut: fallbackCode,
  };

  const modules = await Promise.all([
    factory(device, { code: src.equirectToCube, label: 'ibl-equirect-to-cube' }),
    factory(device, { code: src.irradiance, label: 'ibl-irradiance' }),
    factory(device, { code: src.prefilter, label: 'ibl-prefilter' }),
    factory(device, { code: src.brdfLut, label: 'ibl-brdf-lut' }),
  ]);
  for (const m of modules) {
    if (!m.ok) return err(m.error);
  }
  const shaderModules = modules.flatMap((module) => (module.ok ? [module.value] : []));
  if (shaderModules.length !== 4) {
    return err(iblPipelineError('shader-modules', 'ibl-shader-module-missing'));
  }
  const [mEq, mIr, mPr, mBr] = shaderModules;
  if (mEq === undefined || mIr === undefined || mPr === undefined || mBr === undefined) {
    return err(iblPipelineError('shader-modules', 'ibl-shader-module-missing'));
  }

  // D-9: faceUniforms BGL shared across 3 pipelines (equirect / irradiance /
  // prefilter). The prefilter additionally needs binding(1) for prefUniforms;
  // we keep a separate BGL for the prefilter group(0) to honour the WGSL
  // declaration in ibl-prefilter.wgsl.
  const faceBgl = device.createBindGroupLayout({
    label: 'ibl-face-uniforms-bgl',
    entries: [{ binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } }],
  });
  if (!faceBgl.ok) return err(faceBgl.error);
  cache.faceUniformsBgl = faceBgl.value;

  const prefilterGroup0 = device.createBindGroupLayout({
    label: 'ibl-prefilter-group0-bgl',
    entries: [
      { binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  if (!prefilterGroup0.ok) return err(prefilterGroup0.error);
  cache.prefilterGroup0Bgl = prefilterGroup0.value;

  const equirectGroup1 = device.createBindGroupLayout({
    label: 'ibl-equirect-group1-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ],
  });
  if (!equirectGroup1.ok) return err(equirectGroup1.error);
  cache.equirectGroup1Bgl = equirectGroup1.value;

  const cubeGroup1 = device.createBindGroupLayout({
    label: 'ibl-cube-group1-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: 'cube' },
      },
      {
        binding: 1,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ],
  });
  if (!cubeGroup1.ok) return err(cubeGroup1.error);
  cache.cubeGroup1Bgl = cubeGroup1.value;

  // Pipeline layouts.
  const equirectLayout = device.createPipelineLayout({
    label: 'ibl-equirect-pipeline-layout',
    bindGroupLayouts: [faceBgl.value, equirectGroup1.value],
  });
  if (!equirectLayout.ok) return err(equirectLayout.error);
  const irradianceLayout = device.createPipelineLayout({
    label: 'ibl-irradiance-pipeline-layout',
    bindGroupLayouts: [faceBgl.value, cubeGroup1.value],
  });
  if (!irradianceLayout.ok) return err(irradianceLayout.error);
  const prefilterLayout = device.createPipelineLayout({
    label: 'ibl-prefilter-pipeline-layout',
    bindGroupLayouts: [prefilterGroup0.value, cubeGroup1.value],
  });
  if (!prefilterLayout.ok) return err(prefilterLayout.error);
  const brdfLutLayout = device.createPipelineLayout({
    label: 'ibl-brdf-lut-pipeline-layout',
    bindGroupLayouts: [],
  });
  if (!brdfLutLayout.ok) return err(brdfLutLayout.error);

  const vertexLayout3F = {
    arrayStride: 12,
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as const }],
  };

  const pipeEquirect = device.createRenderPipeline({
    label: 'ibl-equirect-to-cube-pipeline',
    layout: equirectLayout.value,
    vertex: { module: mEq, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
    fragment: {
      module: mEq,
      entryPoint: 'equirectToCube_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeEquirect.ok) return err(pipeEquirect.error);
  cache.equirectToCubePipeline = pipeEquirect.value;

  const pipeIrradiance = device.createRenderPipeline({
    label: 'ibl-irradiance-pipeline',
    layout: irradianceLayout.value,
    vertex: { module: mIr, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
    fragment: {
      module: mIr,
      entryPoint: 'irradianceConvolve_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeIrradiance.ok) return err(pipeIrradiance.error);
  cache.irradiancePipeline = pipeIrradiance.value;

  const pipePrefilter = device.createRenderPipeline({
    label: 'ibl-prefilter-pipeline',
    layout: prefilterLayout.value,
    vertex: { module: mPr, entryPoint: 'cubemap_vs', buffers: [vertexLayout3F] },
    fragment: {
      module: mPr,
      entryPoint: 'prefilterEnv_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipePrefilter.ok) return err(pipePrefilter.error);
  cache.prefilterPipeline = pipePrefilter.value;

  const pipeBrdfLut = device.createRenderPipeline({
    label: 'ibl-brdf-lut-pipeline',
    layout: brdfLutLayout.value,
    vertex: { module: mBr, entryPoint: 'fullscreen_vs', buffers: [] },
    fragment: {
      module: mBr,
      entryPoint: 'brdfLutBake_fs',
      targets: [{ format: cubeOutputFormat }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeBrdfLut.ok) return err(pipeBrdfLut.error);
  cache.brdfLutPipeline = pipeBrdfLut.value;

  return ok({
    equirectToCubePipeline: pipeEquirect.value,
    irradiancePipeline: pipeIrradiance.value,
    prefilterPipeline: pipePrefilter.value,
    brdfLutPipeline: pipeBrdfLut.value,
  });
}

function iblPipelineError(
  stage: string,
  code: IblPipelineError['code'],
  cause?: RhiError,
): IblPipelineError {
  return {
    code,
    expected: `${stage} completed through the RHI Result contract`,
    hint: `inspect the ${stage} RHI error before retrying IBL pipeline creation`,
    detail: { stage, ...(cause === undefined ? {} : { rhiCode: cause.code }) },
  };
}

// ─── M3.5 t53: runIblPrecompute (4-pass dispatch + queue.submit) ─────────────

/**
 * Options consumed by runIblPrecompute. The caller (the internal
 * GpuResidencyCache equirect-to-cubemap projection) provides the equirect input
 * + cubemap target GPU resources; the face-uniform / prefilter-uniform buffers
 * come from the t55 helpers.
 */
export interface RunIblPrecomputeOptions {
  readonly scope: DeviceScope;
  readonly device: IblRhiOwner;
  readonly equirectGpuTex: Texture;
  readonly equirectView: TextureView;
  readonly cubeGpuTex: Texture;
  readonly cubeView: TextureView;
  readonly cubeFaceViews: ReadonlyArray<TextureView>;
  readonly faceUniformsBuffer: Buffer;
  readonly prefilterUniformsBuffer: Buffer;
  readonly cubeVertexBuffer: Buffer;
}

interface IblPrecomputeCandidate {
  irradianceTexture: Texture;
  irradianceView: TextureView;
  irradianceFaceViews: ReadonlyArray<TextureView>;
  prefilterTexture: Texture;
  prefilterView: TextureView;
  prefilterFaceViewsByMip: ReadonlyArray<ReadonlyArray<TextureView>>;
  brdfLutTexture: Texture;
  brdfLutView: TextureView;
}

export interface IblPrecomputeError {
  readonly code: 'ibl-precompute-not-dispatched';
  readonly expected: string;
  readonly hint: string;
  readonly detail?: { readonly stage: string; readonly rhiCode?: RhiError['code'] };
}

function yieldToRenderOpportunity(): Promise<void> {
  return new Promise((resolve) => {
    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame !== 'function') {
      globalThis.setTimeout(resolve, 0);
      return;
    }

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      resolve();
    };
    timeout = globalThis.setTimeout(finish, 50);
    try {
      requestFrame.call(globalThis, finish);
    } catch {
      // DedicatedWorkerGlobalScope can expose requestAnimationFrame while its
      // implementation rejects calls. Preserve the event-loop yield there.
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      timeout = globalThis.setTimeout(finish, 0);
    }
  });
}

/**
 * Execute the 4 IBL precompute passes (equirect-to-cube / irradiance /
 * prefilter / brdf-lut) as ordered, stage-bounded submissions. Outputs stay
 * candidate-local until the final queue completion fence and generation check
 * pass. Each existing bounded stage retains its submission on the ordered queue.
 *
 * Counter invariant (AC-20, plan D-7 / N-3): the
 * `irradiance/prefilter/brdfLut BakeCount` counters are incremented
 * AFTER queue.submit returns. If submit throws or returns Result.err, the
 * counters stay at 0 -- this is the prime safety guard against the
 * round-1 "counter += 1 as dispatch proxy" anti-pattern.
 *
 * Returns Result.err with code='ibl-precompute-not-dispatched' when the
 * underlying device lacks queue.submit or one of the 4 pipelines was not
 * created (createIblPipelines must run first).
 */
export async function runIblPrecompute(
  opts: RunIblPrecomputeOptions,
): Promise<Result<{ submitted: boolean }, IblPrecomputeError>> {
  const { device, scope } = opts;
  if (!scope.isAlive()) return err(badAlloc('device-scope-generation'));
  const cache = getOrCreateIblCache(scope);
  const outputFormat = cache.outputFormat ?? 'rgba16float';
  const generation = scope.generation;
  const candidate: Partial<IblPrecomputeCandidate> = {};
  const fail = (stage: string, cause?: RhiError): Promise<Result<never, IblPrecomputeError>> => {
    // Candidate textures are adopted by the DeviceScope immediately after
    // allocation, so every failure is retired with the owning generation.
    return Promise.resolve(err(badAlloc(stage, cause)));
  };

  if (
    cache.equirectToCubePipeline === undefined ||
    cache.irradiancePipeline === undefined ||
    cache.prefilterPipeline === undefined ||
    cache.brdfLutPipeline === undefined
  ) {
    return err({
      code: 'ibl-precompute-not-dispatched',
      expected: '4 IBL pipelines created via createIblPipelines',
      hint: 'check IblPipelineCache.createIblPipelines was called before runIblPrecompute; counters must not increment before queue.submit',
      detail: { stage: 'pipeline-cache' },
    });
  }

  // Allocate side textures (irradiance / prefilter / brdf-lut) lazily.
  // M5-amend Bug 1: dawn readback (t51 + reference baker) copies the
  // side textures back to a buffer via copyTextureToBuffer, which
  // requires the TextureUsage::CopySrc bit on the source. Without it
  // Dawn fails-fast "usage doesn't include CopySrc".

  {
    const textureResult = device.createTexture({
      label: 'ibl-irradiance-cube',
      size: { width: IRRADIANCE_SIZE, height: IRRADIANCE_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) return fail('irradiance-texture', textureResult.error);
    candidate.irradianceTexture = adoptIblTexture(scope, device, textureResult.value);
    const cubeViewResult = device.createTextureView(textureResult.value, {
      label: 'ibl-irradiance-cube-view',
      dimension: 'cube',
      arrayLayerCount: 6,
    });
    if (!cubeViewResult.ok) return fail('irradiance-view', cubeViewResult.error);
    candidate.irradianceView = cubeViewResult.value;
    const faceViews: TextureView[] = [];
    for (let f = 0; f < 6; f++) {
      const viewResult = device.createTextureView(textureResult.value, {
        label: `ibl-irradiance-face-${f}`,
        dimension: '2d',
        baseArrayLayer: f,
        arrayLayerCount: 1,
      });
      if (!viewResult.ok) return fail('irradiance-face-view', viewResult.error);
      faceViews.push(viewResult.value);
    }
    candidate.irradianceFaceViews = faceViews;
  }

  {
    const textureResult = device.createTexture({
      label: 'ibl-prefilter-cube',
      size: { width: PREFILTER_SIZE, height: PREFILTER_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: PREFILTER_MIP_LEVELS,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) return fail('prefilter-texture', textureResult.error);
    candidate.prefilterTexture = adoptIblTexture(scope, device, textureResult.value);
    const cubeViewResult = device.createTextureView(textureResult.value, {
      label: 'ibl-prefilter-cube-view',
      dimension: 'cube',
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: PREFILTER_MIP_LEVELS,
    });
    if (!cubeViewResult.ok) return fail('prefilter-view', cubeViewResult.error);
    candidate.prefilterView = cubeViewResult.value;
    const mipViews: TextureView[][] = [];
    for (let m = 0; m < PREFILTER_MIP_LEVELS; m++) {
      const faces: TextureView[] = [];
      for (let f = 0; f < 6; f++) {
        const viewResult = device.createTextureView(textureResult.value, {
          label: `ibl-prefilter-mip${m}-face${f}`,
          dimension: '2d',
          baseMipLevel: m,
          mipLevelCount: 1,
          baseArrayLayer: f,
          arrayLayerCount: 1,
        });
        if (!viewResult.ok) return fail('prefilter-face-view', viewResult.error);
        faces.push(viewResult.value);
      }
      mipViews.push(faces);
    }
    candidate.prefilterFaceViewsByMip = mipViews;
  }

  {
    const textureResult = device.createTexture({
      label: 'ibl-brdf-lut',
      size: { width: BRDF_LUT_SIZE, height: BRDF_LUT_SIZE, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) return fail('brdf-lut-texture', textureResult.error);
    candidate.brdfLutTexture = adoptIblTexture(scope, device, textureResult.value);
    const viewResult = device.createTextureView(textureResult.value, {
      label: 'ibl-brdf-lut-view',
      dimension: '2d',
    });
    if (!viewResult.ok) return fail('brdf-lut-view', viewResult.error);
    candidate.brdfLutView = viewResult.value;
  }

  // Shared sampler (filtering, linear-linear).
  // U=repeat because equirect wraps horizontally (atan2 seam at ±π);
  // V=clamp because equirect poles are clamped vertically.
  const samplerResult = device.createSampler({
    label: 'ibl-precompute-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!samplerResult.ok) return fail('sampler', samplerResult.error);
  const sampler: Sampler = samplerResult.value;

  let encoderResult = device.createCommandEncoder({
    label: 'ibl-precompute-encoder-equirect-to-cube',
  });
  if (!encoderResult.ok) return fail('encoder-equirect-to-cube', encoderResult.error);
  let encoder: RhiCommandEncoder = encoderResult.value;

  const submitStage = async (stage: string, createNextEncoder: boolean) => {
    if (!scope.isAlive() || scope.generation !== generation) {
      return err(badAlloc(`${stage}-device-scope-generation`));
    }
    const finishRes = encoder.finish();
    if (!finishRes.ok) return err(badAlloc(`${stage}-finish`, finishRes.error));
    const submitRes = device.queue.submit([finishRes.value]);
    if (!submitRes.ok) return err(badAlloc(`${stage}-submit`, submitRes.error));
    // Immutable face/mip uniform slots and same-queue order preserve every
    // dependency. Fence only the final submission before promoting outputs;
    // avoid a CPU/GPU roundtrip for every face-sized submission.
    if (!createNextEncoder) {
      try {
        await device.queue.onSubmittedWorkDone();
      } catch {
        return err(badAlloc(`${stage}-fence`));
      }
    }
    if (!scope.isAlive() || scope.generation !== generation) {
      return err(badAlloc(`${stage}-device-scope-generation`));
    }
    if (createNextEncoder) {
      encoderResult = device.createCommandEncoder({ label: `ibl-precompute-encoder-${stage}` });
      if (!encoderResult.ok) return err(badAlloc(`${stage}-next-encoder`, encoderResult.error));
      encoder = encoderResult.value;
    }
    return ok(true);
  };

  const yieldBetweenBatches = async (stage: string) => {
    await yieldToRenderOpportunity();
    if (!scope.isAlive() || scope.generation !== generation) {
      return err(badAlloc(`${stage}-device-scope-generation`));
    }
    return ok(true);
  };

  const faceUniformsBgl = cache.faceUniformsBgl;
  const equirectGroup1Bgl = cache.equirectGroup1Bgl;
  const cubeGroup1Bgl = cache.cubeGroup1Bgl;
  const prefilterGroup0Bgl = cache.prefilterGroup0Bgl;
  const equirectPipeline = cache.equirectToCubePipeline;
  const irradiancePipeline = cache.irradiancePipeline;
  const prefilterPipeline = cache.prefilterPipeline;
  const brdfLutPipeline = cache.brdfLutPipeline;
  const candidateIrradianceTexture = candidate.irradianceTexture;
  const candidateIrradianceView = candidate.irradianceView;
  const irrFaceViews = candidate.irradianceFaceViews;
  const candidatePrefilterTexture = candidate.prefilterTexture;
  const candidatePrefilterView = candidate.prefilterView;
  const prefMipViews = candidate.prefilterFaceViewsByMip;
  const candidateBrdfLutTexture = candidate.brdfLutTexture;
  const brdfLutView = candidate.brdfLutView;
  if (
    faceUniformsBgl === undefined ||
    equirectGroup1Bgl === undefined ||
    cubeGroup1Bgl === undefined ||
    prefilterGroup0Bgl === undefined ||
    equirectPipeline === undefined ||
    irradiancePipeline === undefined ||
    prefilterPipeline === undefined ||
    brdfLutPipeline === undefined ||
    candidateIrradianceTexture === undefined ||
    candidateIrradianceView === undefined ||
    irrFaceViews === undefined ||
    candidatePrefilterTexture === undefined ||
    candidatePrefilterView === undefined ||
    prefMipViews === undefined ||
    candidateBrdfLutTexture === undefined ||
    brdfLutView === undefined
  ) {
    return fail('ibl-cache-resources');
  }

  // Bind group: equirect group(1).
  const equirectBgResult = device.createBindGroup({
    label: 'ibl-equirect-bg',
    layout: equirectGroup1Bgl,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: opts.equirectView } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
    ],
  });
  if (!equirectBgResult.ok) return fail('equirect-bg', equirectBgResult.error);
  const equirectBg: BindGroup = equirectBgResult.value;

  // Bind group: cube group(1) for irradiance + prefilter.
  const cubeBgResult = device.createBindGroup({
    label: 'ibl-cube-bg',
    layout: cubeGroup1Bgl,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: opts.cubeView } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
    ],
  });
  if (!cubeBgResult.ok) return fail('cube-bg', cubeBgResult.error);
  const cubeBg: BindGroup = cubeBgResult.value;

  // (a) equirect-to-cube: 6 face draws.
  const cubeFaceViews = opts.cubeFaceViews;
  for (let face = 0; face < 6; face++) {
    const cubeFaceView = cubeFaceViews[face];
    if (cubeFaceView === undefined) return fail('cube-face-view');
    const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
      label: 'ibl-equirect-to-cube',
      colorAttachments: [
        {
          view: cubeFaceView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    const faceBgResult = device.createBindGroup({
      label: `ibl-face-bg-${face}`,
      layout: faceUniformsBgl,
      entries: [iblFaceUniformEntry(opts.faceUniformsBuffer, face)],
    });
    if (!faceBgResult.ok) return fail('face-bg', faceBgResult.error);
    pass.setPipeline(equirectPipeline);
    pass.setBindGroup(0, faceBgResult.value);
    pass.setBindGroup(1, equirectBg);
    pass.setVertexBuffer(0, opts.cubeVertexBuffer);
    pass.draw(6, 1, face * 6, 0);
    pass.end();
  }

  const cubeStage = await submitStage('equirect-to-cube', true);
  if (!cubeStage.ok) return err(cubeStage.error);
  const cubeOpportunity = await yieldBetweenBatches('equirect-to-cube');
  if (!cubeOpportunity.ok) return err(cubeOpportunity.error);

  // (b) irradiance convolve: 6 face draws.
  for (let face = 0; face < 6; face++) {
    const irrFaceView = irrFaceViews[face];
    if (irrFaceView === undefined) return fail('irradiance-face-view');
    const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
      label: 'ibl-irradiance',
      colorAttachments: [
        {
          view: irrFaceView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    const faceBgResult = device.createBindGroup({
      label: `ibl-irr-face-bg-${face}`,
      layout: faceUniformsBgl,
      entries: [iblFaceUniformEntry(opts.faceUniformsBuffer, face)],
    });
    if (!faceBgResult.ok) return fail('irr-face-bg', faceBgResult.error);
    pass.setPipeline(irradiancePipeline);
    pass.setBindGroup(0, faceBgResult.value);
    pass.setBindGroup(1, cubeBg);
    pass.setVertexBuffer(0, opts.cubeVertexBuffer);
    pass.draw(6, 1, face * 6, 0);
    pass.end();

    const irradianceFaceStage = await submitStage(`irradiance-face-${face}`, true);
    if (!irradianceFaceStage.ok) return err(irradianceFaceStage.error);
  }
  const irradianceOpportunity = await yieldBetweenBatches('irradiance');
  if (!irradianceOpportunity.ok) return err(irradianceOpportunity.error);

  // (c) prefilter env: 5 mips x 6 faces = 30 sub-passes.
  for (let mip = 0; mip < PREFILTER_MIP_LEVELS; mip++) {
    const mipFaceViews = prefMipViews[mip];
    if (mipFaceViews === undefined) return fail('prefilter-mip-views');
    for (let face = 0; face < 6; face++) {
      const subIdx = prefilterSubpassIndex(mip, face);
      const mipFaceView = mipFaceViews[face];
      if (mipFaceView === undefined) return fail('prefilter-face-view');
      const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
        label: 'ibl-prefilter',
        colorAttachments: [
          {
            view: mipFaceView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      const bgResult = device.createBindGroup({
        label: `ibl-pref-bg-${subIdx}`,
        layout: prefilterGroup0Bgl,
        entries: iblPrefilterGroup0Entries(
          opts.faceUniformsBuffer,
          opts.prefilterUniformsBuffer,
          mip,
          face,
        ),
      });
      if (!bgResult.ok) return fail('pref-bg', bgResult.error);
      pass.setPipeline(prefilterPipeline);
      pass.setBindGroup(0, bgResult.value);
      pass.setBindGroup(1, cubeBg);
      pass.setVertexBuffer(0, opts.cubeVertexBuffer);
      pass.draw(6, 1, face * 6, 0);
      pass.end();

      // Bound software-GPU work just as for irradiance; preserve every sample.
      const faceStage = await submitStage(`prefilter-mip-${mip}-face-${face}`, true);
      if (!faceStage.ok) return err(faceStage.error);
    }
    const mipOpportunity = await yieldBetweenBatches(`prefilter-mip-${mip}`);
    if (!mipOpportunity.ok) return err(mipOpportunity.error);
  }

  // (d) brdf-lut: fullscreen triangle.
  {
    const pass: RhiRenderPassEncoder = encoder.beginRenderPass({
      label: 'ibl-brdf-lut',
      colorAttachments: [
        {
          view: brdfLutView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(brdfLutPipeline);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  // The final stage is fenced before the candidate is promoted.
  const brdfStage = await submitStage('brdf-lut', false);
  if (!brdfStage.ok) return err(brdfStage.error);

  const promoted: IblPrecomputeCandidate = {
    irradianceTexture: candidateIrradianceTexture,
    irradianceView: candidateIrradianceView,
    irradianceFaceViews: irrFaceViews,
    prefilterTexture: candidatePrefilterTexture,
    prefilterView: candidatePrefilterView,
    prefilterFaceViewsByMip: prefMipViews,
    brdfLutTexture: candidateBrdfLutTexture,
    brdfLutView,
  };
  // Previous outputs remain DeviceScope-owned until scope retirement. This
  // avoids destroying a texture still referenced by an already-recorded pass.
  cache.irradianceTexture = promoted.irradianceTexture;
  cache.irradianceView = promoted.irradianceView;
  cache.irradianceFaceViews = promoted.irradianceFaceViews;
  cache.prefilterTexture = promoted.prefilterTexture;
  cache.prefilterView = promoted.prefilterView;
  cache.prefilterFaceViewsByMip = promoted.prefilterFaceViewsByMip;
  cache.brdfLutTexture = promoted.brdfLutTexture;
  cache.brdfLutView = promoted.brdfLutView;

  // POST-SUBMIT counter increments (AC-20).
  cache.irradianceBakeCount += 1;
  cache.prefilterBakeCount += 1;
  cache.brdfLutBakeCount += 1;

  return ok({ submitted: true });
}

function adoptIblTexture(scope: DeviceScope, device: IblRhiOwner, texture: Texture): Texture {
  scope._adopt('texture', texture, (value) => {
    device.destroyTexture(value);
  });
  return texture;
}

// Local helper -- structured error payload shared across allocation paths.
function badAlloc(stage: string, cause?: RhiError): IblPrecomputeError {
  return {
    code: 'ibl-precompute-not-dispatched',
    expected: `${stage} allocated successfully`,
    hint: `check the RHI Result for ${stage}; counters must not increment before queue.submit`,
    ...(cause === undefined ? {} : { detail: { stage, rhiCode: cause.code } }),
  };
}
