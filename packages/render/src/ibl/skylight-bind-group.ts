import { STANDARD_PHYSICAL_BINDING_START } from '@forgeax/engine-shader';
// skylight-bind-group.ts -- Skylight resources merged into @group(1) PBR
// material BGL (binding 7..12) + fallback identity resource bundle. The
// complete Standard material group appends transmission entries.
//
// Plan-strategy D-5 (round-4 REVISED): the round-2 stand-alone @group(4)
// Skylight BindGroupLayout collided with WebGPU's default maxBindGroups=4
// limit, blocking pbr-pl pipeline-layout creation in chrome-beta. Round-4
// rewrites the contract: Skylight 6 entries are **appended** to the
// existing PBR material BindGroupLayout at bindings 7..12; pipeline layout
// stays at 4 slots `[view, material, mesh, instances]`; unlit pipeline is
// untouched (it uses its own material BGL).
//
// Surface (M2 round-4 / t40 amend):
//   - The matching BindGroupLayout entries are owned by
//     `appendInjection(entries, 'ibl')` in `pbr-pipeline.ts`.
//   - assembleMaterialWithSkylightEntries(materialEntries, skylightResources):
//     given the existing material BindGroupEntry values + a skylight
//     resource bundle (active or fallback), returns the merged material
//     array with the engine-owned transmission pair at the end, suitable for
//     `device.createBindGroup`. Charter P5 minimal
//     surface: this helper does NOT allocate samplers/textures itself.
//   - createSkylightFallback(device, queue): allocate a 1x1 white
//     irradiance/prefilter cube pair + a 1x1 BRDF approximation + intensity=0 uniform
//     buffer + a shared linear/clamp sampler. Returns the resource bundle
//     so createRenderer can wire it into PipelineState.skylightFallback;
//     no stand-alone bindGroup is created (that was the round-2 shape).
//
// All resources write into PipelineState.skylightFallback so the M4
// recordFrame branch (Skylight present vs absent) selects active vs
// fallback resources when assembling the PBR material BindGroup
// (charter P4 consistent abstraction -- one BG layout, one assembly path).
// The irradiance texture uses the canonical irradianceEOverPi payload semantic;
// sampling applies the single E/pi normalization at the shader callsite.

