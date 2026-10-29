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

type Topology = 'triangle-list' | 'point-list' | 'line-list' | 'line-strip';

/** Mixed vertex-color groups duplicate the vertex stream; the second copy carries white. */
interface VertexLayout {
  readonly sourceCount: number;
  readonly count: number;
  readonly mixedColor: boolean;
}

interface ProjectedIndices {
  readonly indices: number[];
  readonly submeshes: MeshAsset['submeshes'][number][];
  readonly slotCount: number;
}

export function projectGeometry(
  geometry: BufferGeometry,
  grouped: boolean,
  materials?: readonly GeometryMaterial[],
  topology: Topology = 'triangle-list',
  projectedUvs: Readonly<Record<string, Float32Array>> = {},
  wireframe = false,
): Result<MeshAsset | undefined, Error> {
  const position = geometry.getAttribute('position');
  if (position === undefined || position.count === 0) return ok(undefined);
  const sourceCount = position.count;
  const useColor =
    geometry.hasAttribute('color') && (materials?.some((m) => m.vertexColors) ?? true);
  const mixedColor = useColor && materials?.some((m) => !m.vertexColors) === true;
  const layout = { sourceCount, count: sourceCount * (mixedColor ? 2 : 1), mixedColor };
  const projected = projectVertexAttributes(geometry, useColor, layout);
  if (!projected.ok) return projected;
  const attributes = projected.value;
  appendProjectedUvs(attributes, projectedUvs, layout);
  const ranged = projectIndices(geometry, grouped, materials, topology, wireframe, layout);
  if (!ranged.ok) return ranged;
  if (ranged.value === undefined) return ok(undefined);
  const { indices, submeshes, slotCount } = ranged.value;
  const count = layout.count;
  completeNormals(attributes, indices, count);
  const nativeIndices = count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const tangents = completeTangents(geometry, attributes, topology, nativeIndices, count);
  if (!tangents.ok) return tangents;
  const morphTargets = projectMorphTargets(geometry, layout);
  if (!morphTargets.ok) return morphTargets;
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) return packed;
  return ok({
    kind: 'mesh',
    ...(morphTargets.value.length === 0 ? {} : { morphTargets: morphTargets.value }),
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

function projectVertexAttributes(
  geometry: BufferGeometry,
  useColor: boolean,
  layout: VertexLayout,
): Result<VertexAttributeMap, Error> {
  const attributes: VertexAttributeMap = {};
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    // Ordinary Three materials ignore application attributes they never read.
    if (!Object.hasOwn(WIDTHS, key) || (key === 'color' && !useColor)) continue;
    const name = key as keyof typeof WIDTHS;
    const width = WIDTHS[name];
    if (
      attribute.count !== layout.sourceCount ||
      (attribute.itemSize !== width && !(key === 'color' && attribute.itemSize === 3))
    )
      return invalid(`BufferGeometry.attributes.${key}.itemSize/count`, geometry.uuid);
    const values =
      name === 'skinIndex'
        ? new Uint16Array(layout.count * width)
        : new Float32Array(layout.count * width);
    if (!copyAttribute(values, attribute, name, layout))
      return invalid(`BufferGeometry.attributes.${key}`, geometry.uuid);
    if (name === 'skinIndex') attributes.skinIndex = values as Uint16Array;
    else attributes[name] = values as Float32Array;
  }
  return ok(attributes);
}

/** Copy one source attribute into its native width; false when a component is not admissible. */
function copyAttribute(
  values: Float32Array | Uint16Array,
  attribute: BufferAttribute | InterleavedBufferAttribute,
  name: keyof typeof WIDTHS,
  layout: VertexLayout,
): boolean {
  const width = WIDTHS[name];
  for (let vertex = 0; vertex < layout.count; vertex++) {
    for (let lane = 0; lane < width; lane++) {
      const value =
        (name === 'color' && vertex >= layout.sourceCount) ||
        (lane === 3 && attribute.itemSize === 3)
          ? 1
          : readComponent(attribute, vertex % layout.sourceCount, lane);
      if (
        !Number.isFinite(value) ||
        (name === 'skinIndex' && (!Number.isInteger(value) || value < 0 || value > 65535))
      )
        return false;
      values[vertex * width + lane] = value;
    }
  }
  return true;
}

function appendProjectedUvs(
  attributes: VertexAttributeMap,
  projectedUvs: Readonly<Record<string, Float32Array>>,
  layout: VertexLayout,
): void {
  for (const [name, source] of Object.entries(projectedUvs)) {
    const data = new Float32Array(layout.count * 2);
    data.set(source);
    if (layout.mixedColor) data.set(source, layout.sourceCount * 2);
    attributes[name as 'uv'] = data;
  }
}

/** Preserve the source index order when intersecting groups and drawRange. */
function projectIndices(
  geometry: BufferGeometry,
  grouped: boolean,
  materials: readonly GeometryMaterial[] | undefined,
  topology: Topology,
  wireframe: boolean,
  layout: VertexLayout,
): Result<ProjectedIndices | undefined, Error> {
  const available = geometry.index?.count ?? layout.sourceCount;
  const start = Math.max(0, Math.min(available, geometry.drawRange.start));
  const end = Math.max(0, Math.min(available, geometry.drawRange.start + geometry.drawRange.count));
  if (![start, end].every((value) => Number.isSafeInteger(value) && value >= 0))
    return invalid('BufferGeometry.drawRange', geometry.uuid);
  if (end <= start) return ok(undefined);
  const ranges = grouped ? geometry.groups : [{ start: 0, count: available, materialIndex: 0 }];
  const primitiveSize =
    wireframe || topology === 'triangle-list' ? 3 : topology === 'line-list' ? 2 : 1;
  const indices: number[] = [];
  const submeshes: MeshAsset['submeshes'][number][] = [];
  let slotCount = 1;
  for (const range of ranges) {
    if (!isSafeRange(range)) return invalid('BufferGeometry.groups', geometry.uuid);
    const first = Math.max(start, range.start);
    const endOfRange = Math.min(end, range.start + range.count);
    const last = first + Math.floor((endOfRange - first) / primitiveSize) * primitiveSize;
    const slot = selectedSlot(materials, range.materialIndex);
    if (slot === -1 || last <= first) continue;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > 255)
      return invalid('BufferGeometry.groups.materialIndex', geometry.uuid);
    const offset = indices.length;
    const colorOffset =
      layout.mixedColor && !materials?.[slot]?.vertexColors ? layout.sourceCount : 0;
    if (!appendSourceIndices(indices, geometry, first, last, colorOffset, layout.sourceCount))
      return invalid('BufferGeometry.index', geometry.uuid);
    if (wireframe) expandWireframe(indices, offset);
    submeshes.push({
      indexOffset: offset,
      indexCount: indices.length - offset,
      vertexCount: layout.count,
      topology,
      materialSlot: slot,
    });
    slotCount = Math.max(slotCount, slot + 1);
  }
  if (submeshes.length === 0) return ok(undefined);
  return ok({ indices, submeshes, slotCount });
}

