import { fnv1aUtf16 } from '@forgeax/engine-types';
// @forgeax/engine-runtime - Vertex attribute layout SSOT (14-key closed set
// to GPUVertexBufferLayout derived function).
//
// deriveVertexBufferLayout(map, opts?) consumes a partial VertexAttributeMap and produces
// a fixed-order array of GPUVertexBufferLayout entries — the single source of
// truth for @location(N) assignment + GPUVertexFormat for every attribute the
// engine pipeline can consume. Shader WGSL @location(N) declarations and
// geometry factories are consumers of this SSOT; naga reflection deep-equal
// tests (T-33 dawn-only) keep them in sync (AC-26 / plan-strategy D-7).
//
// Canonical interleaved order (plan-strategy F-1, must match bridge + import layers):
//   position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7 / color
//
// Key index (plan-strategy D-4 / D-7):
//   0: position   -> @location(0) float32x3
//   1: normal     -> @location(1) float32x3
//   2: uv         -> @location(2) float32x2  (set 0)
//   3: tangent    -> @location(3) float32x4
//   4: skinIndex  -> @location(4) uint16x4
//   5: skinWeight -> @location(5) float32x4
//   6: uv1        -> @location(6) float32x2  (set 1, fea-20260629 D-4)
//   7: uv2        -> @location(7) float32x2  (set 2)
//   8: uv3        -> @location(8) float32x2  (set 3)
//   9: uv4        -> @location(9) float32x2  (set 4)
//  10: uv5        -> @location(10) float32x2 (set 5)
//  11: uv6        -> @location(11) float32x2 (set 6)
//  12: uv7        -> @location(12) float32x2 (set 7)
//  13: color      -> @location(13) float32x4
//  14: tangentFrame -> @location(14) uint32 (replaces normal/tangent)
//
// feat-20260523-skin-skeleton-animation M2 / T-22.
// feat-20260629-multi-uv-set-support m3-w4: uv1..uv7 + clamp-to-last alias (D-1).

import {
  MESH_BIN_SKIN_WEIGHT_UNORM8 as SKIN_WEIGHT_UNORM8,
  MESH_BIN_SKIN_WEIGHT_UNORM16 as SKIN_WEIGHT_UNORM16,
} from '@forgeax/engine-pack/mesh-bin-contract';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  err,
  ok,
  type Result,
  type VertexAttributeMap,
  type VertexAttributePackDetail,
  type VertexAttributeStorage,
} from '@forgeax/engine-types';

const ATTRIBUTE_FORMAT_MAP = {
  position: 'float32x3' as const,
  normal: 'float32x3' as const,
  uv: 'float32x2' as const,
  tangent: 'float32x4' as const,
  skinIndex: 'uint16x4' as const,
  skinWeight: 'float32x4' as const,
  uv1: 'float32x2' as const,
  uv2: 'float32x2' as const,
  uv3: 'float32x2' as const,
  uv4: 'float32x2' as const,
  uv5: 'float32x2' as const,
  uv6: 'float32x2' as const,
  uv7: 'float32x2' as const,
  color: 'float32x4' as const,
  tangentFrame: 'uint32' as const,
} as const;

type AttributeKey = keyof typeof ATTRIBUTE_FORMAT_MAP;
type AttributeFormat = (typeof ATTRIBUTE_FORMAT_MAP)[AttributeKey] | 'unorm8x4' | 'unorm16x4';
const SKIN_WEIGHT_PRESENT = 1 << 5;
const SKIN_WEIGHT_FORMAT_BITS = SKIN_WEIGHT_UNORM8 | SKIN_WEIGHT_UNORM16;

export interface GpuVertexBufferLayoutEntry {
  readonly arrayStride: number;
  readonly attributes: ReadonlyArray<{
    readonly shaderLocation: number;
    readonly offset: number;
    readonly format: string;
  }>;
  readonly stepMode?: 'vertex' | 'instance' | undefined;
}

const isAttributeKey = (key: string): key is AttributeKey => key in ATTRIBUTE_FORMAT_MAP;

export const CANONICAL_KEYS: readonly AttributeKey[] =
  Object.keys(ATTRIBUTE_FORMAT_MAP).filter(isAttributeKey);
