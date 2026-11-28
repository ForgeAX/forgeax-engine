import { mat4 } from '@forgeax/engine-math';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { jitterCameraProjection } from './camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from './record/helpers';
import type { CameraSnapshot } from './render-contract';
import { getSsaoParameters } from './ssao-config';

// SSAO uniform layout (plan-strategy §D-1 + §D-C, M7 round-2):
//   bytes [0..63]    view              mat4x4<f32>
//   bytes [64..127]  projection        mat4x4<f32>
//   bytes [128..191] inverseProjection mat4x4<f32>
//   bytes [192..207] intensityPad      vec4<f32>  // x = intensity, y = radius, z = bias, w = sample budget
//   bytes [208..223] algorithmPad      vec4<f32>  // algorithm, thickness, distance exponent, horizon falloff
//   bytes [224..255] reserved
//
// The total is rounded to 256B so the same UBO can host an additional
// shader-side scalar binding at the tail without re-allocation.
export const SSAO_UNIFORM_INTENSITY_OFFSET = 192;
export const SSAO_UNIFORM_BYTES = 256;
export const SCREEN_AO_UNIFORM_BYTES = SSAO_UNIFORM_BYTES + 16;

type AoConfig = NonNullable<RenderPipelineAsset['config']>['ambientOcclusion'];

/** Reuse staging storage while giving a nested upload its own page. */
export class SsaoUniformPage {
  private readonly data = new Float32Array(SSAO_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  private readonly view = mat4.view(this.data, 0);
  private readonly projection = mat4.view(this.data, 1);
  private readonly inverse = mat4.view(this.data, 2);
  private uploading = false;

  upload(
    queue: RhiDevice['queue'],
    buffer: Buffer,
    camera: CameraSnapshot,
    config: AoConfig,
  ): ReturnType<RhiDevice['queue']['writeBuffer']> {
    if (this.uploading) return new SsaoUniformPage().upload(queue, buffer, camera, config);
    this.uploading = true;
    try {
      return queue.writeBuffer(buffer, 0, this.pack(camera, config));
    } finally {
      this.uploading = false;
    }
  }

  static snapshot(camera: CameraSnapshot, config: AoConfig): Float32Array {
    return new SsaoUniformPage().pack(camera, config);
  }

  private pack(camera: CameraSnapshot, config: AoConfig): Float32Array {
    writeAoCamera(camera, this.view, this.projection, this.inverse);
    const parameters = getSsaoParameters(config?.enabled === true ? config : undefined);
    const out = this.data;
    out[48] = parameters.intensity;
    out[49] = parameters.radius;
    out[50] = parameters.bias;
    out[51] = parameters.sampleCount;
    out[52] = parameters.method === 'gtao' ? 1 : 0;
    out[53] = parameters.thickness;
    out[54] = parameters.distanceExponent;
    out[55] = parameters.distanceFallOff;
    return out;
  }
}

export const buildSsaoUniformPayload = SsaoUniformPage.snapshot;

function writeAoCamera(
  camera: CameraSnapshot,
  view: ReturnType<typeof mat4.create>,
  projection: ReturnType<typeof mat4.create>,
  inverse: ReturnType<typeof mat4.create>,
): void {
  computeProjectionMatrix(camera, projection);
  jitterCameraProjection(projection, projection, camera.temporal?.currentJitterUv);
  computeViewMatrix(camera, view);
  mat4.invert(inverse, projection);
}

/** The physical AO pass owns its synchronous uniform upload storage. */
export class ScreenAoUniformPage {
  readonly data = new Float32Array(SCREEN_AO_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  readonly view = mat4.view(this.data, 0);
  readonly projection = mat4.view(this.data, 1);
  private readonly inverse = mat4.view(this.data, 2);

  writeCamera(
    camera: CameraSnapshot,
    size: { readonly width: number; readonly height: number },
  ): void {
    writeAoCamera(camera, this.view, this.projection, this.inverse);
    this.data[64] = size.width;
    this.data[65] = size.height;
  }
}