function isSafeRange(range: { readonly start: number; readonly count: number }): boolean {
  return (
    Number.isSafeInteger(range.start) &&
    (Number.isSafeInteger(range.count) || range.count === Infinity)
  );
}

/** Native slot of a source material index: its position among the selected materials, or -1. */
function selectedSlot(
  materials: readonly GeometryMaterial[] | undefined,
  materialIndex: number | undefined,
): number {
  const sourceSlot = materialIndex ?? 0;
  return materials === undefined ? sourceSlot : materials.findIndex((m) => m.slot === sourceSlot);
}

/** Append source indices [first, last) shifted into the selected color copy; false on an out-of-range index. */
function appendSourceIndices(
  indices: number[],
  geometry: BufferGeometry,
  first: number,
  last: number,
  colorOffset: number,
  sourceCount: number,
): boolean {
  const originalIndex = geometry.index;
  for (let i = first; i < last; i++) {
    const index = originalIndex?.getX(i) ?? i;
    if (!Number.isInteger(index) || index < 0 || index >= sourceCount) return false;
    indices.push(index + colorOffset);
  }
  return true;
}

/** Replace the triangles appended after offset by their three edges. */
function expandWireframe(indices: number[], offset: number): void {
  const triangles = indices.splice(offset);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] ?? 0,
      b = triangles[i + 1] ?? 0,
      c = triangles[i + 2] ?? 0;
    indices.push(a, b, b, c, c, a);
  }
}

