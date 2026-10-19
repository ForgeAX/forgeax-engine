import {
  computeTangentVec4,
  packInterleavedVertexAttributes,
  writeNormalPlaneTangent,
} from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import { type MeshAsset, ok, type Result, type VertexAttributeMap } from '@forgeax/engine-types';
import type {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

const WIDTHS = {
  position: 3,
  normal: 3,
  uv: 2,
  uv1: 2,
  uv2: 2,
  uv3: 2,
  uv4: 2,
  uv5: 2,
  uv6: 2,
  uv7: 2,
  tangent: 4,
  color: 4,
} as const;

export function geometryValues(geometry: BufferGeometry, grouped: boolean): unknown[] {
  const values: unknown[] = [
    grouped,
    geometry.drawRange.start,
    geometry.drawRange.count,
    geometry.index,
    geometry.index?.version,
  ];
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    const buffer = 'data' in attribute ? attribute.data : attribute;
    values.push(
      key,
      attribute,
      buffer.array,
      buffer.version,
      attribute.count,
      attribute.itemSize,
      attribute.normalized,
      'offset' in attribute ? attribute.offset : 0,
      'stride' in buffer ? buffer.stride : 0,
    );
  }
  for (const [name, attributes] of Object.entries(geometry.morphAttributes))
    values.push(name, attributes, attributes?.length);
  for (const group of geometry.groups) values.push(group.start, group.count, group.materialIndex);
  return values;
}

export function projectGeometry(
  geometry: BufferGeometry,
  grouped: boolean,
): Result<MeshAsset | undefined, Error> {
  if (
    Object.values(geometry.morphAttributes).some(
      (attributes) => attributes !== undefined && attributes.length > 0,
    )
  )
    return unsupported('BufferGeometry.morphAttributes', geometry.uuid);
  const position = geometry.getAttribute('position');
  if (position === undefined || position.count === 0) return ok(undefined);
  const count = position.count;
  const attributes: VertexAttributeMap = {};
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    if (!(key in WIDTHS)) return unsupported(`BufferGeometry.attributes.${key}`, geometry.uuid);
    const name = key as keyof typeof WIDTHS;
    const width = WIDTHS[name];
    if (
      attribute.count !== count ||
      (attribute.itemSize !== width && !(key === 'color' && attribute.itemSize === 3))
    )
      return invalid(`BufferGeometry.attributes.${key}.itemSize/count`, geometry.uuid);
    const values = new Float32Array(count * width);
    for (let vertex = 0; vertex < count; vertex++) {
      for (let lane = 0; lane < width; lane++) {
        const value =
          lane === 3 && attribute.itemSize === 3 ? 1 : readComponent(attribute, vertex, lane);
        if (!Number.isFinite(value))
          return invalid(`BufferGeometry.attributes.${key}`, geometry.uuid);
        values[vertex * width + lane] = value;
      }
    }
    attributes[name] = values;
  }
  // Preserve the source index order when intersecting groups and drawRange.
  const originalIndex = geometry.index;
  const available = originalIndex?.count ?? count;
  const start = Math.min(available, geometry.drawRange.start);
  const end = Math.min(available, start + geometry.drawRange.count);
  if (![start, end].every((value) => Number.isSafeInteger(value) && value >= 0))
    return invalid('BufferGeometry.drawRange', geometry.uuid);
  if (end <= start) return ok(undefined);
  const ranges = grouped ? geometry.groups : [{ start: 0, count: available, materialIndex: 0 }];
  const indices: number[] = [];
  const submeshes: MeshAsset['submeshes'][number][] = [];
  let slotCount = 1;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      range.start < 0 ||
      !Number.isSafeInteger(range.count) ||
      range.count < 0
    )
      return invalid('BufferGeometry.groups', geometry.uuid);
    const first = Math.max(start, range.start);
    const last = Math.min(end, range.start + range.count);
    const slot = range.materialIndex ?? 0;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > 255)
      return invalid('BufferGeometry.groups.materialIndex', geometry.uuid);
    if (last <= first) continue;
    if ((last - first) % 3 !== 0)
      return unsupported('partial triangle drawRange/group', geometry.uuid);
    const offset = indices.length;
    for (let i = first; i < last; i++) {
      const index = originalIndex?.getX(i) ?? i;
      if (!Number.isInteger(index) || index < 0 || index >= count)
        return invalid('BufferGeometry.index', geometry.uuid);
      indices.push(index);
    }
    submeshes.push({
      indexOffset: offset,
      indexCount: indices.length - offset,
      vertexCount: count,
      topology: 'triangle-list',
      materialSlot: slot,
    });
    slotCount = Math.max(slotCount, slot + 1);
  }
  if (submeshes.length === 0) return ok(undefined);
  if (attributes.normal === undefined)
    return unsupported(
      'BufferGeometry without normals; call computeVertexNormals()',
      geometry.uuid,
    );
  const nativeIndices = count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  // Three supplies zero UVs for absent inputs. Forgeax's canonical material ABI also
  // requires tangents, derived by Geometry's existing kernel without mutating the source.
  if (attributes.uv === undefined) {
    attributes.uv = new Float32Array(count * 2);
    if (attributes.tangent === undefined) {
      const tangents = new Float32Array(count * 4);
      const normals = attributes.normal as Float32Array;
      for (let vertex = 0; vertex < count; vertex++) {
        if (
          !writeNormalPlaneTangent(
            tangents,
            vertex * 4,
            normals[vertex * 3] ?? 0,
            normals[vertex * 3 + 1] ?? 0,
            normals[vertex * 3 + 2] ?? 0,
          )
        )
          return invalid('BufferGeometry.normal', geometry.uuid);
        tangents[vertex * 4 + 3] = 1;
      }
      attributes.tangent = tangents;
    }
  }
  if (attributes.tangent === undefined) {
    const tangents = computeTangentVec4(
      attributes.position as Float32Array,
      attributes.normal as Float32Array,
      attributes.uv as Float32Array,
      nativeIndices,
    );
    if (!tangents.ok) return tangents;
    attributes.tangent = tangents.value;
  }
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) return packed;
  return ok({
    kind: 'mesh',
    vertices: packed.value.vertices,
    attributes,
    indices: nativeIndices,
    aabb: box3.fromPositions(box3.create(), attributes.position as Float32Array),
    submeshes,
    materialSlots: Array.from({ length: slotCount }, (_, slot) => ({
      slotName: `material-${slot}`,
    })),
  });
}

function readComponent(
  attribute: BufferAttribute | InterleavedBufferAttribute,
  vertex: number,
  lane: number,
): number {
  switch (lane) {
    case 0:
      return attribute.getX(vertex);
    case 1:
      return attribute.getY(vertex);
    case 2:
      return attribute.getZ(vertex);
    default:
      return attribute.getW(vertex);
  }
}
