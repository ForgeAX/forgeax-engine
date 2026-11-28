import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import {
  createRustImageBufferFromFloat32,
  createRustPbrSurface,
  generateBrick,
  generateBrushed,
  generatePerlinFbm,
  generateWood,
  generateWorley,
  type PbrLayerOptions,
  type RustImageBuffer,
  type RustPbrSurface,
  type StandardPbrTextureSet,
  type SurfaceBlendModeName,
  type WebGpuDeviceLike,
  WebGpuSurfaceAccelerator,
  type WorleyModeName,
} from '@forgeax/modeling-kernel';
import { type ModelingError, modelingError } from './errors';
import { kernelErrorToModelingError } from './mesh-store-rust';
import { decodeSrgb, packFloat32Texture, type TextureOptions } from './texture';

export type {
  PbrLayerOptions,
  RustImageBuffer,
  RustPbrSurface,
  StandardPbrTextureSet,
  SurfaceBlendModeName,
  WebGpuDeviceLike,
  WorleyModeName,
};

export {
  generateBrick,
  generateBrushed,
  generatePerlinFbm,
  generateWood,
  generateWorley,
  WebGpuSurfaceAccelerator,
};

export interface PbrTextureAssets {
  readonly width: number;
  readonly height: number;
  readonly baseColor: TextureAsset;
  readonly normal: TextureAsset;
  readonly orm: TextureAsset;
  readonly emissive?: TextureAsset;
}

/**
 * Convert a retained Rust `f32` image buffer (1, 3, or 4 channels) into a standard
 * `TextureAsset` with full `mipChain` filtering (`packFloat32Texture`).
 * When `content === 'normal'`, signed `[-1, 1]` tangent-space XYZ values are encoded to `[0, 1]`.
 */
export function rustImageToTextureAsset(
  image: RustImageBuffer,
  options: TextureOptions & { readonly content?: 'color' | 'normal' | 'id' } = {},
): Result<TextureAsset, ModelingError> {
  const view = image.dataView();
  if (!view.ok) return err(kernelErrorToModelingError(view.error));
  const { width, height, channels } = image;
  const texels = width * height;
  const rgba = new Float32Array(texels * 4);
  const src = view.value;
  const content = options.content ?? 'color';
  const signedNormal = content === 'normal';
  for (let i = 0; i < texels; i++) {
    const o = i * 4;
    if (channels === 1) {
      const v = src[i] ?? 0;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 1;
    } else if (channels === 3) {
      const s = i * 3;
      const x = src[s] ?? 0;
      const y = src[s + 1] ?? 0;
      const z = src[s + 2] ?? 0;
      rgba[o] = signedNormal ? x * 0.5 + 0.5 : x;
      rgba[o + 1] = signedNormal ? y * 0.5 + 0.5 : y;
      rgba[o + 2] = signedNormal ? z * 0.5 + 0.5 : z;
      rgba[o + 3] = 1;
    } else {
      const s = i * channels;
      const x = src[s] ?? 0;
      const y = src[s + 1] ?? 0;
      const z = src[s + 2] ?? 0;
      rgba[o] = signedNormal ? x * 0.5 + 0.5 : x;
      rgba[o + 1] = signedNormal ? y * 0.5 + 0.5 : y;
      rgba[o + 2] = signedNormal ? z * 0.5 + 0.5 : z;
      rgba[o + 3] = src[s + 3] ?? 1;
    }
  }
  return packFloat32Texture(width, height, rgba, options, content);
}

/**
 * Upload level 0 of an uncompressed 2D `TextureAsset` (`rgba8unorm`, `rgba8unorm-srgb`, or `r16unorm`)
 * into a Rust WASM `f32` `RustImageBuffer` for `PbrSurfaceStack` composition or filtering.
 */