const UV_KEYS: readonly AttributeKey[] = CANONICAL_KEYS.filter(
  (key) => key === 'uv' || key.startsWith('uv'),
);

// Empty typed-array values are presence sentinels for layout derivation. Keep
// the common mesh maps here so renderers, recovery, and points/lines cannot
// grow a second copy of the canonical attribute vocabulary.
const EMPTY_FLOAT32 = new Float32Array(0);
const EMPTY_UINT16 = new Uint16Array(0);

/** Canonical position/normal/uv/tangent map for ordinary interleaved meshes. */
export const DEFAULT_VERTEX_ATTRIBUTE_MAP: VertexAttributeMap = Object.freeze({
  position: EMPTY_FLOAT32,
  normal: EMPTY_FLOAT32,
  uv: EMPTY_FLOAT32,
  tangent: EMPTY_FLOAT32,
});

/** Canonical six-attribute map for skinned interleaved meshes. */
export const SKIN_VERTEX_ATTRIBUTE_MAP: VertexAttributeMap = Object.freeze({
  ...DEFAULT_VERTEX_ATTRIBUTE_MAP,
  skinIndex: EMPTY_UINT16,
  skinWeight: EMPTY_FLOAT32,
});

const UV_LOCATIONS = UV_KEYS.map((key) => CANONICAL_KEYS.indexOf(key));
const COLOR_BIT = 1 << CANONICAL_KEYS.indexOf('color');

interface CanonicalVertexInputs {
  readonly projection: VertexLayoutProjection;
  readonly uvMask: number;
  readonly uvSource: VertexLayoutProjectionAttribute | undefined;
}

/** Static streams share the source attribute roster. A foreign mask alone proves nothing. */
function canonicalInputs(
  mask: number,
  attributes: VertexLayoutProjection['attributes'],
): CanonicalVertexInputs | undefined {
  const inputs = layoutsByMask.get(mask);
  return inputs !== undefined && inputs.projection.attributes === attributes ? inputs : undefined;
}

export function vertexLayoutHasColor(projection: VertexLayoutProjection): boolean {
  const attributes = projection.attributes;
  const inputs = canonicalInputs(projection.mask, attributes);
  return inputs === undefined
    ? attributes.some((attribute) => attribute.key === 'color')
    : (inputs.projection.mask & COLOR_BIT) !== 0;
}

/** Visit only shader UV inputs supplied by aliasing bytes in an existing physical stream. */
export function visitVertexUvAliases(
  projection: VertexLayoutProjection,
  setCount: number,
  visit: (key: AttributeKey, location: number, stream: number, offset: number) => void,
): void {
  if (!(setCount > 0)) return;
  const attributes = projection.attributes;
  const inputs = canonicalInputs(projection.mask, attributes);
  let source: VertexLayoutProjectionAttribute | undefined;
  let present: number;
  if (inputs !== undefined) {
    present = inputs.uvMask;
    source = inputs.uvSource;
  } else {
    source = attributes[0];
    present = 0;
    for (const attribute of attributes) {
      const index = UV_KEYS.indexOf(attribute.key);
      if (index < 0) continue;
      source = attribute;
      present |= 1 << index;
    }
  }
  const required = (1 << Math.min(Math.ceil(setCount), UV_KEYS.length)) - 1;
  if (source === undefined || (present & required) === required) return;
  const emit = (stream: number, offset: number) => {
    for (let index = 0; index < setCount && index < UV_KEYS.length; index++) {
      const key = UV_KEYS[index];
      if (key !== undefined && !(present & (1 << index)))
        visit(key, UV_LOCATIONS[index] as number, stream, offset);
    }
  };
  if (projection.streams === undefined) {
    if (source.offset + 8 <= projection.arrayStride) emit(0, source.offset);
    return;
  }
  for (let i = 0; i < projection.streams.length; i++) {
    const stream = projection.streams[i];
    const physical = stream?.attributes.find((attribute) => attribute.key === source.key);
    if (physical !== undefined && stream !== undefined && physical.offset + 8 <= stream.arrayStride)
      emit(i, physical.offset);
  }
}

