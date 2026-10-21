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

import {
  GLTF_MATERIAL_TEXTURE_SLOTS,
  type GltfMaterialIr,
  type GltfMaterialTextureSlot,
  materialTextureBinding,
} from './material/parse-material.js';

type ImageColorSpaceSrgbOrLinear = (typeof GLTF_MATERIAL_TEXTURE_SLOTS)[number]['colorSpace'];

/** The classifier consumes the same material slots as reference publication. */
type MaterialColorSpaceInput = Pick<GltfMaterialIr, GltfMaterialTextureSlot>;

/** Slim view of a parsed `textures[]` row. */
interface TextureColorSpaceInput {
  readonly source: number;
}

/**
 * Inputs for {@link deriveTextureColorSpace}: just the parts of the parsed
 * doc that the classifier reads. Decoupled from `GltfDoc` so the helper is
 * trivially testable without building a full doc.
 */
interface DeriveTextureColorSpaceInput {
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

  function imageOfTexture(binding: GltfMaterialIr['baseColorTexture']): number | undefined {
    const info = materialTextureBinding(binding);
    if (info === undefined) return undefined;
    const tex = textures[info.texture];
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
    for (const { slot, colorSpace } of GLTF_MATERIAL_TEXTURE_SLOTS) {
      record(imageOfTexture(mat[slot]), colorSpace);
    }
  }

  for (let i = 0; i < input.imageCount; i++) {
    if (!result.has(i)) {
      result.set(i, 'linear');
    }
  }

  return result;
}
