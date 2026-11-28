/** Engine-agnostic vertex attribute vocabulary and raw mesh POD types. */

export type AttributeKey =
  | 'position'
  | 'normal'
  | 'uv'
  | 'tangent'
  | 'skinIndex'
  | 'skinWeight'
  | 'uv1'
  | 'uv2'
  | 'uv3'
  | 'uv4'
  | 'uv5'
  | 'uv6'
  | 'uv7'
  | 'color'
  | 'tangentFrame';

export type AttributeFormat =
  | 'float32x2'
  | 'float32x3'
  | 'float32x4'
  | 'uint16x4'
  | 'unorm8x4'
  | 'unorm16x4'
  | 'uint32';

export type AttributeTypedArray = Float32Array | Uint8Array | Uint16Array | Uint32Array;

export type PrimitiveTopology =
  | 'point-list'
  | 'line-list'
  | 'line-strip'
  | 'triangle-list'
  | 'triangle-strip';

export type OutputMode = 'separate' | 'interleaved' | 'interleaved-with-channels';

export type KernelBackendPolicy = 'auto' | 'rust' | 'ts';

export const CANONICAL_ATTRIBUTE_KEYS: readonly AttributeKey[] = [
  'position',
  'normal',
  'uv',
  'tangent',
  'skinIndex',
  'skinWeight',
  'uv1',
  'uv2',
  'uv3',
  'uv4',
  'uv5',
  'uv6',
  'uv7',
  'color',
  'tangentFrame',
];

export const ATTRIBUTE_FORMATS: readonly AttributeFormat[] = [
  'float32x2',
  'float32x3',
  'float32x4',
  'uint16x4',
  'unorm8x4',
  'unorm16x4',
  'uint32',
];

export const PRIMITIVE_TOPOLOGIES: readonly PrimitiveTopology[] = [
  'point-list',
  'line-list',
  'line-strip',
  'triangle-list',
  'triangle-strip',
];

export function defaultFormatForKey(key: AttributeKey): AttributeFormat {
  switch (key) {
    case 'position':
    case 'normal':
      return 'float32x3';
    case 'uv':
    case 'uv1':
    case 'uv2':
    case 'uv3':
    case 'uv4':
    case 'uv5':
    case 'uv6':
    case 'uv7':
      return 'float32x2';
    case 'tangent':
    case 'skinWeight':
    case 'color':
      return 'float32x4';
    case 'skinIndex':
      return 'uint16x4';
    case 'tangentFrame':
      return 'uint32';
  }
}

export function formatByteLength(format: AttributeFormat): number {
  switch (format) {
    case 'unorm8x4':
    case 'uint32':
      return 4;
    case 'float32x2':
    case 'uint16x4':
    case 'unorm16x4':
      return 8;
    case 'float32x3':
      return 12;
    case 'float32x4':
      return 16;
  }
}

export function formatComponentCount(format: AttributeFormat): number {
  switch (format) {
    case 'uint32':
      return 1;
    case 'float32x2':
      return 2;
    case 'float32x3':
      return 3;
    case 'float32x4':
    case 'uint16x4':
    case 'unorm8x4':
    case 'unorm16x4':
      return 4;
  }
}

export function formatArrayCtor(format: AttributeFormat): {
  new (length: number): AttributeTypedArray;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): AttributeTypedArray;
  readonly BYTES_PER_ELEMENT: number;
} {
  switch (format) {
    case 'unorm8x4':
      return Uint8Array;
    case 'uint16x4':
    case 'unorm16x4':
      return Uint16Array;
    case 'uint32':
      return Uint32Array;
    default:
      return Float32Array;
  }
}

export function inferAttributeFormat(
  key: AttributeKey,
  array: AttributeTypedArray,
): AttributeFormat | undefined {
  if (key === 'skinWeight') {
    if (array instanceof Float32Array) return 'float32x4';
    if (array instanceof Uint8Array) return 'unorm8x4';
    if (array instanceof Uint16Array) return 'unorm16x4';
    return undefined;
  }
  const def = defaultFormatForKey(key);
  const Ctor = formatArrayCtor(def);
  return array instanceof Ctor ? def : undefined;
}

export interface VertexLayoutDeclaration {
  readonly key: AttributeKey;
  readonly format: AttributeFormat;
}

export interface RawSubmesh {
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly topology: PrimitiveTopology;
  readonly materialSlot: number;
}

export type RawAttributeChannels = Partial<Record<AttributeKey, AttributeTypedArray>>;

/** Engine-agnostic mesh output consumed zero-copy by Three.js or ForgeaX adapters. */
export interface RawMeshData {
  readonly backend: 'rust' | 'ts';
  readonly outputMode: OutputMode;
  readonly vertexCount: number;
  readonly arrayStride: number;
  readonly layoutMask: number;
  readonly layout: readonly VertexLayoutDeclaration[];
  /** Present when outputMode is 'interleaved' or 'interleaved-with-channels'. */
  readonly interleaved?: Float32Array;
  /** Present when outputMode is 'separate' or 'interleaved-with-channels'. */
  readonly channels?: RawAttributeChannels;
  readonly indices?: Uint16Array | Uint32Array;
  readonly submeshes: readonly RawSubmesh[];
  readonly materialSlotNames: readonly string[];
  readonly aabb: Float32Array;
}
