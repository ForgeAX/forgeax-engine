import { mat4 } from '@forgeax/engine-math';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { jitterCameraProjection } from './camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from './record/helpers';
import type { CameraSnapshot } from './render-contract';
import { GTAO_SAMPLE_COUNTS, getSsaoParameters, SSAO_SAMPLE_COUNTS } from './ssao-config';

// SSAO uniform layout (plan-strategy §D-1 + §D-C, M7 round-2):
//   bytes [0..63]    view              mat4x4<f32>
//   bytes [64..127]  projection        mat4x4<f32>
//   bytes [128..191] inverseProjection mat4x4<f32>
//   bytes [192..207] intensityPad      vec4<f32>  // x = intensity, y = radius, z = bias, w = sample budget
//   bytes [208..223] algorithmPad      vec4<f32>  // algorithm, thickness, distance exponent, horizon falloff
//   bytes [224..255] padding           // align to 256B WebGPU UBO offset
//
// The total is rounded to 256B so the same UBO can host an additional
// shader-side scalar binding at the tail without re-allocation.
export const SSAO_UNIFORM_INTENSITY_OFFSET = 192;
export const SSAO_UNIFORM_BYTES = 256;

function createSsaoScratch() {
  return { projection: mat4.create(), view: mat4.create() };
}
let ssaoScratch: ReturnType<typeof createSsaoScratch> | undefined;
let buildingSsao = false;

/** The early upload and graph pass observe the same sampled camera and SSAO parameters. */
export function buildSsaoUniformPayload(
  camera: CameraSnapshot,
  config: NonNullable<RenderPipelineAsset['config']>['ssao'],
): Float32Array {
  const wasBuilding = buildingSsao;
  buildingSsao = true;
  try {
    ssaoScratch ??= createSsaoScratch();
    const scratch = wasBuilding ? createSsaoScratch() : ssaoScratch;
    const projection = computeProjectionMatrix(camera, scratch.projection);
    jitterCameraProjection(projection, projection, camera.temporal?.currentJitterUv);
    const out = new Float32Array(SSAO_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
    out.set(computeViewMatrix(camera, scratch.view), 0);
    out.set(projection, 16);
    out.set(mat4.invert(projection, projection), 32);
    const parameters = getSsaoParameters(config?.enabled === true ? config : undefined);
    out[48] = parameters.intensity;
    out[49] = parameters.radius;
    out[50] = parameters.bias;
    out[51] = (parameters.algorithm === 'gtao' ? GTAO_SAMPLE_COUNTS : SSAO_SAMPLE_COUNTS)[
      parameters.quality
    ];
    out[52] = parameters.algorithm === 'gtao' ? 1 : 0;
    out[53] = parameters.thickness;
    out[54] = parameters.distanceExponent;
    out[55] = parameters.distanceFallOff;
    return out;
  } finally {
    buildingSsao = wasBuilding;
  }
}