/**
 * Build a non-skin `VertexAttributeMap` carrying exactly `uvSetCount` UV sets
 * (set 0 = `uv`, then `uv1..uv{uvSetCount-1}`). `deriveVertexBufferLayout`
 * reads only key presence, so the zero-length typed-array values are sentinels.
 *
 * feat-20260629-multi-uv-set-support: the forward record stage owns only the
 * mesh's `uvSetCount` (a scalar threaded through MeshGpuHandles), not the
 * original `MeshAsset.attributes` map. It synthesizes the map here so the
 * material PSO's vertex layout includes the real @location(6+) attributes and
 * its stride matches the interleaved buffer (a mesh with 2 real UV sets has a
 * 56 B stride; a 48 B PSO layout against it puts every vertex after the first
 * off-screen). uvSetCount <= 1 yields the canonical 4-attribute single-UV map.
 */
export function buildMeshAttributeMapForUvSets(uvSetCount: number): VertexAttributeMap {
  const map = { ...DEFAULT_VERTEX_ATTRIBUTE_MAP } as unknown as Record<string, Float32Array>;
  for (let set = 1; set < uvSetCount && set < UV_KEYS.length; set++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded index on const array
    map[UV_KEYS[set]!] = new Float32Array(0);
  }
  return map as unknown as VertexAttributeMap;
}

export function deriveVertexBufferLayout(
  map: VertexAttributeMap,
  opts?: { shaderUvSetCount?: number },
): GpuVertexBufferLayoutEntry[] {
  const shaderUvSetCount = opts?.shaderUvSetCount ?? 0;

  return deriveVertexBufferLayoutFromProjection(deriveVertexLayoutProjection(map), {
    shaderUvSetCount,
  });
}

/** Build the GPU descriptor from an immutable projection, adding only shader UV aliases. */
export function deriveVertexBufferLayoutFromProjection(
  projection: VertexLayoutProjection,
  opts?: { shaderUvSetCount?: number },
): GpuVertexBufferLayoutEntry[] {
  if (projection.attributes.length === 0 && projection.streams === undefined) return [];
  const streams = projection.streams ?? [projection];
  const layouts = streams.map((stream) => ({
    arrayStride: stream.arrayStride,
    attributes: stream.attributes.map(({ shaderLocation, offset, format }) => ({
      shaderLocation,
      offset,
      format,
    })),
  }));
  visitVertexUvAliases(
    projection,
    opts?.shaderUvSetCount ?? 0,
    (key, shaderLocation, stream, offset) => {
      layouts[stream]?.attributes.push({
        shaderLocation,
        offset,
        format: ATTRIBUTE_FORMAT_MAP[key],
      });
    },
  );
  if (projection.streams === undefined)
    layouts[0]?.attributes.sort((left, right) => left.shaderLocation - right.shaderLocation);
  return layouts;
}

export interface VertexLayoutProjectionAttribute {
  readonly key: AttributeKey;
  readonly shaderLocation: number;
  readonly offset: number;
  readonly format: AttributeFormat;
  readonly byteLength: number;
}

/** Immutable geometry-owned projection consumed by packers and GPU consumers. */
export interface VertexStreamProjection {
  readonly arrayStride: number;
  readonly attributes: readonly VertexLayoutProjectionAttribute[];
}

export interface VertexLayoutProjection {
  readonly schemaVersion: 1;
  /** GPU streams in binding order. The ordinary attribute table describes the CPU source. */
  readonly streams?: readonly VertexStreamProjection[];
  readonly attributes: readonly VertexLayoutProjectionAttribute[];
  readonly mask: number;
  readonly arrayStride: number;
  readonly digest: string;
}

/**
 * Derive a vertex count from the geometry-owned projection.
 *
 * Every upload, morph write, and draw range must use this same byte-level
 * calculation. Returning `undefined` keeps malformed payloads out of GPU
 * resource construction instead of silently truncating a fractional count.
 */
export function deriveVertexCount(
  vertices: { readonly byteLength: number },
  projection: VertexLayoutProjection,
): number | undefined {
  const stride = projection.arrayStride;
  const byteLength = vertices.byteLength;
  if (
    !Number.isSafeInteger(stride) ||
    stride <= 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength % stride !== 0
  ) {
    return undefined;
  }
  const count = byteLength / stride;
  return Number.isSafeInteger(count) ? count : undefined;
}

