// apps/learn-render/5.advanced-lighting/6.hdr/src/hdr-pipeline.ts
// One Standard pipeline plus one host-owned fullscreen feature.

import { createFullscreenRenderFeature } from '@forgeax/engine-app';
import { err, ok, type Result } from '@forgeax/engine-types';

export type HdrMode = 'hdr' | 'ldr';

export const HDR_EXPOSURE_POSTPROCESS_ID = 'learn-render::5-6-hdr-lo-exposure';

export const HDR_EFFECT_WGSL = `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

struct Params {
  exposure : f32,
  mode : f32,
  pad0 : f32,
  pad1 : f32,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@group(1) @binding(0) var sourceTexture : texture_2d<f32>;
@group(1) @binding(1) var sourceSampler : sampler;
@group(1) @binding(2) var<uniform> params : Params;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let source = textureSample(sourceTexture, sourceSampler, in.uv).rgb;
  if (params.mode > 0.5) { return vec4<f32>(source, 1.0); }
  let mapped = vec3<f32>(1.0, 1.0, 1.0) - exp(-source * params.exposure);
  return vec4<f32>(mapped, 1.0);
}
`;

export const hdrFeature = createFullscreenRenderFeature({
  identity: HDR_EXPOSURE_POSTPROCESS_ID,
  source: HDR_EFFECT_WGSL,
  params: { byteSize: 16, defaultValue: new Uint8Array(16) },
});

export type HdrInstallError =
  | { code: 'pipelines-not-ready'; hint: string }
  | { code: 'unknown-hdr-key'; hint: string };

export interface HdrPipelineRegistry {
  setMode(mode: HdrMode): void;
}

let activeRegistry: HdrPipelineRegistry | null = null;

export function installHdrPipelineByKey(key: string): Result<true, HdrInstallError> {
  if (activeRegistry === null) {
    return err({
      code: 'pipelines-not-ready',
      hint: 'await app.start() resolves before selecting an HDR mode',
    });
  }
  if (key !== '1' && key !== '2') {
    return err({
      code: 'unknown-hdr-key',
      hint: `expected '1' or '2'; received ${JSON.stringify(key)}`,
    });
  }
  activeRegistry.setMode(key === '1' ? 'hdr' : 'ldr');
  return ok(true);
}

export function hdrDisplayNameByKey(key: string): HdrMode | null {
  if (key === '1') return 'hdr';
  if (key === '2') return 'ldr';
  return null;
}

export function setHdrPipelineRegistryForTest(registry: HdrPipelineRegistry): void {
  activeRegistry = registry;
}

export function resetHdrPipelineRegistryForTest(): void {
  activeRegistry = null;
}
