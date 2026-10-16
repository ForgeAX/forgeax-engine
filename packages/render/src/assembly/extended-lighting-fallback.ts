import type {
  Buffer,
  Result,
  RhiDevice,
  RhiError,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { LTC_TABLE_HEIGHT, LTC_TABLE_WIDTH, LTC_TABLES } from '@forgeax/engine-shader';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import {
  COOKIE_MATRIX_BYTES,
  COOKIE_MIP_LEVEL_COUNT,
  COOKIE_SLICE_SIZE,
  IES_SLICE_HEIGHT,
  IES_SLICE_WIDTH,
} from '../prepare/extended-lighting/resources';
import { createCookieProjectionMatrixData } from '../prepare/extended-lighting/spot-modifiers';
import { runShimSyncStep } from './renderer-helpers';

type FallbackDevice = Pick<
  RhiDevice,
  'createBuffer' | 'createTexture' | 'createTextureView' | 'queue'
>;

export interface ExtendedLightingFallbackResources {
  readonly iesProfileTexture: Texture;
  readonly cookieTexture: Texture;
  readonly cookieMatrixBuffer: Buffer;
  readonly iesProfileTextureView: TextureView;
  readonly cookieTextureView: TextureView;
  readonly ltcLambertTextureView: TextureView;
  readonly ltcGgxTextureView: TextureView;
}

function requireResult<T>(fn: () => Result<T, RhiError>, expected: string, hint: string): T {
  const result = runShimSyncStep(fn, 'webgpu-runtime-error', expected, hint);
  if (!result.ok) throw result.error;
  return result.value;
}

function createModifierTexture(
  device: FallbackDevice,
  label: string,
  width: number,
  height: number,
  format: 'r16float' | 'rgba8unorm',
  mipLevelCount = 1,
): Texture {
  return requireResult(
    () =>
      device.createTexture({
        label,
        size: { width, height, depthOrArrayLayers: 32 },
        mipLevelCount,
        sampleCount: 1,
        dimension: '2d',
        format,
        usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    `createTexture (${label}) succeeded`,
    'check extended-lighting array-layer and texture-binding limits',
  );
}

function writeModifierTexture(
  device: FallbackDevice,
  texture: Texture,
  data: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  label: string,
  mipLevel = 0,
): void {
  requireResult(
    () =>
      device.queue.writeTexture(
        { texture, mipLevel, origin: { x: 0, y: 0, z: 0 } },
        data,
        { offset: 0, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 32 },
      ),
    `queue.writeTexture (${label}) succeeded`,
    'verify extended-lighting modifier row alignment',
  );
}

function createLtcView(device: FallbackDevice, label: string, table: Uint16Array): TextureView {
  const texture = requireResult(
    () =>
      device.createTexture({
        label,
        size: { width: LTC_TABLE_WIDTH, height: LTC_TABLE_HEIGHT, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'rgba16float',
        usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    `createTexture (${label}) succeeded`,
    'check resident LTC table texture capabilities',
  );
  requireResult(
    () =>
      device.queue.writeTexture(
        { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        new Uint8Array(table.buffer, table.byteOffset, table.byteLength),
        { offset: 0, bytesPerRow: LTC_TABLE_WIDTH * 8, rowsPerImage: LTC_TABLE_HEIGHT },
        { width: LTC_TABLE_WIDTH, height: LTC_TABLE_HEIGHT, depthOrArrayLayers: 1 },
      ),
    `queue.writeTexture (${label}) succeeded`,
    'verify resident LTC table row alignment',
  );
  return requireResult(
    () => device.createTextureView(texture, { label: `${label}-view`, dimension: '2d' }),
    `createTextureView (${label}) succeeded`,
    'verify resident LTC view matches shader binding',
  );
}

/** Allocate the always-valid fallback resources for the extended-lighting BGL. */
export function createExtendedLightingFallbackResources(
  device: FallbackDevice,
  enabled: boolean,
): ExtendedLightingFallbackResources | undefined {
  if (!enabled) return undefined;
  const iesTexture = createModifierTexture(
    device,
    'fallback-ies-profile-array',
    IES_SLICE_WIDTH,
    IES_SLICE_HEIGHT,
    'r16float',
  );
  const cookieTexture = createModifierTexture(
    device,
    'fallback-cookie-array',
    COOKIE_SLICE_SIZE,
    COOKIE_SLICE_SIZE,
    'rgba8unorm',
    COOKIE_MIP_LEVEL_COUNT,
  );
  const iesData = new Uint8Array(IES_SLICE_WIDTH * 2 * IES_SLICE_HEIGHT * 32);
  for (let offset = 0; offset < iesData.length; offset += 2) {
    iesData[offset] = 0;
    iesData[offset + 1] = 0x3c;
  }
  const cookieData = new Uint8Array(COOKIE_SLICE_SIZE * 4 * COOKIE_SLICE_SIZE * 32);
  cookieData.fill(0xff);
  writeModifierTexture(
    device,
    iesTexture,
    iesData,
    IES_SLICE_WIDTH,
    IES_SLICE_HEIGHT,
    IES_SLICE_WIDTH * 2,
    'fallback IES array',
  );
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    writeModifierTexture(
      device,
      cookieTexture,
      cookieData.subarray(0, size * size * 4 * 32),
      size,
      size,
      size * 4,
      'fallback Cookie array',
      level,
    );
  }
  const iesProfileTextureView = requireResult(
    () =>
      device.createTextureView(iesTexture, {
        label: 'fallback-ies-profile-array-view',
        dimension: '2d-array',
        arrayLayerCount: 32,
      }),
    'createTextureView (fallback IES array) succeeded',
    'verify 2d-array view matches modifier BGL',
  );
  const cookieTextureView = requireResult(
    () =>
      device.createTextureView(cookieTexture, {
        label: 'fallback-cookie-array-view',
        dimension: '2d-array',
        arrayLayerCount: 32,
      }),
    'createTextureView (fallback Cookie array) succeeded',
    'verify 2d-array view matches modifier BGL',
  );
  const cookieMatrixBuffer = requireResult(
    () =>
      device.createBuffer({
        label: 'fallback-cookie-matrices',
        size: COOKIE_MATRIX_BYTES,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
        mappedAtCreation: false,
      }),
    'createBuffer (fallback Cookie matrices) succeeded',
    'check uniform-buffer size and usage support',
  );
  requireResult(
    () => device.queue.writeBuffer(cookieMatrixBuffer, 0, createCookieProjectionMatrixData(32)),
    'queue.writeBuffer (fallback Cookie matrices) succeeded',
    'verify Cookie matrix payload alignment',
  );
  return {
    iesProfileTexture: iesTexture,
    cookieTexture,
    cookieMatrixBuffer,
    iesProfileTextureView,
    cookieTextureView,
    ltcLambertTextureView: createLtcView(
      device,
      'extended-lighting-ltc-lambert',
      LTC_TABLES.lambert,
    ),
    ltcGgxTextureView: createLtcView(device, 'extended-lighting-ltc-ggx', LTC_TABLES.ggx),
  };
}