function bytesForFormat(format: string): number {
  if (format === 'uint32' || format === 'unorm8x4') return 4;
  if (format === 'uint16x4' || format === 'unorm16x4' || format === 'float32x2') return 8;
  if (format === 'float32x3') return 12;
  return 16;
}

function storageOf(value: unknown): VertexAttributeStorage {
  if (value instanceof ArrayBuffer) return 'array-buffer';
  if (value instanceof Float32Array) return 'float32';
  if (value instanceof Uint8Array) return 'uint8';
  if (value instanceof Uint16Array) return 'uint16';
  if (value instanceof Uint32Array) return 'uint32';
  return 'other';
}

function sourceStorage(format: AttributeFormat): 'float32' | 'uint8' | 'uint16' | 'uint32' {
  switch (format) {
    case 'unorm8x4':
      return 'uint8';
    case 'unorm16x4':
    case 'uint16x4':
      return 'uint16';
    case 'uint32':
      return 'uint32';
    default:
      return 'float32';
  }
}

export type VertexAttributeArray = Float32Array | Uint8Array | Uint16Array | Uint32Array;

export function vertexAttributeArrayType(format: string): {
  new (length: number): VertexAttributeArray;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): VertexAttributeArray;
  readonly BYTES_PER_ELEMENT: number;
} {
  switch (format) {
    case 'unorm8x4':
      return Uint8Array;
    case 'unorm16x4':
    case 'uint16x4':
      return Uint16Array;
    case 'uint32':
      return Uint32Array;
    default:
      return Float32Array;
  }
}

export function elementView(
  value: VertexAttributeMap[AttributeKey],
  format: string,
): VertexAttributeArray | undefined {
  if (value instanceof ArrayBuffer) return new (vertexAttributeArrayType(format))(value);
  if (
    value instanceof Float32Array ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array
  )
    return value;
  return undefined;
}