import type {
  BindGroupEntry,
  Buffer,
  Result,
  RhiError,
  Sampler,
  SamplerDescriptor,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';

// The rhi shim enforces bytesPerRow % 256 === 0 uniformly, even for one row.
// Every 1x1 fallback upload pads its texel to this row stride per layer.
export const FALLBACK_BYTES_PER_ROW = 256;

export type TexelFallbackDescriptor = TextureDescriptor & {
  readonly size: { readonly width: 1; readonly height: 1; readonly depthOrArrayLayers: number };
};

/**
 * Descriptor for a sampled 1x1 constant-texel fallback. Cube fallbacks carry
 * six layers; array fallbacks name their layer count.
 */
export function texelFallbackDescriptor(
  label: string,
  format: GPUTextureFormat,
  viewDimension: '2d' | '2d-array' | 'cube' | '3d' = '2d',
  layers = viewDimension === 'cube' ? 6 : 1,
): TexelFallbackDescriptor {
  return {
    label,
    size: { width: 1, height: 1, depthOrArrayLayers: layers },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: viewDimension === '3d' ? '3d' : '2d',
    format,
    usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
    viewFormats: [],
    textureBindingViewDimension:
      viewDimension === 'cube' || viewDimension === '2d-array' ? viewDimension : undefined,
  };
}

/** Upload `texel` (one texel's bytes) to every layer of a {@link texelFallbackDescriptor} texture. */
export function writeTexelFallback(
  queue: Pick<SkylightQueue, 'writeTexture'>,
  texture: Texture,
  descriptor: TexelFallbackDescriptor,
  texel: Uint8Array | Uint16Array,
): Result<void, RhiError> {
  const layers = descriptor.size.depthOrArrayLayers;
  const bytes = new Uint8Array(texel.buffer, texel.byteOffset, texel.byteLength);
  const data = new Uint8Array(FALLBACK_BYTES_PER_ROW * layers);
  for (let layer = 0; layer < layers; layer += 1) data.set(bytes, layer * FALLBACK_BYTES_PER_ROW);
  return queue.writeTexture(
    { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    data,
    { offset: 0, bytesPerRow: FALLBACK_BYTES_PER_ROW, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: layers },
  );
}

// ─── Device shim shapes ──────────────────────────────────────────────────────
//
// We accept a structural subset of RhiDevice so unit tests can pass a
// mocked device without standing up the full RHI surface. The createRenderer
// production path passes a real RhiDevice; both satisfy the interface.

/**
 * Minimal RhiDevice subset used by the skylight fallback helper.
 * Mirrors RhiDevice for the methods touched by this module (charter P4
 * narrowest surface -- avoids dragging the full RhiDevice in for tests).
 */
export interface SkylightDevice {
  createSampler(desc: SamplerDescriptor): Result<Sampler, RhiError>;
  createTexture(desc: TextureDescriptor): Result<Texture, RhiError>;
  createTextureView(tex: Texture, desc: TextureViewDescriptor): Result<TextureView, RhiError>;
  createBuffer(desc: {
    label?: string | undefined;
    size: number;
    usage: number;
    mappedAtCreation?: boolean | undefined;
  }): Result<Buffer, RhiError>;
}

/**
 * Minimal queue subset used for fallback resource upload (zero-pixel
 * texture seed + intensity=0 uniform seed).
 */
export interface SkylightQueue {
  writeTexture(
    destination: {
      texture: Texture;
      mipLevel?: number;
      origin?: { x: number; y: number; z: number };
    },
    data: ArrayBufferView,
    dataLayout: { offset: number; bytesPerRow: number; rowsPerImage: number },
    size: { width: number; height: number; depthOrArrayLayers: number },
  ): Result<void, RhiError>;
  writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView,
  ): Result<void, RhiError> | unknown;
}

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Skylight bind group resources (cube + cube + 2D LUT + intensity uniform).
 * The active set comes from the IblPipelineCache precompute path; the
 * fallback set is the 1x1 zero identity bundle below.
 */
export interface SkylightBindGroupResources {
  readonly irradianceView: TextureView;
  /** Shared by diffuse irradiance and the BRDF lookup table. */
  readonly irradianceSampler: Sampler;
  readonly prefilterView: TextureView;
  /** Present only when the per-draw prefilter slot was replaced by a local probe. */
  readonly skylightPrefilterView?: TextureView;
  readonly prefilterSampler: Sampler;
  readonly brdfLutView: TextureView;
  readonly intensityBuffer: Buffer;
}

/**
 * Fallback resource bundle attached to `PipelineState.skylightFallback`.
 * The M4 round-4 recordFrame branch reads this bundle when
 * `skylightCount === 0` and feeds it through
 * `assembleMaterialWithSkylightEntries` so the PBR material BindGroup
 * binds the same 14-entry layout shape with zero data + intensity=0.
 *
 * No stand-alone `bindGroup` field: the round-2 stand-alone Skylight BG
 * is gone (D-5 round-4); the fallback resources flow into the PBR
 * material BG at binding 7..12.
 */
export interface SkylightFallback {
  readonly irradianceTexture: Texture;
  readonly irradianceView: TextureView;
  readonly prefilterTexture: Texture;
  readonly prefilterView: TextureView;
  readonly brdfLutTexture: Texture;
  readonly brdfLutView: TextureView;
  readonly sampler: Sampler;
  readonly intensityBuffer: Buffer;
}

/**
 * Project the fallback bundle into material Skylight bindings. Active IBL
 * views replace the three views; the linear-clamp sampler and the per-frame
 * intensity uniform always come from the fallback bundle.
 */
export function skylightBindGroupResources(
  fallback: SkylightFallback,
  views?: { readonly irr: TextureView; readonly pref: TextureView; readonly brdf: TextureView },
): SkylightBindGroupResources {
  return {
    irradianceView: views?.irr ?? fallback.irradianceView,
    irradianceSampler: fallback.sampler,
    prefilterView: views?.pref ?? fallback.prefilterView,
    prefilterSampler: fallback.sampler,
    brdfLutView: views?.brdf ?? fallback.brdfLutView,
    intensityBuffer: fallback.intensityBuffer,
  };
}

// ─── Pure merger: BindGroupEntry values (assembly site) ─────────────────────

/**
 * Append the 6 Skylight BindGroupEntry resources (binding 7..12) onto the
 * existing PBR material BindGroupEntry values (binding 0..6). The caller
 * passes the result to `device.createBindGroup` as part of the merged
 * material BG.
 *
 * The skylight argument may be the fallback identity bundle (rendered
 * with ambient=0) or the active IblPipelineCache output bundle. Same
 * call site, same layout shape -- charter P4 + F1 (AI users do not need
 * a `if (hasSkylight)` branch when writing demos).
 */
/** Engine-owned material transmission injection resources. */
export interface TransmissionBindGroupResources {
  readonly sampler: Sampler;
  readonly backdropView?: TextureView | null;
}

/** Renderer-owned sampled resources consumed by the single-layer medium. */
export interface SurfaceMediumBindGroupResources {
  readonly planarView: TextureView;
  readonly planarUniform: Buffer;
  readonly planarUniformOffset: number;
  readonly rawDepthSampler: Sampler;
  readonly rawDepthView: TextureView;
  readonly nearestLayerSampler: Sampler;
  readonly nearestLayerView: TextureView;
  readonly nearestDepthSampler: Sampler;
  readonly nearestDepthView: TextureView;
}

/** Engine-owned texture injection resources derived from material parameters. */
export interface TextureInjectionResource {
  readonly slot: number;
  readonly sampler: Sampler;
  readonly view: TextureView;
}

// IBL and transmission injection starts are computed from the assembled list length on each push —
// no hardcoded binding literals.

export function assembleMaterialWithSkylightEntries(
  materialEntries: readonly BindGroupEntry[],
  skylight: SkylightBindGroupResources,
  transmission?: TransmissionBindGroupResources | null | undefined,
  textureInjections: readonly TextureInjectionResource[] = [],
  surfaceMedium?: SurfaceMediumBindGroupResources | undefined,
): BindGroupEntry[] {
  // IBL injection start = end of the user-region. The user-region IS
  // `materialEntries` (UBO binding 0 + N sampler/texture pairs), so its length
  // is the injection start — was a hardcoded 7, now per-shader (a 4-texture
  // parallax material's user-region is 9 entries, so IBL lands at 9). This
  // mirrors the BGL-side `appendInjection(userRegion, 'ibl')` (D-1 / D-8),
  // which likewise reads `bgl.length`.
  const iblStart = materialEntries.length;
  const result: BindGroupEntry[] = [
    ...materialEntries,
    {
      binding: iblStart,
      resource: { kind: 'textureView', value: skylight.irradianceView },
    },
    {
      binding: iblStart + 1,
      resource: { kind: 'sampler', value: skylight.irradianceSampler },
    },
    {
      binding: iblStart + 2,
      resource: { kind: 'textureView', value: skylight.prefilterView },
    },
    {
      binding: iblStart + 3,
      resource: { kind: 'sampler', value: skylight.prefilterSampler },
    },
    {
      binding: iblStart + 4,
      resource: { kind: 'textureView', value: skylight.brdfLutView },
    },
    {
      binding: iblStart + 5,
      resource: { kind: 'buffer', value: { buffer: skylight.intensityBuffer } },
    },
  ];
  // A null transmission omits the unavailable backdrop slots. Otherwise the
  // existing Skylight resources fill unused slots without changing their ABI.
  // Physical injections below keep their fixed binding numbers in either case.
  const transmissionSampler = transmission?.sampler ?? skylight.irradianceSampler;
  const transmissionView = transmission?.backdropView ?? skylight.brdfLutView;
  const transmissionStart = result.length;
  if (transmission !== null)
    result.push(
      {
        binding: transmissionStart,
        resource: { kind: 'sampler', value: transmissionSampler },
      },
      {
        binding: transmissionStart + 1,
        resource: { kind: 'textureView', value: transmissionView },
      },
    );
  if (surfaceMedium !== undefined) {
    const surfaceStart = result.length;
    result.push(
      {
        binding: surfaceStart,
        resource: { kind: 'sampler', value: surfaceMedium.rawDepthSampler },
      },
      {
        binding: surfaceStart + 1,
        resource: { kind: 'textureView', value: surfaceMedium.rawDepthView },
      },
      {
        binding: surfaceStart + 2,
        resource: { kind: 'sampler', value: surfaceMedium.nearestLayerSampler },
      },
      {
        binding: surfaceStart + 3,
        resource: { kind: 'textureView', value: surfaceMedium.nearestLayerView },
      },
      {
        binding: surfaceStart + 4,
        resource: { kind: 'sampler', value: surfaceMedium.nearestDepthSampler },
      },
      {
        binding: surfaceStart + 5,
        resource: { kind: 'textureView', value: surfaceMedium.nearestDepthView },
      },
      {
        binding: surfaceStart + 6,
        resource: { kind: 'textureView', value: surfaceMedium.planarView },
      },
      {
        binding: surfaceStart + 7,
        resource: {
          kind: 'buffer',
          value: {
            buffer: surfaceMedium.planarUniform,
            offset: surfaceMedium.planarUniformOffset,
            size: 96,
          },
        },
      },
    );
  }
  // Standard physical maps occupy fixed bindings starting at STANDARD_PHYSICAL_BINDING_START.  The `slot` value
  // is the canonical index from STANDARD_PHYSICAL_TEXTURE_FIELDS; preserve
  // gaps for omitted authored maps instead of compacting this tail.
  const physicalStart = STANDARD_PHYSICAL_BINDING_START;
  for (let index = 0; index < textureInjections.length; index += 1) {
    const resource = textureInjections[index];
    if (resource === undefined) continue;
    const binding = physicalStart + resource.slot * 2;
    result.push(
      {
        binding,
        resource: { kind: 'sampler', value: resource.sampler },
      },
      {
        binding: binding + 1,
        resource: { kind: 'textureView', value: resource.view },
      },
    );
  }
  if (surfaceMedium === undefined) {
    result.push({
      binding: 47,
      resource: {
        kind: 'textureView',
        value: skylight.skylightPrefilterView ?? skylight.prefilterView,
      },
    });
  }
  return result;
}

// ─── Fallback constructor (createRenderer wires this into pipelineState) ────

/**
 * Allocate the fallback Skylight resource bundle: 1x1 WHITE rgba16float
 * irradiance/prefilter texture_cube pair + 1x1 rg16float BRDF approximation
 * `[1, 0]` + a 16-byte uniform buffer + a single
 * linear / clamp-to-edge sampler reused across all three texture slots.
 *
 * Two regimes share this bundle (the per-frame Skylight uniform selects):
 *   - No Skylight entity: render-system-record writes intensity=0, so
 *       ambient = whiteIrradiance * kD * albedo * color * 0 == 0
 *     -- physically black, no `if (hasSkylight)` shader branch (D-5 round-4).
 *   - Skylight with NO cubemap (downstream integration #4): record writes the
 *     user's intensity + color, so the WHITE irradiance gives an instant
 *     solid-color ambient and a neutral white specular reflection with no
 *     async precompute. The 1x1 BRDF approximation is intentionally roughness
 *     independent; a real cubemap swaps in the prefiltered IBL views and LUT.
 *
 * No stand-alone BindGroupLayout / BindGroup is created here -- those
 * roles moved into the PBR material BGL factory (D-5 round-4). The
 * caller (createRenderer) feeds the resource handles below through
 * `assembleMaterialWithSkylightEntries` when composing the per-frame
 * material BindGroup.
 */
export function createSkylightFallback(
  device: SkylightDevice,
  queue: SkylightQueue,
): SkylightFallback {
  // Diffuse IBL and the BRDF LUT share one binding; prefilter remains a
  // separate binding so per-draw reflection probes can replace it. Both
  // bindings use this linear-clamp sampler for the global environment.
  const samplerResult = device.createSampler({
    label: 'skylight-fallback-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!samplerResult.ok) throw samplerResult.error;
  const sampler = samplerResult.value;

  // A Skylight with no cubemap represents a flat white environment, so both
  // irradiance and prefilter cubes are white (half-float 1.0 = 0x3c00); the
  // specular input must not be black just because the prefilter bake is
  // unavailable. The 1x1 rg16float BRDF approximates the split-sum `A=1, B=0`
  // until a real IBL bake replaces it. This does NOT light scenes that lack a
  // Skylight: the per-frame Skylight uniform writes intensity 0 when no
  // Skylight entity exists (render-system-record).
  const createFallback = (descriptor: TexelFallbackDescriptor, texel: Uint16Array): Texture => {
    const texture = device.createTexture(descriptor);
    if (!texture.ok) throw texture.error;
    const written = writeTexelFallback(queue, texture.value, descriptor, texel);
    if (!written.ok) throw written.error;
    return texture.value;
  };
  const white = new Uint16Array([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
  const irradianceTexture = createFallback(
    texelFallbackDescriptor('skylight-fallback-irradiance-cube', 'rgba16float', 'cube'),
    white,
  );
  const prefilterTexture = createFallback(
    texelFallbackDescriptor('skylight-fallback-prefilter-cube', 'rgba16float', 'cube'),
    white,
  );
  const brdfLutTexture = createFallback(
    texelFallbackDescriptor('skylight-fallback-brdf-lut', 'rg16float'),
    new Uint16Array([0x3c00, 0]),
  );

  // Cube views over the depthOrArrayLayers=6 textures so the @group(1)
  // @binding(7,9) texture_cube bindings can sample them.
  const irradianceViewResult = device.createTextureView(irradianceTexture, {
    label: 'skylight-fallback-irradiance-cube-view',
    dimension: 'cube',
    arrayLayerCount: 6,
  });
  if (!irradianceViewResult.ok) throw irradianceViewResult.error;
  const irradianceView = irradianceViewResult.value;

  const prefilterViewResult = device.createTextureView(prefilterTexture, {
    label: 'skylight-fallback-prefilter-cube-view',
    dimension: 'cube',
    arrayLayerCount: 6,
  });
  if (!prefilterViewResult.ok) throw prefilterViewResult.error;
  const prefilterView = prefilterViewResult.value;

  const brdfLutViewResult = device.createTextureView(brdfLutTexture, {
    label: 'skylight-fallback-brdf-lut-view',
    dimension: '2d',
  });
  if (!brdfLutViewResult.ok) throw brdfLutViewResult.error;
  const brdfLutView = brdfLutViewResult.value;

  // The 64-byte Standard environment payload reserves two extra vec4 lanes
  // for probe-mode diffuse color and rotation. Ordinary Skylight leaves them zero.
  const intensityBufResult = device.createBuffer({
    label: 'skylight-fallback-intensity',
    size: 64,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  if (!intensityBufResult.ok) throw intensityBufResult.error;
  const intensityBuffer = intensityBufResult.value;
  queue.writeBuffer(intensityBuffer, 0, new Float32Array([0, 0, 0, 0, 0, 0, 0, 1]));

  return {
    irradianceTexture,
    irradianceView,
    prefilterTexture,
    prefilterView,
    brdfLutTexture,
    brdfLutView,
    sampler,
    intensityBuffer,
  };
}
