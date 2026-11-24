import { type MeshDistanceFieldSurface, ok, type Result } from '@forgeax/engine-types';
import { type DistanceFieldError, distanceFieldFailure } from './distance-field';
import { MAX_DISTANCE_FIELD_BYTES } from './distance-field-bricks';

/** One encoding authority; product codecs derive their version from this value. */
export const MESH_DISTANCE_FIELD_ARTIFACT_VERSION = 5;
export interface SurfaceCounts {
  readonly vertices: number;
  readonly indices: number;
  readonly nodes: number;
  readonly order: number;
}
export function distanceFieldSurfaceCounts(surface: MeshDistanceFieldSurface): SurfaceCounts {
  return {
    vertices: surface.positions.length / 3,
    indices: surface.indices.length,
    nodes: surface.nodes.length / 32,
    order: surface.primitiveOrder.length,
  };
}
type Channel =
  | 'bricks'
  | 'values'
  | 'positions'
  | 'indices'
  | 'triangleSidedness'
  | 'nodes'
  | 'primitiveOrder';
export interface FieldDataRegion {
  readonly name: Channel;
  readonly first: number;
  readonly elements: number;
  readonly stride: number;
}
export interface FieldDataLayout {
  readonly regions: readonly FieldDataRegion[];
  readonly byteLength: number;
}
const validCount = (value: number, maximum: number) =>
  Number.isInteger(value) && value >= 1 && value <= maximum;
function surfaceValid(counts: SurfaceCounts) {
  if (
    !counts ||
    typeof counts !== 'object' ||
    Object.keys(counts).length !== 4 ||
    !Object.keys(counts).every((key) => ['vertices', 'indices', 'nodes', 'order'].includes(key))
  )
    return false;
  return (
    validCount(counts.vertices, 1_048_576) &&
    validCount(counts.indices, 3_145_728) &&
    counts.indices % 3 === 0 &&
    validCount(counts.order, counts.indices / 3) &&
    validCount(counts.nodes, 2 * counts.order - 1)
  );
}
/** All offsets are relative to the aligned payload start. The exact same
 * derivation serves the encoder and the pre-allocation decoder span gate. */
export function distanceFieldDataLayout(
  bricks: number,
  values: number,
  surface?: SurfaceCounts,
): Result<FieldDataLayout, DistanceFieldError> {
  if (
    !validCount(bricks, MAX_DISTANCE_FIELD_BYTES / 4) ||
    !validCount(values, MAX_DISTANCE_FIELD_BYTES / 4) ||
    values < 64 ||
    (surface !== undefined && !surfaceValid(surface))
  )
    return distanceFieldFailure('invalid derived-field channel counts');
  const regions: FieldDataRegion[] = [];
  let cursor = 0;
  const append = (name: Channel, elements: number, stride: number) => {
    cursor = Math.ceil(cursor / 16) * 16;
    regions.push({ name, first: cursor, elements, stride });
    cursor += elements * stride;
  };
  append('bricks', bricks, 4);
  append('values', values, 4);
  if (surface) {
    append('positions', surface.vertices * 3, 4);
    append('indices', surface.indices, 4);
    append('triangleSidedness', Math.ceil(surface.indices / 3 / 32), 4);
    append('nodes', surface.nodes * 32, 1);
    append('primitiveOrder', surface.order, 4);
  }
  cursor = Math.ceil(cursor / 16) * 16;
  return cursor <= MAX_DISTANCE_FIELD_BYTES
    ? ok({ regions, byteLength: cursor })
    : distanceFieldFailure(
        'combined field samples and flat surface exceed existing 32 MiB artifact budget',
        'distance-field-limit',
      );
}

export function readFieldData(bytes: Uint8Array, layout: FieldDataLayout) {
  if (bytes.byteLength !== layout.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    channels = new Map<Channel, Float32Array | Uint32Array | Uint8Array>();
  let previous = 0;
  for (const region of layout.regions) {
    for (let i = previous; i < region.first; i++) if (bytes[i] !== 0) return null;
    const floating = region.name === 'values' || region.name === 'positions';
    const array =
      region.stride === 1
        ? Uint8Array.from(bytes.subarray(region.first, region.first + region.elements))
        : floating
          ? new Float32Array(region.elements)
          : new Uint32Array(region.elements);
    if (region.stride !== 1)
      for (let i = 0; i < region.elements; i++)
        array[i] = floating
          ? view.getFloat32(region.first + i * 4, true)
          : view.getUint32(region.first + i * 4, true);
    channels.set(region.name, array);
    previous = region.first + region.elements * region.stride;
  }
  for (let i = previous; i < bytes.length; i++) if (bytes[i] !== 0) return null;
  return channels;
}

export function writeFieldData(
  bytes: Uint8Array,
  layout: FieldDataLayout,
  channels: ReadonlyMap<string, ArrayLike<number>>,
): boolean {
  if (bytes.byteLength !== layout.byteLength) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const region of layout.regions) {
    const source = channels.get(region.name);
    if (!source || source.length !== region.elements) return false;
    for (let i = 0; i < region.elements; i++) {
      const value = source[i];
      if (value === undefined) return false;
      if (region.stride === 1) view.setUint8(region.first + i, value);
      else if (region.name === 'values' || region.name === 'positions')
        view.setFloat32(region.first + i * 4, value, true);
      else view.setUint32(region.first + i * 4, value, true);
    }
  }
  return true;
}