export function textureAssetToRustImage(
  texture: TextureAsset,
  options: { readonly channels?: 1 | 3 | 4; readonly signedNormal?: boolean } = {},
): Result<RustImageBuffer, ModelingError> {
  if (texture.shape.viewDimension !== '2d' || texture.encoding !== undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'textureAssetToRustImage requires an unencoded 2d TextureAsset',
      ),
    );
  }
  const { width, height } = texture.shape.extent;
  const texels = width * height;
  const channels = options.channels ?? (texture.format === 'r16unorm' ? 1 : 4);
  const signedNormal = options.signedNormal === true;
  const srgb = texture.colorSpace === 'srgb';
  const out = new Float32Array(texels * channels);

  if (texture.format === 'r16unorm') {
    const view = new Uint16Array(texture.data.buffer, texture.data.byteOffset, texels);
    for (let i = 0; i < texels; i++) {
      const v = (view[i] ?? 0) / 65535;
      if (channels === 1) {
        out[i] = v;
      } else {
        out[i * channels] = v;
        out[i * channels + 1] = v;
        out[i * channels + 2] = v;
        if (channels === 4) out[i * 4 + 3] = 1;
      }
    }
  } else {
    const src = texture.data;
    for (let i = 0; i < texels; i++) {
      const r0 = (src[i * 4] ?? 0) / 255;
      const g0 = (src[i * 4 + 1] ?? 0) / 255;
      const b0 = (src[i * 4 + 2] ?? 0) / 255;
      const a0 = (src[i * 4 + 3] ?? 255) / 255;
      const r = signedNormal ? r0 * 2 - 1 : srgb ? decodeSrgb(r0) : r0;
      const g = signedNormal ? g0 * 2 - 1 : srgb ? decodeSrgb(g0) : g0;
      const b = signedNormal ? b0 * 2 - 1 : srgb ? decodeSrgb(b0) : b0;
      if (channels === 1) {
        out[i] = r;
      } else if (channels === 3) {
        out[i * 3] = r;
        out[i * 3 + 1] = g;
        out[i * 3 + 2] = b;
      } else {
        out[i * 4] = r;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = b;
        out[i * 4 + 3] = a0;
      }
    }
  }

  const created = createRustImageBufferFromFloat32(width, height, channels, out);
  return created.ok ? ok(created.value) : err(kernelErrorToModelingError(created.error));
}

function rgba8BytesToLinearFloat32(
  bytes: Uint8Array,
  texels: number,
  decodeSrgbBytes: boolean,
): Float32Array {
  const out = new Float32Array(texels * 4);
  for (let i = 0; i < texels; i++) {
    const o = i * 4;
    const r = (bytes[o] ?? 0) / 255;
    const g = (bytes[o + 1] ?? 0) / 255;
    const b = (bytes[o + 2] ?? 0) / 255;
    const a = (bytes[o + 3] ?? 255) / 255;
    out[o] = decodeSrgbBytes ? decodeSrgb(r) : r;
    out[o + 1] = decodeSrgbBytes ? decodeSrgb(g) : g;
    out[o + 2] = decodeSrgbBytes ? decodeSrgb(b) : b;
    out[o + 3] = a;
  }
  return out;
}

/**
 * Create a Rust WASM f32 PBR layer stack that compiles down to standard 8-bit game PBR textures
 * (`baseColor` sRGB, `normal` linear, `orm` linear R=AO/G=Roughness/B=Metallic, optional `emissive` sRGB).
 */
export function createModelPbrSurface(
  width: number,
  height: number,
): Result<RustPbrSurface, ModelingError> {
  const res = createRustPbrSurface(width, height);
  return res.ok ? ok(res.value) : err(kernelErrorToModelingError(res.error));
}

/**
 * Export a `RustPbrSurface` stack directly into `TextureAsset`s packed with canonical `mipChain`
 * filtering (`srgb` albedo/emissive, unit-renormalized `normal`, linear `orm`).
 */
export function exportPbrTextureAssets(
  surface: RustPbrSurface,
  options: {
    readonly heightNormalStrength?: number;
    readonly mips?: boolean;
    readonly dispose?: boolean;
  } = {},
): Result<PbrTextureAssets, ModelingError> {
  const raw = surface.exportStandardPbr({
    ...(options.heightNormalStrength === undefined
      ? {}
      : { heightNormalStrength: options.heightNormalStrength }),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
  });
  if (!raw.ok) return err(kernelErrorToModelingError(raw.error));
  const { width, height, baseColor, normal, orm, emissive } = raw.value;
  const texels = width * height;
  const mips = options.mips !== false;

  const bcTex = packFloat32Texture(
    width,
    height,
    rgba8BytesToLinearFloat32(baseColor, texels, true),
    { colorSpace: 'srgb', mips },
    'color',
  );
  if (!bcTex.ok) return bcTex;

  const nTex = packFloat32Texture(
    width,
    height,
    rgba8BytesToLinearFloat32(normal, texels, false),
    { colorSpace: 'linear', mips },
    'normal',
  );
  if (!nTex.ok) return nTex;

  const ormTex = packFloat32Texture(
    width,
    height,
    rgba8BytesToLinearFloat32(orm, texels, false),
    { colorSpace: 'linear', mips },
    'color',
  );
  if (!ormTex.ok) return ormTex;

  let emTex: TextureAsset | undefined;
  if (emissive !== undefined) {
    const packedEm = packFloat32Texture(
      width,
      height,
      rgba8BytesToLinearFloat32(emissive, texels, true),
      { colorSpace: 'srgb', mips },
      'color',
    );
    if (!packedEm.ok) return packedEm;
    emTex = packedEm.value;
  }

  return ok({
    width,
    height,
    baseColor: bcTex.value,
    normal: nTex.value,
    orm: ormTex.value,
    ...(emTex === undefined ? {} : { emissive: emTex }),
  });
}
