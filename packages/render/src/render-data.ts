// @forgeax/engine-runtime - RenderData projection layer
// (feat-20260601-device/gpu-residency-extraction M2 / w5).
//
// The middle of the three GPU-asset layers: AssetRegistry catalogues CPU asset
// POD; `deriveRenderData*` PROJECTS a POD into the GPU descriptor a resource
// build needs; GpuResidencyCache owns device-side resource life/death. These
// projections are PURE -- they know the asset `kind` but never touch a device
// (AC-07). The store consumes the descriptor and does the createTexture /
// createBuffer / writeX work.
//
// Coverage is exactly the three GPU-resource kinds (mesh / texture / equirect,
// the latter projected to a cubemap). Asset kinds with no GPU residency are
// never projected -- the
// `ensureResident` miss switch dispatches per-kind with no default, so a fourth
// GPU-resource kind would surface as a `tsc -b` exhaustiveness error at the
// switch rather than a silent fallthrough (AC-06).

import {
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  deriveTextureLayout,
  isCompressedFormat,
  type MeshAsset,
  type Submesh,
  type TextureAsset,
  type TextureShape,
  textureFormatBlock,
} from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from './gpu-usage';

/** Descriptor for a mesh's GPU vertex + index buffers (projected from POD). */
export interface MeshRenderData {
  readonly vertexByteLength: number;
  /** Geometry-owned immutable layout facts used by all GPU consumers. */
  readonly layoutProjection: VertexLayoutProjection;
  /** Index byte length padded up to a 4-byte multiple (writeBuffer alignment). */
  readonly indexByteLength: number;
  readonly indexCount: number;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly vertexUsage: number;
  readonly indexUsage: number;
  /**
   * Submeshes from the source MeshAsset, projected verbatim to the GPU store
   * so the record stage can iterate per-submesh draw calls (feat-20260608 M4 / w16).
   * Mirrors MeshAsset.submeshes (readonly Submesh[]) 1:1.
   */
  readonly submeshes: readonly Submesh[];
}

/** Descriptor for a sampled texture's GPU resource (projected from POD). */
export interface TextureRenderData {
  /** Logical width retained for existing projection consumers. */
  readonly width: number;
  /** Logical height retained for existing projection consumers. */
  readonly height: number;
  /** Authored shape; the residency layer must preserve this view dimension. */
  readonly shape: TextureShape;
  /** Array layers for `2d-array`, depth slices for `3d`, otherwise one. */
  readonly depthOrArrayLayers: number;
  /** Authored content extent; TextureAsset remains the logical asset SSOT. */
  readonly logicalExtent: TextureExtent;
  /** GPU allocation extent, derived from format + logicalExtent. */
  readonly physicalExtent: TextureExtent;
  /** Maps logical UVs away from block padding. */
  readonly uvScale: readonly [number, number];
  readonly format: GPUTextureFormat;
  readonly mipLevelCount: number;
  readonly usage: number;
  /**
   * Row pitch for the BASE mip (level 0) the store passes to `writeTexture`.
   * Derived from the canonical texture layout, so format-specific uncompressed
   * widths (for example R8 density) and block-compressed widths stay aligned
   * with the upload contract.
   */
  readonly bytesPerRow: number;
  /** True iff `format` is a block-compressed format (drives the store's upload arm). */
  readonly compressed: boolean;
}

export interface TextureExtent {
  readonly width: number;
  readonly height: number;
}

function physicalTextureDimension(logical: number, block: number): number {
  return Math.ceil(logical / block) * block;
}

/** Material packing needs only this scale, without GPU allocation descriptors. */
export function deriveTextureUvScale(
  format: GPUTextureFormat,
  width: number,
  height: number,
): readonly [number, number] {
  const { blockWidth, blockHeight } = textureFormatBlock(format);
  return [
    width / physicalTextureDimension(width, blockWidth),
    height / physicalTextureDimension(height, blockHeight),
  ];
}

/**
 * The sole logical-content to physical-storage projection for a texture.
 * Block sizes come from the texture format block table; no physical dimensions are
 * authored or serialized with TextureAsset.
 */