function fnv1a(input: string): string {
  const hash = fnv1aUtf16(input);
  return `vlp-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// The finite canonical mask is the complete layout identity. Do not key this
// cache by a mesh/map object: authoring maps may change in place.
const layoutsByMask = new Map<number, CanonicalVertexInputs>();

export interface MeshVertexStreamRange {
  readonly offset: number;
  readonly size: number;
}

const staticStreamLayouts = new WeakMap<VertexLayoutProjection, VertexLayoutProjection>();
const detachedLayouts = new WeakSet<VertexLayoutProjection>();

function captureLayoutAttributes(attributes: readonly VertexLayoutProjectionAttribute[]) {
  return Object.freeze(Array.from(attributes, (attribute) => Object.freeze({ ...attribute })));
}

/** Bind physical layout facts to an issued draw. Independently supplied layouts can
 * carry a matching mask while their stream offsets, attributes or digest differ. */
export function captureVertexLayoutProjection(
  source: VertexLayoutProjection,
): VertexLayoutProjection {
  const canonical = layoutsByMask.get(source.mask)?.projection;
  if (
    source === canonical ||
    (canonical !== undefined && source === staticStreamLayouts.get(canonical)) ||
    detachedLayouts.has(source)
  )
    return source;
  const { streams, attributes, ...header } = source;
  const layout = Object.freeze({
    ...header,
    attributes: captureLayoutAttributes(attributes),
    ...(streams === undefined
      ? {}
      : {
          streams: Object.freeze(
            Array.from(streams, (stream) =>
              Object.freeze({
                arrayStride: stream.arrayStride,
                attributes: captureLayoutAttributes(stream.attributes),
              }),
            ),
          ),
        }),
  });
  detachedLayouts.add(layout);
  return layout;
}

function staticStreamSlot(key: AttributeKey): 0 | 1 | 2 | 3 {
  if (key === 'position') return 0;
  if (key === 'color') return 3;
  return UV_KEYS.includes(key) ? 2 : 1;
}

function staticStreamLayout(source: VertexLayoutProjection): VertexLayoutProjection {
  const existing = staticStreamLayouts.get(source);
  if (existing !== undefined) return existing;
  const groups: [
    VertexLayoutProjectionAttribute[],
    VertexLayoutProjectionAttribute[],
    VertexLayoutProjectionAttribute[],
    VertexLayoutProjectionAttribute[],
  ] = [[], [], [], []];
  for (const attribute of source.attributes)
    groups[staticStreamSlot(attribute.key)].push(attribute);
  const streams = groups
    .filter((group) => group.length !== 0)
    .map((group) => {
      let arrayStride = 0;
      const attributes = group.map((attribute) => {
        const offset = arrayStride;
        arrayStride += attribute.byteLength;
        return Object.freeze({ ...attribute, offset });
      });
      return Object.freeze({ arrayStride, attributes: Object.freeze(attributes) });
    });
  const layout = Object.freeze({
    ...source,
    digest: `${source.digest}:static-streams/1`,
    streams: Object.freeze(streams),
  });
  staticStreamLayouts.set(source, layout);
  return layout;
}

/** Position, tangent basis, UV and color ranges share the same word count as canonical rows. */
export function projectStaticMeshVertexStreams(
  sourceLayout: VertexLayoutProjection,
  count: number,
):
  | {
      readonly layout: VertexLayoutProjection;
      readonly ranges: readonly MeshVertexStreamRange[];
    }
  | undefined {
  if (
    sourceLayout.streams !== undefined ||
    sourceLayout.attributes[0]?.key !== 'position' ||
    sourceLayout.attributes.some(({ key }) => key === 'skinIndex' || key === 'skinWeight')
  )
    return undefined;
  if (!Number.isSafeInteger(count) || count <= 0) return undefined;
  const layout = staticStreamLayout(sourceLayout);
  const streams = layout.streams;
  if (streams === undefined || streams.length < 2) return undefined;
  let offset = 0;
  const ranges = streams.map(({ arrayStride }) => {
    const size = arrayStride * count;
    const range = Object.freeze({ offset, size });
    offset += size;
    return range;
  });
  return { layout, ranges: Object.freeze(ranges) };
}

/** Rebuild canonical rows explicitly for consumers that need that physical order. */
export function interleaveStaticMeshVertexStreams(
  vertices: Float32Array,
  sourceLayout: VertexLayoutProjection,
): Float32Array {
  const count = deriveVertexCount(vertices, sourceLayout);
  const physical =
    count === undefined ? undefined : projectStaticMeshVertexStreams(sourceLayout, count);
  const streams = physical?.layout.streams;
  if (count === undefined || streams === undefined || physical === undefined)
    throw new TypeError('Invalid static mesh stream layout');
  const source = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
  const words = new Uint32Array(vertices.length);
  for (const [slot, stream] of streams.entries()) {
    const range = physical.ranges[slot];
    if (range === undefined) throw new Error('Missing static mesh stream range');
    for (const attribute of stream.attributes) {
      const target = sourceLayout.attributes.find(({ key }) => key === attribute.key);
      if (target === undefined) throw new Error('Missing canonical mesh attribute');
      let from = (range.offset + attribute.offset) / 4;
      let to = target.offset / 4;
      const width = attribute.byteLength / 4;
      for (let vertex = 0; vertex < count; vertex++) {
        for (let lane = 0; lane < width; lane++) {
          // biome-ignore lint/style/noNonNullAssertion: the projected count and format bound this read
          words[to + lane] = source[from + lane]!;
        }
        from += stream.arrayStride / 4;
        to += sourceLayout.arrayStride / 4;
      }
    }
  }
  return new Float32Array(words.buffer);
}

/** Project and pack canonical rigid rows, with deferred allocation for residency reuse. */
export function prepareStaticMeshVertexStreams(
  vertices: Float32Array,
  sourceLayout: VertexLayoutProjection,
):
  | {
      readonly layout: VertexLayoutProjection;
      readonly ranges: readonly MeshVertexStreamRange[];
      pack(slot?: number, output?: Uint32Array): Uint32Array;
    }
  | undefined {
  const count = deriveVertexCount(vertices, sourceLayout);
  const physical =
    count === undefined ? undefined : projectStaticMeshVertexStreams(sourceLayout, count);
  if (count === undefined || physical === undefined) return undefined;
  const { layout, ranges } = physical;
  const streams = layout.streams;
  if (streams === undefined) return undefined;
  const copyStream = (
    stream: VertexStreamProjection,
    source: Uint32Array,
    bytes: Uint32Array,
    offset: number,
  ): void => {
    for (const attribute of stream.attributes) {
      const original = sourceLayout.attributes.find(({ key }) => key === attribute.key);
      if (original === undefined)
        throw new Error('Missing source attribute for a static vertex stream');
      let from = original.offset / 4;
      let to = (offset + attribute.offset) / 4;
      const words = attribute.byteLength / 4;
      for (let vertex = 0; vertex < count; vertex++) {
        for (let word = 0; word < words; word++) {
          // biome-ignore lint/style/noNonNullAssertion: count and canonical width bound the input
          bytes[to + word] = source[from + word]!;
        }
        from += sourceLayout.arrayStride / 4;
        to += stream.arrayStride / 4;
      }
    }
  };
  return {
    layout,
    ranges,
    pack(slot, output) {
      if (output?.buffer === vertices.buffer)
        throw new RangeError('Static stream output must not alias its source');
      const source = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
      if (slot !== undefined) {
        const stream = streams[slot];
        if (stream === undefined) throw new RangeError('Missing static mesh vertex stream slot');
        const words = (stream.arrayStride * count) / 4;
        const bytes = output ?? new Uint32Array(words);
        if (bytes.length !== words) throw new RangeError('Invalid static stream output size');
        copyStream(stream, source, bytes, 0);
        return bytes;
      }
      const bytes = output ?? new Uint32Array(vertices.length);
      if (bytes.length !== vertices.length)
        throw new RangeError('Invalid static stream output size');
      for (const [index, stream] of streams.entries()) {
        // biome-ignore lint/style/noNonNullAssertion: each stream owns one range
        copyStream(stream, source, bytes, ranges[index]!.offset);
      }
      return bytes;
    },
  };
}

/** Derive the one canonical immutable layout projection for a vertex map. */
export function deriveVertexLayoutProjection(
  map: Readonly<Partial<Record<keyof VertexAttributeMap, unknown>>>,
): VertexLayoutProjection {
  let mask = 0;
  for (let index = 0; index < CANONICAL_KEYS.length; index += 1) {
    const key = CANONICAL_KEYS[index];
    if (key !== undefined && map[key] !== undefined) mask |= 1 << index;
  }
  if (map.skinWeight instanceof Uint8Array) mask |= SKIN_WEIGHT_UNORM8;
  else if (map.skinWeight instanceof Uint16Array) mask |= SKIN_WEIGHT_UNORM16;
  return layoutFromMask(mask);
}

function layoutFromMask(mask: number): VertexLayoutProjection {
  const cached = layoutsByMask.get(mask);
  if (cached !== undefined) return cached.projection;
  const attributes: VertexLayoutProjectionAttribute[] = [];
  let offset = 0;
  let uvMask = 0;
  let uvSource: VertexLayoutProjectionAttribute | undefined;
  for (let index = 0; index < CANONICAL_KEYS.length; index += 1) {
    const key = CANONICAL_KEYS[index];
    if (key === undefined || (mask & (1 << index)) === 0) continue;
    let format: AttributeFormat = ATTRIBUTE_FORMAT_MAP[key];
    if (key === 'skinWeight') {
      if (mask & SKIN_WEIGHT_UNORM8) format = 'unorm8x4';
      else if (mask & SKIN_WEIGHT_UNORM16) format = 'unorm16x4';
    }
    const byteLength = bytesForFormat(format);
    const attribute = Object.freeze({ key, shaderLocation: index, offset, format, byteLength });
    attributes.push(attribute);
    const uv = UV_KEYS.indexOf(key);
    if (uv >= 0) {
      uvMask |= 1 << uv;
      uvSource = attribute;
    }
    offset += byteLength;
  }
  const digestInput = [
    '1',
    String(mask),
    String(offset),
    ...attributes.map(
      (entry) => `${entry.key},${entry.shaderLocation},${entry.offset},${entry.format}`,
    ),
  ].join('|');
  const projection: VertexLayoutProjection = Object.freeze({
    schemaVersion: 1,
    attributes: Object.freeze(attributes),
    mask,
    arrayStride: offset,
    digest: fnv1a(digestInput),
  });
  layoutsByMask.set(mask, { projection, uvMask, uvSource: uvSource ?? attributes[0] });
  return projection;
}

export interface PackedVertexAttributes {
  readonly projection: VertexLayoutProjection;
  readonly vertices: Float32Array;
}

export class VertexAttributePackError extends AssetError {
  declare readonly detail: VertexAttributePackDetail;

  constructor(detail: VertexAttributePackDetail) {
    super({
      code: 'asset-invalid-value',
      expected: 'canonical vertex attributes with matching storage and cardinality',
      hint: ASSET_ERROR_HINTS['asset-invalid-value'],
      detail,
    });
  }
}

export interface VertexLayoutProjectionMaskError {
  readonly code: 'vertex-layout-mask-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly mask: number;
    readonly knownMask: number;
    readonly unknownMask: number;
    readonly reason: 'empty' | 'unknown-bits' | 'invalid-format';
  };
}

/** Rebuild the canonical projection from a packed wire mask without a second schema. */
export function deriveVertexLayoutProjectionFromMask(
  mask: number,
): Result<VertexLayoutProjection, VertexLayoutProjectionMaskError> {
  const knownMask = ((1 << CANONICAL_KEYS.length) - 1) | SKIN_WEIGHT_FORMAT_BITS;
  const unsignedMask = Number.isInteger(mask) && mask >= 0 ? mask >>> 0 : 0xffffffff;
  const unknownMask = unsignedMask & ~knownMask;
  if (mask === 0) {
    return err({
      code: 'vertex-layout-mask-invalid',
      expected: 'a non-empty canonical vertex attribute mask',
      hint: 're-cook the mesh-bin payload from MeshAsset.attributes',
      detail: { mask, knownMask, unknownMask, reason: 'empty' },
    });
  }
  if (!Number.isInteger(mask) || mask < 0 || unknownMask !== 0) {
    return err({
      code: 'vertex-layout-mask-invalid',
      expected: `a mask using only canonical attribute and format bits (0x${knownMask.toString(16)})`,
      hint: 're-cook the mesh-bin payload from MeshAsset.attributes',
      detail: { mask, knownMask, unknownMask, reason: 'unknown-bits' },
    });
  }
  const weightFormat = unsignedMask & SKIN_WEIGHT_FORMAT_BITS;
  if (
    weightFormat &&
    (!(unsignedMask & SKIN_WEIGHT_PRESENT) || weightFormat === SKIN_WEIGHT_FORMAT_BITS)
  ) {
    return err({
      code: 'vertex-layout-mask-invalid',
      expected: 'one packed weight format on a skinWeight attribute',
      hint: 're-cook the mesh-bin payload from MeshAsset.attributes',
      detail: { mask, knownMask, unknownMask, reason: 'invalid-format' },
    });
  }
  return ok(layoutFromMask(unsignedMask));
}

function nonFiniteColor(source: VertexAttributeArray): VertexAttributePackDetail | undefined {
  for (let elementIndex = 0; elementIndex < source.length; elementIndex += 1) {
    const component = source[elementIndex] as number;
    if (!Number.isFinite(component))
      return {
        field: 'color',
        reason: 'attribute-non-finite',
        elementIndex,
        actual: Number.isNaN(component)
          ? 'nan'
          : component === Number.POSITIVE_INFINITY
            ? 'positive-infinity'
            : 'negative-infinity',
      };
  }
  return undefined;
}

/** Pack tightly-owned attributes into the projection's canonical interleaved bytes. */
export function packInterleavedVertexAttributes(
  map: VertexAttributeMap,
  vertexCount: number,
): Result<PackedVertexAttributes, VertexAttributePackError> {
  const invalid = (detail: VertexAttributePackDetail): Result<never, VertexAttributePackError> =>
    err(new VertexAttributePackError(detail));
  if (map.tangentFrame !== undefined && (map.normal !== undefined || map.tangent !== undefined))
    return invalid({
      field: 'tangentFrame',
      reason: 'attribute-conflict',
      actualKeys: Object.keys(map),
    });
  if (!Number.isInteger(vertexCount) || vertexCount < 0) {
    return invalid({ field: 'vertexCount', reason: 'vertex-count-invalid', actual: vertexCount });
  }
  const projection = deriveVertexLayoutProjection(map);
  if (projection.attributes.length === 0) {
    return invalid({ field: 'attributes', reason: 'attributes-empty', actualCount: 0 });
  }
  const output = new ArrayBuffer(projection.arrayStride * vertexCount);
  const outputFloats = new Float32Array(output);

  for (const entry of projection.attributes) {
    const sourceValue = map[entry.key];
    if (sourceValue === undefined) continue;
    const ArrayType = vertexAttributeArrayType(entry.format);
    const bytesPerComponent = ArrayType.BYTES_PER_ELEMENT;
    const components = entry.byteLength / bytesPerComponent;
    if (sourceValue instanceof ArrayBuffer && sourceValue.byteLength % bytesPerComponent !== 0) {
      return invalid({
        field: entry.key,
        reason: 'attribute-cardinality-mismatch',
        vertexCount,
        componentsPerVertex: components,
        expectedLength: vertexCount * components,
        actualLength: sourceValue.byteLength / bytesPerComponent,
      });
    }
    const source = elementView(sourceValue, entry.format);
    if (
      source === undefined ||
      !(source instanceof ArrayType) ||
      (entry.format === 'uint32' && !(sourceValue instanceof Uint32Array))
    ) {
      return invalid({
        field: entry.key,
        reason: 'attribute-storage-invalid',
        expectedStorage: sourceStorage(entry.format),
        actualStorage: storageOf(sourceValue),
      });
    }
    const expectedLength = vertexCount * components;
    if (source.length !== expectedLength) {
      return invalid({
        field: entry.key,
        reason: 'attribute-cardinality-mismatch',
        vertexCount,
        componentsPerVertex: components,
        expectedLength,
        actualLength: source.length,
      });
    }
    if (entry.key === 'color') {
      const colorFailure = nonFiniteColor(source);
      if (colorFailure !== undefined) return invalid(colorFailure);
    }
    const target = ArrayType === Float32Array ? outputFloats : new ArrayType(output);
    const targetStride = projection.arrayStride / bytesPerComponent;
    let sourceIndex = 0;
    for (
      let base = entry.offset / bytesPerComponent;
      sourceIndex < expectedLength;
      base += targetStride
    ) {
      for (let component = 0; component < components; component += 1)
        target[base + component] = Number(source[sourceIndex++] ?? 0);
    }
  }
  return ok(Object.freeze({ projection, vertices: outputFloats }));
}

const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Copy canonical interleaved bytes to owned attributes; callers validate semantic values. */
export function unpackInterleavedVertexAttributes(
  vertices: Float32Array,
  projection: VertexLayoutProjection,
): VertexAttributeMap | undefined {
  const vertexCount = deriveVertexCount(vertices, projection);
  if (vertexCount === undefined) return undefined;
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const attributes: Record<string, VertexAttributeArray> = {};
  let storageBytes = 0;
  for (const entry of projection.attributes) storageBytes += vertexCount * entry.byteLength;
  const storage = new ArrayBuffer(storageBytes);
  let storageOffset = 0;
  for (const entry of projection.attributes) {
    const ArrayType = vertexAttributeArrayType(entry.format);
    const width = ArrayType.BYTES_PER_ELEMENT;
    const components = entry.byteLength / width;
    const target = new ArrayType(storage, storageOffset, vertexCount * components);
    storageOffset += target.byteLength;
    if (nativeLittleEndian) {
      const values = new ArrayType(
        vertices.buffer,
        vertices.byteOffset,
        vertices.byteLength / width,
      );
      const stride = projection.arrayStride / width;
      let targetIndex = 0;
      for (let base = entry.offset / width; targetIndex < target.length; base += stride) {
        for (let component = 0; component < components; component++)
          target[targetIndex++] = values[base + component] as number;
      }
    } else {
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        for (let component = 0; component < components; component++) {
          const offset = vertex * projection.arrayStride + entry.offset + component * width;
          target[vertex * components + component] =
            ArrayType === Float32Array
              ? view.getFloat32(offset, true)
              : width === 1
                ? view.getUint8(offset)
                : width === 2
                  ? view.getUint16(offset, true)
                  : view.getUint32(offset, true);
        }
      }
    }
    attributes[entry.key] = target;
  }
  return attributes as VertexAttributeMap;
}
