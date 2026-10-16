import {
  type RhiDevice,
  RhiError,
  type Sampler,
  type Texture,
  type TextureDescriptor,
  type TextureView,
} from '@forgeax/engine-rhi';
import { DIRECT_DFG_LUT_SIZE, directDfgLutBytes } from '@forgeax/engine-shader';
import {
  err,
  getAdmittedParamSchemaInterface,
  ok,
  type ParamSchemaEntry,
  type Result,
} from '@forgeax/engine-types';
import type { DeviceScope } from './device-scope';

export const DIRECT_DFG_LUT_DESCRIPTOR = {
  label: 'standard-direct-dfg-lut',
  size: { width: DIRECT_DFG_LUT_SIZE, height: DIRECT_DFG_LUT_SIZE, depthOrArrayLayers: 1 },
  format: 'rg16float',
  usage: 0x02 | 0x04,
  mipLevelCount: 1,
  sampleCount: 1,
  dimension: '2d',
  textureBindingViewDimension: undefined,
} as const satisfies TextureDescriptor;

export interface DirectDfgLut {
  readonly texture: Texture;
  readonly view: TextureView;
  /** Compute transports have no IBL sampler; raster reuses its existing sampler. */
  readonly sampler: Sampler;
}

const luts = new WeakMap<DeviceScope, { readonly device: RhiDevice; readonly lut: DirectDfgLut }>();

/** The real u32 material parameter owns the optional shader/resource contract. */
export function materialUsesDirectDfgLut(
  schema: readonly { readonly name: string; readonly type: string }[] | undefined,
): boolean {
  if (schema === undefined) return false;
  const admitted = getAdmittedParamSchemaInterface(schema as readonly ParamSchemaEntry[]);
  if (admitted !== undefined)
    return admitted.parameterTypes.get('directMultiscatteringLut') === 'u32';
  return schema.some((entry) => entry.name === 'directMultiscatteringLut' && entry.type === 'u32');
}

/** One immutable upload per live DeviceScope. Default fitted materials never call this owner. */
export function getOrCreateDirectDfgLut(
  device: RhiDevice,
  scope: DeviceScope,
): Result<DirectDfgLut, RhiError> {
  const stale = () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'a live DeviceScope for the current DFG texture device',
        hint: 'prepare the material again in the recovered renderer generation',
      }),
    );
  if (!scope.isAlive()) return stale();
  const cached = luts.get(scope);
  if (cached !== undefined) return cached.device === device ? ok(cached.lut) : stale();
  const texture = device.createTexture(DIRECT_DFG_LUT_DESCRIPTOR);
  if (!texture.ok) return texture;
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return ok(undefined);
    const result = device.destroyTexture(texture.value);
    if (result.ok) destroyed = true;
    return result;
  };
  // Adopt before upload: a failed initial destroy must remain owned so scope
  // retirement can retry it, while the partial value never enters the cache.
  const ref = scope._adopt('texture', texture.value, () => {
    luts.delete(scope);
    destroy().unwrap();
  });
  const fail = <T>(result: Result<never, T>) => {
    if (destroy().ok) scope._release(ref);
    return result;
  };
  // All RHI backends accept a 256-byte row stride. The GPU texture itself remains 1024 bytes.
  const bytes = directDfgLutBytes();
  const upload = new Uint8Array(256 * DIRECT_DFG_LUT_SIZE);
  for (let row = 0; row < DIRECT_DFG_LUT_SIZE; row += 1) {
    upload.set(bytes.subarray(row * 64, (row + 1) * 64), row * 256);
  }
  const written = device.queue.writeTexture(
    { texture: texture.value },
    upload,
    { bytesPerRow: 256, rowsPerImage: DIRECT_DFG_LUT_SIZE },
    DIRECT_DFG_LUT_DESCRIPTOR.size,
  );
  if (!written.ok) return fail(written);
  const view = device.createTextureView(texture.value, {
    label: 'standard-direct-dfg-lut-view',
    dimension: '2d',
  });
  if (!view.ok) return fail(view);
  const sampler = device.createSampler({
    label: 'standard-direct-dfg-lut-sampler',
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  if (!sampler.ok) return fail(sampler);
  if (!scope.isAlive()) return fail(stale());
  const lut = { texture: texture.value, view: view.value, sampler: sampler.value };
  luts.set(scope, { device, lut });
  return ok(lut);
}