export function deriveTextureExtent(
  format: GPUTextureFormat,
  width: number,
  height: number,
): {
  readonly logicalExtent: TextureExtent;
  readonly physicalExtent: TextureExtent;
  readonly uvScale: readonly [number, number];
} {
  const { blockWidth, blockHeight } = textureFormatBlock(format);
  const physicalWidth = physicalTextureDimension(width, blockWidth);
  const physicalHeight = physicalTextureDimension(height, blockHeight);
  return {
    logicalExtent: { width, height },
    physicalExtent: { width: physicalWidth, height: physicalHeight },
    uvScale: [width / physicalWidth, height / physicalHeight],
  };
}

/** Descriptor for a cubemap built from an equirect source (projected from POD). */
export interface CubeRenderData {
  /** Square cube face edge length (== source equirect height). */
  readonly cubeFaceSize: number;
  /** Filterable output format the IBL pipeline BGL expects. */
  readonly outputFormat: 'rgba16float';
  /** True when the source is rgba32float and the store must pack to rgba16float. */
  readonly needsHalfConversion: boolean;
  readonly cubeUsage: number;
}

/**
 * Project a `MeshAsset` POD into its GPU vertex / index buffer descriptor.
 * Pure: computes byte lengths, the 4-byte-aligned index size, index format,
 * and the buffer usage flags the store's `createBuffer` calls need.
 */
export function deriveRenderDataMesh(mesh: MeshAsset): Result<MeshRenderData, AssetError> {
  // Vertex-only meshes (no `indices`) take the non-indexed draw path. Their
  // index-side fields are zeroed; `indexFormat` keeps a `'uint16'` placeholder
  // (never consumed when no index buffer is built).
  const indices = mesh.indices;
  const indexBytesUnpadded = indices === undefined ? 0 : indices.byteLength;
  const indexByteLength = ((indexBytesUnpadded + 3) >> 2) << 2;
  const layoutProjection = deriveVertexLayoutProjection(mesh.attributes);
  return ok({
    vertexByteLength: mesh.vertices.byteLength,
    layoutProjection,
    indexByteLength,
    indexCount: indices === undefined ? 0 : indices.length,
    indexFormat: indices instanceof Uint32Array ? 'uint32' : 'uint16',
    vertexUsage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    indexUsage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    submeshes: mesh.submeshes,
  });
}

/**
 * Project a `TextureAsset` POD into its GPU texture descriptor. Pure: derives
 * the mip-level count (when `mipmap`), the row pitch, and the usage flags, and
 * fails fast if the POD's `format` and `colorSpace` are internally
 * inconsistent (a `-srgb` format requires an `srgb` colorSpace and vice versa).
 */
