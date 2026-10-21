import {
  err,
  isValidAssetGuidString,
  ok,
  type Result,
  type TextureAsset,
  type VfxForceField,
} from '@forgeax/engine-types';

export const VFX_FORCE_FIELD_LIMIT = 8;
export const VFX_VECTOR_FIELD_RESOLUTION_LIMIT = 64;
export const VFX_FORCE_FIELD_BYTES_LIMIT = 16 * 1024 * 1024;

export type { VfxForceField } from '@forgeax/engine-types';

export interface VfxForceFieldError {
  readonly code:
    | 'vfx-field-invalid'
    | 'vfx-field-asset-missing'
    | 'vfx-field-payload-invalid'
    | 'vfx-field-capacity-exceeded';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly guid?: string };
}

export function vfxForceFieldFailure(
  code: VfxForceFieldError['code'],
  path: string,
  expected: string,
  guid?: string,
): Result<never, VfxForceFieldError> {
  return err({
    code,
    expected,
    hint: 'repair the authored field or its ordinary texture producer and reload the same GUID',
    detail: { path, ...(guid === undefined ? {} : { guid }) },
  });
}

/** Affine transforms must remain representable and invertible in the GPU f32 ABI. */
export function isVfxFieldTransform(value: unknown): value is readonly number[] | Float32Array {
  if ((!Array.isArray(value) && !(value instanceof Float32Array)) || value.length !== 16)
    return false;
  if (!Array.from(value).every((n) => typeof n === 'number')) return false;
  // WGSL may flush subnormal arithmetic to zero. Admit only normal or zero
  // inputs/intermediates for the shared inverse-basis contract (WGSL 15.7.2).
  const f32 = (n: number): number =>
    n !== 0 && Math.abs(n) < 2 ** -126 ? Number.NaN : Math.fround(n);
  const m = Array.from(value, f32);
  if (!m.every(Number.isFinite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1)
    return false;
  // The shader forms the inverse emitter basis with f32 cross/dot work.
  // A finite double determinant can hide overflow or flush-to-zero there.
  const cross = (a: readonly number[], b: readonly number[]): number[] => [
    f32(f32((a[1] ?? 0) * (b[2] ?? 0)) - f32((a[2] ?? 0) * (b[1] ?? 0))),
    f32(f32((a[2] ?? 0) * (b[0] ?? 0)) - f32((a[0] ?? 0) * (b[2] ?? 0))),
    f32(f32((a[0] ?? 0) * (b[1] ?? 0)) - f32((a[1] ?? 0) * (b[0] ?? 0))),
  ];
  const a = m.slice(0, 3),
    b = m.slice(4, 7),
    c = m.slice(8, 11);
  const rows = [cross(b, c), cross(c, a), cross(a, b)];
  if (!rows.flat().every(Number.isFinite)) return false;
  const determinant =
    (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[6] ?? 0)) -
    (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[2] ?? 0)) +
    (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[5] ?? 0) * (m[2] ?? 0));
  if (!Number.isFinite(f32(determinant)) || Math.abs(determinant) < 1e-8) return false;
  const terms = a.map((value, index) => f32(value * (rows[0]?.[index] ?? 0)));
  const gpuDeterminant = f32(f32((terms[0] ?? 0) + (terms[1] ?? 0)) + (terms[2] ?? 0));
  const inverseDeterminant = f32(1 / gpuDeterminant);
  if (!Number.isFinite(inverseDeterminant) || Math.abs(gpuDeterminant) > 2 ** 126) return false;
  return rows.every((row) => {
    const inverse = row.map((value) => f32(value * inverseDeterminant));
    return (
      inverse.every(Number.isFinite) &&
      Number.isFinite(
        f32(
          -(inverse[0] ?? 0) * (m[12] ?? 0) -
            (inverse[1] ?? 0) * (m[13] ?? 0) -
            (inverse[2] ?? 0) * (m[14] ?? 0),
        ),
      )
    );
  });
}

