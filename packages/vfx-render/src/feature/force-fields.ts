import { mat4 } from '@forgeax/engine-math';
import { ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import {
  VFX_FORCE_FIELD_BYTES_LIMIT,
  type VfxForceField,
  type VfxForceFieldError,
  validateVfxForceFields,
  validateVfxVectorFieldTexture,
  vfxForceFieldFailure,
} from '@forgeax/engine-vfx';

export interface PreparedVfxForceFields {
  readonly revision: number;
  readonly data: Float32Array;
}

/** CPU asset preparation only; Render's existing generation/fence owner uploads it. */
export function createVfxForceFieldPreparation() {
  const validated = new WeakMap<TextureAsset, Result<TextureAsset, VfxForceFieldError>>();
  const cache = new WeakMap<
    readonly VfxForceField[],
    {
      readonly textures: readonly TextureAsset[];
      readonly value: PreparedVfxForceFields;
    }
  >();
  let revision = 0;
  return (
    fields: readonly VfxForceField[],
    textures: ReadonlyMap<string, TextureAsset>,
  ): Result<PreparedVfxForceFields, VfxForceFieldError> => {
    const declarations = validateVfxForceFields(fields);
    if (!declarations.ok) return declarations;
    const sources: TextureAsset[] = [];
    let vectors = 1 + fields.length * 10;
    for (const field of fields) {
      if (field.kind !== 'vector') continue;
      const texture = textures.get(field.texture);
      if (texture === undefined)
        return vfxForceFieldFailure(
          'vfx-field-asset-missing',
          'forceFields.texture',
          'a loaded ordinary texture GUID',
          field.texture,
        );
      let checked = validated.get(texture);
      if (checked === undefined) {
        checked = validateVfxVectorFieldTexture(texture, field.texture);
        validated.set(texture, checked);
      }
      if (!checked.ok) return checked;
      sources.push(texture);
      vectors += texture.data.byteLength / 16;
    }
    if (vectors * 16 > VFX_FORCE_FIELD_BYTES_LIMIT)
      return vfxForceFieldFailure(
        'vfx-field-capacity-exceeded',
        'forceFields',
        'at most 16 MiB including metadata per emitter',
      );
    const previous = cache.get(fields);
    if (
      previous !== undefined &&
      previous.textures.length === sources.length &&
      sources.every((texture, index) => texture === previous.textures[index])
    )
      return ok(previous.value);
    const data = new Float32Array(vectors * 4);
    data[0] = fields.length;
    let sampleOffset = 1 + fields.length * 10;
    for (const [index, field] of fields.entries()) {
      const at = (1 + index * 10) * 4;
      const transform = new Float32Array(field.transform);
      const inverse = mat4.invert(mat4.create(), transform);
      if (!Array.from(inverse).every(Number.isFinite))
        return vfxForceFieldFailure(
          'vfx-field-invalid',
          `forceFields[${index}].transform`,
          'a finite inverse matrix',
        );
      data.set(inverse, at);
      data.set(transform, at + 16);
      data.set(
        [
          field.kind === 'sphere' ? 0 : field.kind === 'box' ? 1 : 2,
          field.strength,
          field.attenuation,
          field.kind === 'vector' && field.sampling === 'trilinear' ? 1 : 0,
        ],
        at + 32,
      );
      if (field.kind === 'vector') {
        const texture = textures.get(field.texture);
        if (texture === undefined)
          return vfxForceFieldFailure(
            'vfx-field-asset-missing',
            'forceFields.texture',
            'a loaded texture',
            field.texture,
          );
        if (texture.shape.viewDimension !== '3d') continue;
        const { width, height, depth } = texture.shape.extent;
        data.set([width, height, depth, sampleOffset], at + 36);
        const bytes = new DataView(
          texture.data.buffer,
          texture.data.byteOffset,
          texture.data.byteLength,
        );
        for (let offset = 0; offset < bytes.byteLength; offset += 4)
          data[sampleOffset * 4 + offset / 4] = bytes.getFloat32(offset, true);
        sampleOffset += bytes.byteLength / 16;
      }
    }
    const value = { revision: revision++, data };
    cache.set(fields, { textures: sources, value });
    return ok(value);
  };
}