export function deriveRenderDataTexture(tex: TextureAsset): Result<TextureRenderData, AssetError> {
  const width = tex.shape.extent.width;
  const height = tex.shape.extent.height;
  const isSrgbFormat = tex.format.endsWith('-srgb');
  const expectedColorSpace: 'srgb' | 'linear' = isSrgbFormat ? 'srgb' : 'linear';
  if (tex.colorSpace !== expectedColorSpace) {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: "format ends in '-srgb' iff colorSpace is 'srgb' (linear otherwise)",
        hint: `colorSpace '${tex.colorSpace}' does not match format '${tex.format}'; author sRGB color data as a '-srgb' format with colorSpace 'srgb', and data textures (normals, masks) as a linear format with colorSpace 'linear'`,
      }),
    );
  }

  const compressed = isCompressedFormat(tex.format);
  const layout = deriveTextureLayout({ shape: tex.shape, format: tex.format, mips: tex.mips });
  if (!layout.ok) {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: layout.error.expected,
        hint: layout.error.hint,
      }),
    );
  }
  // feat-20260707 M5 / w35 (AC-09, D-9): a block-compressed texture cannot have
  // its mips GPU-generated (F-7). An OFFLINE chain baked into `data`
  // (mipLevelCount > 1, e.g. a KTX2 level chain) is the normal compressed path
  // and passes; requesting RUNTIME mip generation (`mipmap:true` with no offline
  // chain) fails fast with a self-recovery hint (fail-fast at the projection
  // layer -- producer self-validate).
  if (compressed && tex.mips.kind === 'generate') {
    return err(
      new AssetError({
        code: 'mipgen-unsupported-compressed-format',
        expected:
          'a compressed texture requesting mipmap:true must carry an offline mip chain (mipLevelCount > 1)',
        hint: ASSET_ERROR_HINTS['mipgen-unsupported-compressed-format'],
      }),
    );
  }

  // Uncompressed: runtime mip-gen count from the pixel size. Compressed: the
  // level count is authored (offline chain) -- honour the POD's mipLevelCount,
  // never re-derive it from the size (a compressed chain may stop early).
  const mipLevelCount = layout.value.levels.length;

  const baseLevel = layout.value.levels[0];
  if (baseLevel === undefined) {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: 'texture layout contains a base mip level',
        hint: ASSET_ERROR_HINTS['invalid-source-format'],
      }),
    );
  }
  if (!compressed && tex.data.byteLength < baseLevel.byteLength) {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: 'uncompressed texture data contains at least one complete base mip',
        hint: ASSET_ERROR_HINTS['invalid-source-format'],
      }),
    );
  }

  // Row pitch derives from the format's block, not aggregate payload length:
  // imported images may retain trailing decoder bytes and offline mip chains
  // contain more than the base mip.
  const bytesPerRow = baseLevel.bytesPerRow;

  // Compressed formats are not renderable -- RENDER_ATTACHMENT would fail
  // createTexture validation, and the runtime mipmap blit (which copies each
  // level in through COPY_DST) never runs on a compressed texture anyway (the
  // mip gate above rules out runtime mip-gen). Both paths keep COPY_SRC so a real consumer can validate the
  // uploaded texture through the standard GPU readback contract.
  const usage = compressed
    ? GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_COPY_SRC
    : GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_DST |
      GPU_TEXTURE_USAGE_COPY_SRC;

  return ok({
    width,
    height,
    shape: tex.shape,
    depthOrArrayLayers:
      tex.shape.viewDimension === '2d'
        ? 1
        : tex.shape.viewDimension === '2d-array'
          ? tex.shape.extent.layers
          : tex.shape.extent.depth,
    ...deriveTextureExtent(tex.format, width, height),
    format: tex.format,
    mipLevelCount,
    usage,
    bytesPerRow,
    compressed,
  });
}

/**
 * Project an equirectangular HDR `TextureAsset` source into its cubemap
 * descriptor. Pure: validates the source is a linear HDR format, computes the
 * square cube face size (== source height), narrows the output to the filterable
 * `rgba16float` the IBL pipeline expects, and flags whether the store must pack
 * an rgba32float source down to rgba16float. The store keeps the resource build
 * (createTexture / cube + face views / IBL precompute) and the rgba32f->rgba16f
 * byte conversion.
 *
 * feat-20260707 M5 fix: the accepted-format whitelist is `rgba16float |
 * rgba32float` only -- a block-compressed HDR format (`bc6h-rgb-ufloat`) is NOT
 * accepted here. An equirect cube source drives equirect-to-cube / irradiance /
 * prefilter RENDER passes, and a BC6H texture is sample-only, never a color-
 * renderable render target ("BC6HRGBUfloat is not color renderable"). The
 * equirect is therefore always delivered uncompressed rgba16float; this
 * fail-fast whitelist is the projection-layer guard that rejects a non-
 * renderable cube source rather than letting it blow up at GPU createTexture.
 */
export function deriveRenderDataCubemap(source: TextureAsset): Result<CubeRenderData, AssetError> {
  const isAcceptedHdr = source.format === 'rgba16float' || source.format === 'rgba32float';
  if (!isAcceptedHdr || source.colorSpace !== 'linear') {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: "format 'rgba16float' or 'rgba32float' with colorSpace 'linear'",
        hint: ASSET_ERROR_HINTS['invalid-source-format'],
      }),
    );
  }
  const sourceHeight = source.shape.viewDimension === '2d' ? source.shape.extent.height : 0;
  return ok({
    cubeFaceSize: sourceHeight,
    outputFormat: 'rgba16float',
    needsHalfConversion: source.format === 'rgba32float',
    cubeUsage:
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_DST |
      GPU_TEXTURE_USAGE_COPY_SRC,
  });
}