function completeNormals(attributes: VertexAttributeMap, indices: number[], count: number): void {
  if (attributes.normal === undefined) {
    // Fill the native vertex ABI without changing the source. Basic ignores
    // normals; admitted lit materials select primitive geometry in their Surface.
    const normals = new Float32Array(count * 3);
    for (let vertex = 0; vertex < count; vertex++) normals[vertex * 3 + 1] = 1;
    attributes.normal = normals;
  }
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
}

/**
 * Three supplies zero UVs for absent inputs. Forgeax's canonical material ABI also
 * requires tangents, derived by Geometry's existing kernel without mutating the source.
 */
function completeTangents(
  geometry: BufferGeometry,
  attributes: VertexAttributeMap,
  topology: Topology,
  nativeIndices: Uint16Array | Uint32Array,
  count: number,
): Result<void, Error> {
  if (attributes.uv === undefined) {
    attributes.uv = new Float32Array(count * 2);
    if (attributes.tangent === undefined) {
      const tangents = normalPlaneTangents(attributes.normal as Float32Array, count);
      if (tangents === undefined) return invalid('BufferGeometry.normal', geometry.uuid);
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
  return ok(undefined);
}

/** UV-less tangents lie in each normal's plane; undefined when a normal is degenerate. */
function normalPlaneTangents(normals: Float32Array, count: number): Float32Array | undefined {
  const tangents = new Float32Array(count * 4);
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
      return undefined;
    tangents[vertex * 4 + 3] = 1;
  }
  return tangents;
}

type MorphTarget = NonNullable<MeshAsset['morphTargets']>[number];

function projectMorphTargets(
  geometry: BufferGeometry,
  layout: VertexLayout,
): Result<MorphTarget[], Error> {
  const morphCount = Math.max(
    0,
    ...['position', 'normal'].map(
      (name) => geometry.morphAttributes[name as 'position' | 'normal']?.length ?? 0,
    ),
  );
  const morphTargets: MorphTarget[] = Array.from({ length: morphCount }, () => ({
    position: new Float32Array(layout.count * 3),
  }));
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
      const delta = morphDelta(geometry, targets[index], base, layout);
      if (!delta.ok) return delta;
      morphTargets[index] = { ...morphTargets[index], [name]: delta.value };
    }
  }
  return ok(morphTargets);
}

function morphDelta(
  geometry: BufferGeometry,
  target: BufferAttribute | InterleavedBufferAttribute | undefined,
  base: BufferAttribute | InterleavedBufferAttribute,
  layout: VertexLayout,
): Result<Float32Array, Error> {
  if (target === undefined || target.itemSize !== 3 || target.count !== layout.sourceCount)
    return invalid('Morph target extent', geometry.uuid);
  const delta = new Float32Array(layout.count * 3);
  for (let vertex = 0; vertex < layout.count; vertex++)
    for (let lane = 0; lane < 3; lane++) {
      const source = vertex % layout.sourceCount;
      const value =
        readComponent(target, source, lane) -
        (geometry.morphTargetsRelative ? 0 : readComponent(base, source, lane));
      if (!Number.isFinite(value)) return invalid('Morph target value', geometry.uuid);
      delta[vertex * 3 + lane] = value;
    }
  return ok(delta);
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
