import {
  ASSET_ERROR_HINTS,
  AssetError,
  err,
  type MeshAsset,
  ok,
  type Result,
  srgbChannelToLinear,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import {
  deriveVertexCount,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from './vertex-attribute-layout';

/**
 * Return a copy of `mesh` whose every vertex carries one constant linear RGBA
 * `color`. The interleaved buffer is repacked from the canonical attribute map,
 * so layout, bounds and submeshes stay derived from the same source.
 */
export function withVertexColor(
  mesh: MeshAsset,
  rgbaLinear: readonly [number, number, number, number],
): Result<MeshAsset, AssetError> {
  // An inconsistent source buffer surfaces as the packer's vertex-count error.
  const vertexCount =
    deriveVertexCount(mesh.vertices, deriveVertexLayoutProjection(mesh.attributes)) ?? -1;
  const color = new Float32Array(Math.max(0, vertexCount) * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) color.set(rgbaLinear, vertex * 4);
  const attributes: VertexAttributeMap = { ...mesh.attributes, color };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) return packed;
  return ok({ ...mesh, vertices: packed.value.vertices, attributes });
}

export interface WithVertexColorsOptions {
  /** Colour space of the input. `'linear'` (default) matches Three's working space; `'srgb'` decodes RGB (alpha stays linear). */
  readonly space?: 'linear' | 'srgb';
}

function colorsError(expected: string, vertexCount: number, actualLength: number): AssetError {
  return new AssetError({
    code: 'asset-invalid-value',
    expected,
    hint: `${ASSET_ERROR_HINTS['asset-invalid-value']}; pass one RGB (3) or RGBA (4) float triple per vertex, in vertex order`,
    detail: {
      field: 'color',
      reason: 'attribute-cardinality-mismatch',
      vertexCount,
      componentsPerVertex: 3,
      expectedLength: vertexCount * 3,
      actualLength,
    },
  });
}

/**
 * Return a copy of `mesh` with per-vertex colours, the equivalent of Three's
 * `geometry.setAttribute('color', ...)` + `vertexColors`. `colors` holds RGB
 * (3 floats) or RGBA (4 floats) per vertex; RGB gets alpha 1. The interleaved
 * buffer is repacked, so no separate `packInterleavedVertexAttributes` call is
 * needed. Values are linear by default; pass `{ space: 'srgb' }` for hex-like
 * sRGB values (alpha is never decoded).
 */
export function withVertexColors(
  mesh: MeshAsset,
  colors: ArrayLike<number>,
  options: WithVertexColorsOptions = {},
): Result<MeshAsset, AssetError> {
  const position = mesh.attributes.position;
  const vertexCount = position instanceof Float32Array ? position.length / 3 : 0;
  const width = colors.length === vertexCount * 4 ? 4 : 3;
  if (!Number.isInteger(vertexCount) || colors.length !== vertexCount * width) {
    return err(
      colorsError(
        `${vertexCount * 3} (RGB) or ${vertexCount * 4} (RGBA) colour floats for ${vertexCount} vertices, got ${colors.length}`,
        vertexCount,
        colors.length,
      ),
    );
  }
  const decode = options.space === 'srgb' ? srgbChannelToLinear : (value: number) => value;
  const color = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let channel = 0; channel < 3; channel++) {
      color[vertex * 4 + channel] = decode(colors[vertex * width + channel] as number);
    }
    color[vertex * 4 + 3] = width === 4 ? (colors[vertex * 4 + 3] as number) : 1;
  }
  const attributes: VertexAttributeMap = { ...mesh.attributes, color };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) return packed;
  return ok({ ...mesh, vertices: packed.value.vertices, attributes });
}