export function validateVfxForceFields(
  value: unknown,
  path = 'forceFields',
  runtime = false,
): Result<readonly VfxForceField[], VfxForceFieldError> {
  if (!Array.isArray(value) || value.length === 0 || value.length > VFX_FORCE_FIELD_LIMIT)
    return vfxForceFieldFailure('vfx-field-capacity-exceeded', path, '1 through 8 authored fields');
  for (const [index, field] of value.entries()) {
    const at = `${path}[${index}]`;
    if (field === null || typeof field !== 'object' || Array.isArray(field))
      return vfxForceFieldFailure('vfx-field-invalid', at, 'a closed field declaration');
    const keys =
      field.kind === 'vector'
        ? ['kind', 'transform', 'strength', 'attenuation', 'texture', 'sampling']
        : ['kind', 'transform', 'strength', 'attenuation'];
    if (Object.keys(field).some((key) => !keys.includes(key)))
      return vfxForceFieldFailure('vfx-field-invalid', at, 'only supported field properties');
    if (
      !['sphere', 'box', 'vector'].includes(field.kind) ||
      !Array.isArray(field.transform) ||
      !isVfxFieldTransform(field.transform)
    )
      return vfxForceFieldFailure(
        'vfx-field-invalid',
        `${at}.transform`,
        'a finite invertible affine f32 matrix and supported field kind',
      );
    if (
      typeof field.strength !== 'number' ||
      !Number.isFinite(Math.fround(field.strength)) ||
      !Number.isFinite(field.attenuation) ||
      field.attenuation < 0 ||
      field.attenuation > 8
    )
      return vfxForceFieldFailure(
        'vfx-field-invalid',
        at,
        'finite f32 strength and attenuation in [0, 8]',
      );
    if (
      field.kind === 'vector' &&
      (!(
        (runtime &&
          Number.isInteger(field.texture) &&
          field.texture > 0 &&
          field.texture <= 0xffff_ffff) ||
        isValidAssetGuidString(field.texture)
      ) ||
        !['nearest', 'trilinear'].includes(field.sampling))
    )
      return vfxForceFieldFailure(
        'vfx-field-invalid',
        at,
        'an ordinary texture GUID and nearest or trilinear sampling',
      );
  }
  return ok(value as readonly VfxForceField[]);
}

/** Ordinary textures retain their existing identity, codec and catalogue route. */
export function validateVfxVectorFieldTexture(
  texture: TextureAsset,
  guid: string,
): Result<TextureAsset, VfxForceFieldError> {
  return validateVfxVectorFieldRanges(texture, guid);
}

/** Engine-only: ranges require proven unchanged bytes from a validated fixed predecessor. */
export function validateVfxVectorFieldRanges(
  texture: TextureAsset,
  guid: string,
  ranges?: readonly { readonly byteOffset: number; readonly byteLength: number }[],
): Result<TextureAsset, VfxForceFieldError> {
  if (
    texture.kind !== 'texture' ||
    texture.shape?.viewDimension !== '3d' ||
    texture.shape.extent === undefined ||
    texture.shape.extent === null ||
    texture.format !== 'rgba32float' ||
    texture.colorSpace !== 'linear' ||
    texture.mips?.kind !== 'none' ||
    !(texture.data instanceof Uint8Array)
  )
    return vfxForceFieldFailure(
      'vfx-field-payload-invalid',
      'texture',
      'a linear rgba32float 3D texture with no mips',
      guid,
    );
  const { width, height, depth } = texture.shape.extent;
  if (
    ![width, height, depth].every(
      (n) => Number.isInteger(n) && n >= 2 && n <= VFX_VECTOR_FIELD_RESOLUTION_LIMIT,
    )
  )
    return vfxForceFieldFailure(
      'vfx-field-capacity-exceeded',
      'texture.shape.extent',
      'each dimension in [2, 64]',
      guid,
    );
  if (texture.data.byteLength !== width * height * depth * 16)
    return vfxForceFieldFailure(
      'vfx-field-payload-invalid',
      'texture.data',
      'exactly 16 little-endian bytes per voxel',
      guid,
    );
  const data = new DataView(texture.data.buffer, texture.data.byteOffset, texture.data.byteLength);
  for (const range of ranges ?? [{ byteOffset: 0, byteLength: data.byteLength }])
    for (let offset = range.byteOffset; offset < range.byteOffset + range.byteLength; offset += 4)
      if (!Number.isFinite(data.getFloat32(offset, true)))
        return vfxForceFieldFailure(
          'vfx-field-payload-invalid',
          `texture.data[${offset}]`,
          'finite f32 voxel components',
          guid,
        );
  return ok(texture);
}
