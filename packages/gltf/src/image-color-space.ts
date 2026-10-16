// image-color-space.ts - sRGB / linear classifier for glTF images
// (feat-20260608 M3 D-3 / requirements AC-08 + AC-13 + C-3).
//
// glTF 2.0 spec section 6.2 ("Material → Texture and Sampler") names which
// texture slots are colour-encoded vs data-encoded:
//   - sRGB    : baseColorTexture, emissiveTexture, sheenColorTexture,
//               specularColorTexture, diffuseTransmissionColorTexture
//   - linear  : metallicRoughnessTexture, normalTexture, occlusionTexture,
//               transmission/volume/clearcoat/anisotropy/sheen-roughness/
//               iridescence/specular-weight/diffuse-transmission data textures
// We pre-scan the doc so the gltfImporter knows each `images[]` row's
// colorSpace before decoding (TextureAsset.colorSpace + .format derive
// from this).
//
// Conflict resolution (requirements section 8 edge cases): when the same
// glTF image is bound to multiple textures whose colour expectations
// disagree, sRGB wins. baseColor leakage into a normal slot is far worse
// than the inverse, and bevy_gltf takes the same stance (knowledge-base /
// research finding §5.6).
//
// Orphan images (declared in `images[]` but unreferenced by any
// `textures[]` entry) default to linear (no colour-encoded purpose
// inferable; AC-13).
//
// Pure function, no I/O. Input = the parts of the parsed GltfDoc that
// matter (images count, textures, materials); output = a Map keyed by
// the image array index.

export type ImageColorSpaceSrgbOrLinear = 'srgb' | 'linear';

type TextureBinding = number | { readonly texture: number };

/** Slim view of a parsed material the classifier reads (subset of MaterialIr). */
export interface MaterialColorSpaceInput {
  readonly baseColorTexture?: TextureBinding;
  readonly metallicRoughnessTexture?: TextureBinding;
  readonly normalTexture?: TextureBinding;
  readonly emissiveTexture?: TextureBinding;
  readonly occlusionTexture?: TextureBinding;
  readonly transmissionTexture?: TextureBinding;
  readonly thicknessTexture?: TextureBinding;
  readonly clearcoatTexture?: TextureBinding;
  readonly clearcoatRoughnessTexture?: TextureBinding;
  readonly clearcoatNormalTexture?: TextureBinding;
  readonly anisotropyTexture?: TextureBinding;
  readonly sheenColorTexture?: TextureBinding;
  readonly sheenRoughnessTexture?: TextureBinding;
  readonly iridescenceTexture?: TextureBinding;
  readonly iridescenceThicknessTexture?: TextureBinding;
  readonly specularTexture?: TextureBinding;
  readonly specularColorTexture?: TextureBinding;
  readonly diffuseTransmissionTexture?: TextureBinding;
  readonly diffuseTransmissionColorTexture?: TextureBinding;
}

/** Slim view of a parsed `textures[]` row. */
export interface TextureColorSpaceInput {
  readonly source: number;
}

/**
 * Inputs for {@link deriveTextureColorSpace}: just the parts of the parsed
 * doc that the classifier reads. Decoupled from `GltfDoc` so the helper is
 * trivially testable without building a full doc.
 */
export interface DeriveTextureColorSpaceInput {
  readonly imageCount: number;
  readonly textures: readonly TextureColorSpaceInput[] | undefined;
  readonly materials: readonly MaterialColorSpaceInput[];
}

/**
 * Walk the materials, follow each texture-slot binding back to the image
 * it references, and produce `Map<imageIndex, 'srgb' | 'linear'>`. Slots
 * disagreeing on the same image resolve to sRGB (see module header for
 * the rationale). Orphan images default to linear.
 */
export function deriveTextureColorSpace(
  input: DeriveTextureColorSpaceInput,
): Map<number, ImageColorSpaceSrgbOrLinear> {
  const result = new Map<number, ImageColorSpaceSrgbOrLinear>();
  const textures = input.textures ?? [];

  function imageOfTexture(binding: TextureBinding | undefined): number | undefined {
    if (binding === undefined) return undefined;
    const textureIndex = typeof binding === 'number' ? binding : binding.texture;
    const tex = textures[textureIndex];
    if (tex === undefined) return undefined;
    return tex.source;
  }

  function record(imageIndex: number | undefined, colorSpace: ImageColorSpaceSrgbOrLinear): void {
    if (imageIndex === undefined) return;
    const prior = result.get(imageIndex);
    if (prior === undefined) {
      result.set(imageIndex, colorSpace);
      return;
    }
    if (prior === 'srgb' || colorSpace === 'srgb') {
      result.set(imageIndex, 'srgb');
    }
  }

  for (const mat of input.materials) {
    record(imageOfTexture(mat.baseColorTexture), 'srgb');
    record(imageOfTexture(mat.emissiveTexture), 'srgb');
    record(imageOfTexture(mat.sheenColorTexture), 'srgb');
    record(imageOfTexture(mat.specularColorTexture), 'srgb');
    record(imageOfTexture(mat.diffuseTransmissionColorTexture), 'srgb');
    record(imageOfTexture(mat.metallicRoughnessTexture), 'linear');
    record(imageOfTexture(mat.normalTexture), 'linear');
    record(imageOfTexture(mat.occlusionTexture), 'linear');
    record(imageOfTexture(mat.transmissionTexture), 'linear');
    record(imageOfTexture(mat.thicknessTexture), 'linear');
    record(imageOfTexture(mat.clearcoatTexture), 'linear');
    record(imageOfTexture(mat.clearcoatRoughnessTexture), 'linear');
    record(imageOfTexture(mat.clearcoatNormalTexture), 'linear');
    record(imageOfTexture(mat.anisotropyTexture), 'linear');
    record(imageOfTexture(mat.sheenRoughnessTexture), 'linear');
    record(imageOfTexture(mat.iridescenceTexture), 'linear');
    record(imageOfTexture(mat.iridescenceThicknessTexture), 'linear');
    record(imageOfTexture(mat.specularTexture), 'linear');
    record(imageOfTexture(mat.diffuseTransmissionTexture), 'linear');
  }

  for (let i = 0; i < input.imageCount; i++) {
    if (!result.has(i)) {
      result.set(i, 'linear');
    }
  }

  return result;
}
