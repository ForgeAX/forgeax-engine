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
  skinIndex: 4,
  skinWeight: 4,
} as const;

export interface GeometryMaterial {
  readonly slot: number;
  readonly vertexColors: boolean;
}

export function geometryValues(geometry: BufferGeometry, grouped: boolean): unknown[] {
  const values: unknown[] = [
    grouped,
    geometry.drawRange.start,
    geometry.drawRange.count,
    geometry.index,
    geometry.index?.version,
  ];
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    if (!Object.hasOwn(WIDTHS, key)) continue;
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
  values.push(geometry.morphTargetsRelative);
  for (const [name, attributes] of Object.entries(geometry.morphAttributes)) {
    values.push(name, attributes?.length);
    for (const attribute of attributes ?? []) {
      const buffer = 'data' in attribute ? attribute.data : attribute;
      values.push(
        attribute,
        buffer.array,
        buffer.version,
        attribute.count,
        attribute.itemSize,
        attribute.normalized,
      );
    }
  }
  for (const group of geometry.groups) values.push(group.start, group.count, group.materialIndex);
  return values;
}

export function projectGeometry(
  geometry: BufferGeometry,
  grouped: boolean,
  materials?: readonly GeometryMaterial[],
  topology: 'triangle-list' | 'point-list' | 'line-list' | 'line-strip' = 'triangle-list',
  projectedUvs: Readonly<Record<string, Float32Array>> = {},
  wireframe = false,
): Result<MeshAsset | undefined, Error> {
  const position = geometry.getAttribute('position');
  if (position === undefined || position.count === 0) return ok(undefined);
  const sourceCount = position.count;
  const useColor =
    geometry.hasAttribute('color') && (materials?.some((m) => m.vertexColors) ?? true);
  const mixedColor = useColor && materials?.some((m) => !m.vertexColors) === true;
  const count = sourceCount * (mixedColor ? 2 : 1);
  const attributes: VertexAttributeMap = {};
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    // Ordinary Three materials ignore application attributes they never read.
    if (!Object.hasOwn(WIDTHS, key) || (key === 'color' && !useColor)) continue;
    const name = key as keyof typeof WIDTHS;
    const width = WIDTHS[name];
    if (
      attribute.count !== sourceCount ||
      (attribute.itemSize !== width && !(key === 'color' && attribute.itemSize === 3))
    )
      return invalid(`BufferGeometry.attributes.${key}.itemSize/count`, geometry.uuid);
    const values =
      name === 'skinIndex' ? new Uint16Array(count * width) : new Float32Array(count * width);
    for (let vertex = 0; vertex < count; vertex++) {
      for (let lane = 0; lane < width; lane++) {
        const value =
          (key === 'color' && vertex >= sourceCount) || (lane === 3 && attribute.itemSize === 3)
            ? 1
            : readComponent(attribute, vertex % sourceCount, lane);
        if (
          !Number.isFinite(value) ||
          (name === 'skinIndex' && (!Number.isInteger(value) || value < 0 || value > 65535))
        )
          return invalid(`BufferGeometry.attributes.${key}`, geometry.uuid);
        values[vertex * width + lane] = value;
      }
    }
    if (name === 'skinIndex') attributes.skinIndex = values as Uint16Array;
    else attributes[name] = values as Float32Array;
  }
  for (const [name, source] of Object.entries(projectedUvs)) {
    const data = new Float32Array(count * 2);
    data.set(source);
    if (mixedColor) data.set(source, sourceCount * 2);
    attributes[name as 'uv'] = data;
  }
  // Preserve the source index order when intersecting groups and drawRange.
  const originalIndex = geometry.index;
  const available = originalIndex?.count ?? sourceCount;
  const start = Math.max(0, Math.min(available, geometry.drawRange.start));
  const end = Math.max(0, Math.min(available, geometry.drawRange.start + geometry.drawRange.count));
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
      !(Number.isSafeInteger(range.count) || range.count === Infinity)
    )
      return invalid('BufferGeometry.groups', geometry.uuid);
    const first = Math.max(start, range.start);
    const endOfRange = Math.min(end, range.start + range.count);
    const primitiveSize =
      wireframe || topology === 'triangle-list' ? 3 : topology === 'line-list' ? 2 : 1;
    const last = first + Math.floor((endOfRange - first) / primitiveSize) * primitiveSize;
    const sourceSlot = range.materialIndex ?? 0;
    const slot =
      materials === undefined ? sourceSlot : materials.findIndex((m) => m.slot === sourceSlot);
    if (slot === -1 || last <= first) continue;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > 255)
      return invalid('BufferGeometry.groups.materialIndex', geometry.uuid);
    const offset = indices.length;
    for (let i = first; i < last; i++) {
      const index = originalIndex?.getX(i) ?? i;
      if (!Number.isInteger(index) || index < 0 || index >= sourceCount)
        return invalid('BufferGeometry.index', geometry.uuid);
      indices.push(index + (mixedColor && !materials?.[slot]?.vertexColors ? sourceCount : 0));
    }
    if (wireframe) {
      const triangles = indices.splice(offset);
      for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i] ?? 0,
          b = triangles[i + 1] ?? 0,
          c = triangles[i + 2] ?? 0;
        indices.push(a, b, b, c, c, a);
      }
    }
    submeshes.push({
      indexOffset: offset,
      indexCount: indices.length - offset,
      vertexCount: count,
      topology,
      materialSlot: slot,
    });
    slotCount = Math.max(slotCount, slot + 1);
  }
  if (submeshes.length === 0) return ok(undefined);
  if (attributes.normal === undefined) {
    // Fill the native vertex ABI without changing the source. Basic ignores
    // normals; admitted lit materials select primitive geometry in their Surface.
    const normals = new Float32Array(count * 3);
    for (let vertex = 0; vertex < count; vertex++) normals[vertex * 3 + 1] = 1;
    attributes.normal = normals;
  }
  const nativeIndices = count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  // Reserved BatchedMesh capacity can contain zero normals. Unreferenced
  // vertices do not participate in shading, but still need a valid native ABI.
  const referenced = new Set(indices);
  const normals = attributes.normal as Float32Array;
  for (let vertex = 0; vertex < count; vertex++) {
    if (
      !referenced.has(vertex) &&
      normals[vertex * 3] === 0 &&
      normals[vertex * 3 + 1] === 0 &&
      normals[vertex * 3 + 2] === 0
    )
      normals[vertex * 3 + 1] = 1;
  }
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
  if (attributes.tangent === undefined && topology !== 'triangle-list') {
    attributes.tangent = Float32Array.from({ length: count * 4 }, (_, i) =>
      i % 4 === 0 || i % 4 === 3 ? 1 : 0,
    );
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
  const morphCount = Math.max(
    0,
    ...['position', 'normal'].map(
      (name) => geometry.morphAttributes[name as 'position' | 'normal']?.length ?? 0,
    ),
  );
  const morphTargets: NonNullable<MeshAsset['morphTargets']>[number][] = Array.from(
    { length: morphCount },
    () => ({ position: new Float32Array(count * 3) }),
  );
  for (const [name, targets] of Object.entries(geometry.morphAttributes)) {
    if (targets === undefined || targets.length === 0) continue;
    // r184 MorphNode only applies position and normal, including on WebGPU.
    if (name === 'color') continue;
    if (name !== 'position' && name !== 'normal')
      return unsupported(`Morph ${name} requires a native target channel`, geometry.uuid);
    if (targets.length !== morphCount) return invalid('Morph target channel counts', geometry.uuid);
    const base = geometry.getAttribute(name);
    if (base === undefined)
      return invalid(`Morph ${name} requires its base attribute`, geometry.uuid);
    for (let index = 0; index < morphCount; index++) {
      const target = targets[index];
      if (target === undefined || target.itemSize !== 3 || target.count !== sourceCount)
        return invalid('Morph target extent', geometry.uuid);
      const delta = new Float32Array(count * 3);
      for (let vertex = 0; vertex < count; vertex++)
        for (let lane = 0; lane < 3; lane++) {
          const value =
            readComponent(target, vertex % sourceCount, lane) -
            (geometry.morphTargetsRelative ? 0 : readComponent(base, vertex % sourceCount, lane));
          if (!Number.isFinite(value)) return invalid('Morph target value', geometry.uuid);
          delta[vertex * 3 + lane] = value;
        }
      morphTargets[index] = { ...morphTargets[index], [name]: delta };
    }
  }
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) return packed;
  return ok({
    kind: 'mesh',
    ...(morphTargets.length === 0 ? {} : { morphTargets }),
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
