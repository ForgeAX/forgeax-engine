import type { MeshRange } from '@forgeax/engine-assets-runtime';
import {
  computeTangentVec4,
  deriveVertexLayoutProjection,
  isStandaloneStaticMesh,
  meshAttributeLayout,
  meshAttributeWindow,
  packVertexAttributes,
  writeNormalPlaneTangent,
} from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import { type MeshAsset, ok, type Result, type VertexAttributeMap } from '@forgeax/engine-types';
import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  InterleavedBufferAttribute,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { applyMorphColor } from './morph-color';
import { ownSourceValue } from './source-fields';

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
  readonly tangentBasis?: 'normal' | 'uv';
}

export function geometryValues(geometry: BufferGeometry, grouped: boolean): unknown[] {
  const index = geometry.index;
  const values: unknown[] = [
    grouped,
    geometry.drawRange.start,
    geometry.drawRange.count,
    index,
    index?.array,
    index?.version,
    index?.count,
    index?.itemSize,
    index?.normalized,
  ];
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    if (!Object.hasOwn(WIDTHS, key)) continue;
    const buffer = 'data' in attribute ? attribute.data : attribute;
    values.push(
      buffer.array,
      attribute.count,
      attribute.itemSize,
      attribute.normalized,
      'offset' in attribute ? attribute.offset : 0,
      'stride' in buffer ? buffer.stride : 0,
      // Keep the version between its source attribute and name. Range publication
      // can distinguish a content edit from every structural signature change.
      attribute,
      buffer.version,
      key,
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

type SourceAttribute = BufferGeometry['attributes'][string];
type SourceBuffer = BufferAttribute | InterleavedBufferAttribute['data'];
type VertexEdit = Extract<MeshRange, { readonly values: Float32Array }>;
type FloatChannel = VertexEdit['attribute'];

function versionAttribute(geometry: BufferGeometry, values: readonly unknown[], index: number) {
  const name = values[index + 1];
  if (typeof name !== 'string' || !Object.hasOwn(WIDTHS, name)) return;
  const key = name as keyof typeof WIDTHS;
  const attribute = geometry.attributes[key];
  return attribute && attribute === values[index - 1] ? { key, attribute } : undefined;
}

/** Only buffers whose content revision was observed can acknowledge the author's ranges. */
export function recordGeometryRanges(
  geometry: BufferGeometry,
  previous: readonly unknown[],
  current: readonly unknown[],
  receipts: Map<object, () => void> | undefined,
) {
  for (let i = 0; i < current.length; i++) {
    if (Object.is(current[i], previous[i]) || typeof current[i] !== 'number') continue;
    const entry = versionAttribute(geometry, current, i);
    if (!entry) continue;
    const buffer = 'data' in entry.attribute ? entry.attribute.data : entry.attribute;
    if (buffer.updateRanges?.length && !receipts?.has(buffer)) {
      receipts ??= new Map();
      receipts.set(buffer, geometryRangeReceipt(buffer));
    }
  }
  return receipts;
}

/** Consume an observed Three range list only after all variants commit. A later author edit wins. */
function geometryRangeReceipt(buffer: SourceBuffer) {
  const list = buffer.updateRanges,
    version = buffer.version;
  const observed = list.map(({ start, count }) => ({ start, count }));
  return () => {
    if (
      buffer.version === version &&
      buffer.updateRanges === list &&
      list.length === observed.length &&
      observed.every((range, i) => range.start === list[i]?.start && range.count === list[i]?.count)
    )
      buffer.clearUpdateRanges();
  };
}

/** Number of this attribute's scalar lanes before an offset in the source buffer. */
function channelPrefix(offset: number, stride: number, column: number, width: number): number {
  return (
    Math.floor(offset / stride) * width + Math.min(width, Math.max(0, (offset % stride) - column))
  );
}

function changedLanes(attribute: SourceAttribute) {
  const interleaved = 'data' in attribute;
  const source = interleaved ? attribute.data : attribute;
  const width = attribute.itemSize,
    stride = interleaved ? attribute.data.stride : width;
  const column = interleaved ? attribute.offset : 0;
  if (
    !source.updateRanges.length ||
    !Number.isSafeInteger(stride) ||
    stride < width ||
    !Number.isSafeInteger(column) ||
    column < 0 ||
    column + width > stride
  )
    return;
  const lanes: { first: number; end: number }[] = [];
  for (const { start, count } of source.updateRanges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(count) ||
      start < 0 ||
      count < 1 ||
      start + count > source.array.length
    )
      return;
    const first = channelPrefix(start, stride, column, width);
    const end = channelPrefix(start + count, stride, column, width);
    if (first < end) lanes.push({ first, end });
  }
  return lanes.sort((a, b) => a.first - b.first);
}

function captureVertexChannel(
  payload: MeshAsset,
  key: FloatChannel,
  attribute: SourceAttribute,
  lanes: { first: number; end: number }[],
  edits: VertexEdit[],
  maxRanges: number,
  uuid: string,
): boolean {
  const prior = meshAttributeWindow(payload, key);
  const width = attribute.itemSize,
    nativeWidth = WIDTHS[key];
  if (!prior || prior.count !== attribute.count || prior.components !== nativeWidth) return false;
  // Fold ranges that touch the same or adjacent vertices into one native write.
  // A partly written vertex borrows its other lanes from the last admitted version.
  let i = 0,
    next = lanes[0];
  while (next !== undefined) {
    let cursor = i;
    let active: (typeof lanes)[number] | undefined = next;
    const first = Math.floor(next.first / width);
    let end = Math.ceil(next.end / width);
    next = lanes[++i];
    while (next && Math.floor(next.first / width) <= end) {
      end = Math.max(end, Math.ceil(next.end / width));
      next = lanes[++i];
    }
    if (edits.length >= maxRanges) return false;
    const values = new Float32Array((end - first) * nativeWidth);
    for (let v = first, dst = 0; v < end; v++)
      for (let lane = 0; lane < nativeWidth; lane++) {
        const scalar = v * width + lane;
        while (cursor < i && active && active.end <= scalar && lane < width)
          active = lanes[++cursor];
        const changed =
          lane < width && cursor < i && active !== undefined && active.first <= scalar;
        const value = changed
          ? readComponent(attribute, v, lane)
          : (prior.data[prior.offset + v * prior.stride + lane] as number);
        if (!Number.isFinite(value)) invalid(`BufferGeometry.attributes.${key}`, uuid).unwrap();
        values[dst++] = value;
      }
    edits.push({ attribute: key, first, values });
  }
  return true;
}

/** Compare actual source revisions and project declared component edits at fixed vertex ordinals. */
export function rigidVertexEdits(
  geometry: BufferGeometry,
  previous: readonly unknown[],
  current: readonly unknown[],
  materials: readonly GeometryMaterial[],
  payload: MeshAsset,
  maxRanges: number,
): VertexEdit[] | undefined {
  if (
    previous.length !== current.length ||
    payload.attributeStorage === undefined ||
    payload.morphTargets !== undefined ||
    geometry.getAttribute !== stockGetAttribute ||
    Object.keys(geometry.morphAttributes).length ||
    (geometry.hasAttribute('color') &&
      materials.some((m) => m.vertexColors) &&
      materials.some((m) => !m.vertexColors))
  )
    return;
  const derivedTangent = !geometry.hasAttribute('tangent');
  const derivedFromTriangles =
    derivedTangent &&
    geometry.hasAttribute('uv') &&
    !materials.every((m) => m.tangentBasis === 'normal');
  const edits: VertexEdit[] = [];
  for (let i = 0; i < current.length; i++) {
    if (Object.is(current[i], previous[i])) continue;
    const version = previous[i];
    if (typeof version !== 'number' || current[i] !== version + 1) return;
    const source = versionAttribute(geometry, current, i);
    if (!source) return;
    const { key, attribute } = source;
    const lanes = changedLanes(attribute);
    if (!lanes) return;
    if (!lanes.length || (key === 'color' && !materials.some((m) => m.vertexColors))) continue;
    // Normal repair and UV-derived tangent generation can affect other vertex lanes.
    if (
      key === 'skinIndex' ||
      key === 'skinWeight' ||
      (derivedFromTriangles && (key === 'uv' || key === 'position' || key === 'normal')) ||
      (key === 'normal' && lanes.some((range) => range.first % 3 !== 0 || range.end % 3 !== 0))
    )
      return;
    const start = edits.length;
    const readers =
      'data' in attribute ? InterleavedBufferAttribute.prototype : BufferAttribute.prototype;
    if (
      attribute.getX !== readers.getX ||
      attribute.getY !== readers.getY ||
      attribute.getZ !== readers.getZ ||
      attribute.getW !== readers.getW ||
      !captureVertexChannel(payload, key, attribute, lanes, edits, maxRanges, geometry.uuid)
    )
      return;
    if (key === 'normal') {
      const end = edits.length;
      for (let n = start; n < end; n++) {
        const normal = edits[n] as VertexEdit;
        const values = normal.values;
        // Replacing an unreferenced zero normal depends on the index buffer.
        for (let j = 0; j < values.length; j += 3)
          if (values[j] === 0 && values[j + 1] === 0 && values[j + 2] === 0) return;
        if (derivedTangent) {
          if (edits.length >= maxRanges) return;
          const tangents = normalPlaneTangents(values, values.length / 3);
          if (!tangents) return;
          edits.push({ attribute: 'tangent', first: normal.first, values: tangents });
        }
      }
    }
  }
  return edits;
}

/** A dispose between preparation and publication requires a new lease with the captured edit. */
export function restoreRigidVertexEdits(base: MeshAsset, ranges: readonly VertexEdit[]): MeshAsset {
  const mesh = {
    ...base,
    vertices: base.vertices.slice(),
    ...(base.aabb === undefined ? {} : { aabb: base.aabb.slice() }),
  };
  for (const range of ranges) {
    const view = meshAttributeWindow(base, range.attribute);
    if (!view) throw new Error('missing captured vertex attribute');
    const width = view.components;
    for (
      let src = 0, at = view.offset + range.first * view.stride;
      src < range.values.length;
      at += view.stride
    )
      for (let axis = 0; axis < width; axis++) {
        const value = range.values[src++] as number;
        mesh.vertices[at + axis] = value;
        if (range.attribute === 'position' && mesh.aabb) {
          mesh.aabb[axis] = Math.min(mesh.aabb[axis] as number, value);
          mesh.aabb[axis + 3] = Math.max(mesh.aabb[axis + 3] as number, value);
        }
      }
  }
  return mesh;
}

type Topology = 'triangle-list' | 'point-list' | 'line-list' | 'line-strip';

/** Mixed vertex-color groups duplicate the vertex stream; the second copy carries white. */
interface VertexLayout {
  readonly sourceCount: number;
  readonly count: number;
  readonly mixedColor: boolean;
}

interface ProjectedIndices {
  readonly indices: Uint16Array | Uint32Array;
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
  morphColorWeights?: readonly number[],
  packVertices: boolean | 'static-streams' = true,
): Result<MeshAsset | undefined, Error> {
  const position = geometry.getAttribute('position');
  if (position === undefined || position.count === 0) return ok(undefined);
  const layout = geometryVertexLayout(geometry, materials, position.count);
  const useColor = layout.useColor;
  const projected = projectVertexAttributes(geometry, useColor, layout, topology);
  if (!projected.ok) return projected;
  const attributes = projected.value;
  if (morphColorWeights !== undefined) {
    const colors = applyMorphColor(
      geometry,
      attributes.color as Float32Array | undefined,
      morphColorWeights,
    );
    if (!colors.ok) return colors;
  }
  appendProjectedUvs(attributes, projectedUvs, layout);
  const ranged = projectIndices(geometry, grouped, materials, topology, wireframe, layout);
  if (!ranged.ok) return ranged;
  if (ranged.value === undefined) return ok(undefined);
  const { indices, submeshes, slotCount } = ranged.value;
  const count = layout.count;
  completeNormals(attributes, indices, count);
  const tangents = completeTangents(
    geometry,
    attributes,
    topology,
    indices,
    count,
    materials?.every((material) => material.tangentBasis === 'normal') ?? false,
  );
  if (!tangents.ok) return tangents;
  const morphTargets = projectMorphTargets(geometry, layout);
  if (!morphTargets.ok) return morphTargets;
  const mesh = {
    kind: 'mesh' as const,
    ...(morphTargets.value.length === 0 ? {} : { morphTargets: morphTargets.value }),
    attributes,
    indices,
    aabb: box3.fromPositions(box3.create(), attributes.position as Float32Array),
    submeshes,
    materialSlots: Array.from({ length: slotCount }, (_, slot) => ({
      slotName: `material-${slot}`,
    })),
  };
  if (!packVertices) return ok({ ...mesh, vertices: new Float32Array() });
  const storage =
    packVertices === 'static-streams' && isStandaloneStaticMesh(mesh)
      ? 'static-streams'
      : 'interleaved';
  const packed = packVertexAttributes(attributes, count, storage);
  if (!packed.ok) return packed;
  return ok({
    ...mesh,
    vertices: packed.value.vertices,
    ...(packed.value.projection.streams === undefined
      ? {}
      : {
          attributeStorage: 'static-streams' as const,
          attributes: meshAttributeLayout(attributes),
        }),
  });
}

function geometryVertexLayout(
  geometry: BufferGeometry,
  materials: readonly GeometryMaterial[] | undefined,
  sourceCount: number,
): VertexLayout & { readonly useColor: boolean } {
  const useColor =
    geometry.hasAttribute('color') && (materials?.some((m) => m.vertexColors) ?? true);
  const mixedColor = useColor && materials?.some((m) => !m.vertexColors) === true;
  return { sourceCount, count: sourceCount * (mixedColor ? 2 : 1), mixedColor, useColor };
}

function copyCompactSkinWeights(
  attribute: BufferGeometry['attributes'][string],
  layout: VertexLayout,
  width: number,
): Uint8Array | Uint16Array | undefined {
  if (
    !(attribute instanceof BufferAttribute) ||
    !attribute.normalized ||
    (attribute.array.constructor !== Uint8Array && attribute.array.constructor !== Uint16Array) ||
    attribute.array.length !== layout.sourceCount * width ||
    attribute.getX !== BufferAttribute.prototype.getX ||
    attribute.getY !== BufferAttribute.prototype.getY ||
    attribute.getZ !== BufferAttribute.prototype.getZ ||
    attribute.getW !== BufferAttribute.prototype.getW
  )
    return;
  const ArrayType = attribute.array.constructor as typeof Uint8Array | typeof Uint16Array;
  const values = new ArrayType(layout.count * width);
  values.set(attribute.array);
  if (layout.mixedColor) values.set(attribute.array, attribute.array.length);
  return values;
}

function projectVertexAttributes(
  geometry: BufferGeometry,
  useColor: boolean,
  layout: VertexLayout,
  topology: Topology,
): Result<VertexAttributeMap, Error> {
  const attributes: VertexAttributeMap = {};
  for (const [key, attribute] of Object.entries(geometry.attributes)) {
    // Ordinary Three materials ignore application attributes they never read.
    if (
      !Object.hasOwn(WIDTHS, key) ||
      (key === 'color' && !useColor) ||
      (topology === 'point-list' && key === 'uv1')
    )
      continue;
    const name = key as keyof typeof WIDTHS;
    const width = WIDTHS[name];
    if (
      attribute.count !== layout.sourceCount ||
      (attribute.itemSize !== width && !(key === 'color' && attribute.itemSize === 3))
    )
      return invalid(`BufferGeometry.attributes.${key}.itemSize/count`, geometry.uuid);
    const packedWeights =
      name === 'skinWeight' ? copyCompactSkinWeights(attribute, layout, width) : undefined;
    if (packedWeights !== undefined) {
      attributes.skinWeight = packedWeights;
      continue;
    }
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

export function hasPlainPointGeometry(geometry: BufferGeometry): boolean {
  return (
    geometry.index === null &&
    geometry.groups.length === 0 &&
    Object.keys(geometry.morphAttributes).length === 0 &&
    Object.keys(geometry.attributes).every((key) => key === 'position' || key === 'color')
  );
}

interface PointContent {
  readonly position: Float32Array;
  readonly color: Float32Array | undefined;
  readonly colorWidth: 3 | 4;
  readonly count: number;
}

const stockAttributeReaders = [
  BufferAttribute.prototype.getX,
  BufferAttribute.prototype.getY,
  BufferAttribute.prototype.getZ,
  BufferAttribute.prototype.getW,
] as const;
const stockGetAttribute = BufferGeometry.prototype.getAttribute;
const stockHasAttribute = BufferGeometry.prototype.hasAttribute;

function stockPointArray(source: unknown, width: number): Float32Array | undefined {
  if (!(source instanceof BufferAttribute)) return;
  const prototype = Object.getPrototypeOf(source);
  if (
    (prototype !== BufferAttribute.prototype && prototype !== Float32BufferAttribute.prototype) ||
    source.getX !== stockAttributeReaders[0] ||
    source.getY !== stockAttributeReaders[1] ||
    source.getZ !== stockAttributeReaders[2] ||
    source.getW !== stockAttributeReaders[3] ||
    ownSourceValue(source, 'normalized') !== false ||
    ownSourceValue(source, 'itemSize') !== width
  )
    return;
  const array = ownSourceValue(source, 'array');
  if (
    array instanceof Float32Array &&
    Object.getPrototypeOf(array) === Float32Array.prototype &&
    array.buffer instanceof ArrayBuffer &&
    array.length % width === 0 &&
    ownSourceValue(source, 'count') === array.length / width
  )
    return array;
  return undefined;
}

/** The general path remains authoritative for draw ranges and custom attribute readers. */
export function readPointContent(
  geometry: BufferGeometry,
  useColor: boolean,
): PointContent | undefined {
  if (
    geometry.getAttribute !== stockGetAttribute ||
    geometry.hasAttribute !== stockHasAttribute ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity ||
    !hasPlainPointGeometry(geometry)
  )
    return;

  const attributes = geometry.attributes;
  const position = stockPointArray(ownSourceValue(attributes, 'position'), 3);
  if (!position?.length) return;
  const count = position.length / 3;
  const source = useColor ? ownSourceValue(attributes, 'color') : undefined;
  if (source === undefined) {
    if (useColor && 'color' in attributes) return;
    return { position, count, color: undefined, colorWidth: 3 };
  }
  if (!(source instanceof BufferAttribute)) return;
  const width = ownSourceValue(source, 'itemSize');
  if (width !== 3 && width !== 4) return;
  const color = stockPointArray(source, width);
  if (color?.length === count * width) return { position, count, color, colorWidth: width };
  return undefined;
}

export enum PointContentChannels {
  Position = 1,
  Color = 2,
  All = Position | Color,
}

/** Capture the notified source lanes; native colors always occupy four lanes. */
export function pointContentEdit(content: PointContent, channels: PointContentChannels) {
  const ranges: MeshRange[] = [];
  const position =
    channels & PointContentChannels.Position ? content.position.slice() : content.position;
  if (channels & PointContentChannels.Position)
    ranges.push({ attribute: 'position', first: 0, values: position });
  let color = content.color;
  let colorWidth = content.colorWidth;
  if (color !== undefined && channels & PointContentChannels.Color) {
    if (content.colorWidth === 3) {
      const values = new Float32Array(content.count * 4);
      for (let src = 0, dst = 0; src < color.length; src += 3, dst += 4) {
        values[dst] = color[src] as number;
        values[dst + 1] = color[src + 1] as number;
        values[dst + 2] = color[src + 2] as number;
        values[dst + 3] = 1;
      }
      color = values;
      colorWidth = 4;
    } else color = color.slice();
    ranges.push({ attribute: 'color', first: 0, values: color });
  }
  return { content: { ...content, position, color, colorWidth }, channels, ranges };
}

/** Keep the accepted static rows and indices. Source arrays are borrowed only for this copy. */
export function repackPointContent(
  content: PointContent,
  accepted: MeshAsset,
  geometry: BufferGeometry,
  channels = PointContentChannels.All,
): MeshAsset | undefined {
  if (
    accepted.attributeStorage !== 'interleaved' ||
    accepted.indices?.length !== content.count ||
    (accepted.attributes.color !== undefined) !== (content.color !== undefined)
  )
    return;
  const layout = deriveVertexLayoutProjection(accepted.attributes);
  const stride = layout.arrayStride / Float32Array.BYTES_PER_ELEMENT;
  if (accepted.vertices.length !== content.count * stride) return;
  const vertices = new Float32Array(accepted.vertices);
  for (const channel of layout.attributes) {
    if (
      channel.key === 'position'
        ? !(channels & PointContentChannels.Position)
        : channel.key !== 'color' || !(channels & PointContentChannels.Color)
    )
      continue;
    const source = channel.key === 'position' ? content.position : content.color;
    if (source === undefined) continue;
    const width = channel.key === 'position' ? 3 : content.colorWidth;
    let offset = channel.offset / Float32Array.BYTES_PER_ELEMENT;
    for (let index = 0; index < source.length; offset += stride) {
      for (let lane = 0; lane < width; lane++) {
        const value = source[index++] as number;
        if (!Number.isFinite(value))
          return invalid(`BufferGeometry.attributes.${channel.key}`, geometry.uuid).unwrap();
        vertices[offset + lane] = value;
      }
      if (channel.key === 'color' && width === 3) vertices[offset + 3] = 1;
    }
  }
  return {
    ...accepted,
    vertices,
    ...(channels & PointContentChannels.Position
      ? { aabb: box3.fromPositions(box3.create(), content.position) }
      : {}),
  };
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

const stockIndexPrototypes = new Set([
  BufferAttribute.prototype,
  Uint16BufferAttribute.prototype,
  Uint32BufferAttribute.prototype,
]);
const stockIndexRead = BufferAttribute.prototype.getX;
function contiguousIndices(index: BufferAttribute | null): Uint16Array | Uint32Array | undefined {
  if (
    !index ||
    Object.hasOwn(index, 'getX') ||
    !stockIndexPrototypes.has(Object.getPrototypeOf(index)) ||
    index.getX !== stockIndexRead ||
    ownSourceValue(index, 'itemSize') !== 1 ||
    ownSourceValue(index, 'normalized') !== false
  )
    return;
  const source = ownSourceValue(index, 'array');
  if (
    (source instanceof Uint16Array || source instanceof Uint32Array) &&
    (Object.getPrototypeOf(source) === Uint16Array.prototype ||
      Object.getPrototypeOf(source) === Uint32Array.prototype) &&
    source.buffer instanceof ArrayBuffer &&
    !Object.hasOwn(source, 'subarray')
  )
    return source;
  return undefined;
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
  const IndexArray = layout.count > 65535 ? Uint32Array : Uint16Array;
  const source =
    !grouped && !wireframe && !layout.mixedColor ? contiguousIndices(geometry.index) : undefined;
  let direct: Uint16Array | Uint32Array | undefined;
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
    if (source) {
      if (last > source.length) return invalid('BufferGeometry.index', geometry.uuid);
      for (let i = first; i < last; i++)
        if ((source[i] as number) >= layout.sourceCount)
          return invalid('BufferGeometry.index', geometry.uuid);
      // Borrow for this synchronous read. The asset keeps an independent revision.
      direct = new IndexArray(
        first === 0 && last === source.length ? source : source.subarray(first, last),
      );
    } else {
      if (!appendSourceIndices(indices, geometry, first, last, colorOffset, layout.sourceCount))
        return invalid('BufferGeometry.index', geometry.uuid);
      if (wireframe) expandWireframe(indices, offset);
    }
    submeshes.push({
      indexOffset: offset,
      indexCount: direct?.length ?? indices.length - offset,
      vertexCount: layout.count,
      topology,
      materialSlot: slot,
    });
    slotCount = Math.max(slotCount, slot + 1);
  }
  if (submeshes.length === 0) return ok(undefined);
  return ok({ indices: direct ?? new IndexArray(indices), submeshes, slotCount });
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

function completeNormals(
  attributes: VertexAttributeMap,
  indices: Uint16Array | Uint32Array,
  count: number,
): void {
  if (attributes.normal === undefined) {
    // Fill the native vertex ABI without changing the source. Basic ignores
    // normals; admitted lit materials select primitive geometry in their Surface.
    const normals = new Float32Array(count * 3);
    for (let vertex = 0; vertex < count; vertex++) normals[vertex * 3 + 1] = 1;
    attributes.normal = normals;
    return;
  }
  // Reserved BatchedMesh capacity can contain zero normals. Unreferenced
  // vertices do not participate in shading, but still need a valid native ABI.
  let referenced: Set<number> | undefined;
  const normals = attributes.normal as Float32Array;
  for (let vertex = 0; vertex < count; vertex++) {
    if (
      normals[vertex * 3] === 0 &&
      normals[vertex * 3 + 1] === 0 &&
      normals[vertex * 3 + 2] === 0
    ) {
      referenced ??= new Set(indices);
      if (!referenced.has(vertex)) normals[vertex * 3 + 1] = 1;
    }
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
  normalBasis: boolean,
): Result<void, Error> {
  const missingUv = attributes.uv === undefined;
  if (missingUv) attributes.uv = new Float32Array(count * 2);
  if (missingUv || normalBasis) {
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
    // Native position/normal targets stay on the GPU; r187 color morphs enter vertex bytes above.
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
