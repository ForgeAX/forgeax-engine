import { box3 } from '@forgeax/engine-math';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  err,
  isStripTopology,
  type MeshAsset,
  type MeshMaterialSlot,
  ok,
  type PrimitiveTopology,
  type Result,
  type Submesh,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { computeTangentVec4, writeNormalPlaneTangent } from './tangent';
import {
  CANONICAL_KEYS,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
  type VertexLayoutProjectionAttribute,
} from './vertex-attribute-layout';

type AttributeKey = VertexLayoutProjectionAttribute['key'];
type AttributeSource = NonNullable<VertexAttributeMap[AttributeKey]>;
type AttributeView = Float32Array | Uint16Array;

const TOPOLOGIES: readonly PrimitiveTopology[] = [
  'point-list',
  'line-list',
  'line-strip',
  'triangle-list',
  'triangle-strip',
];

/** Input shape for one independently drawn submesh. */
export type MeshBuilderSubmesh = Partial<Submesh>;

/** All authoring facts accepted by {@link createMeshBuilder}. */
export interface MeshBuilderOptions {
  readonly attributes?: VertexAttributeMap;
  readonly indices?: ArrayLike<number>;
  readonly submeshes?: readonly MeshBuilderSubmesh[];
  readonly materialSlots?: readonly MeshMaterialSlot[];
}

export interface MeshBuilder {
  /** Append one equally-cardinal attribute batch to the accumulated source. */
  appendVertices(attributes: VertexAttributeMap): Result<void, AssetError>;
  /** Append raw index values; width is derived during build. */
  appendIndices(indices: ArrayLike<number>): Result<void, AssetError>;
  /** Add a draw range; omitted ranges are completed from the final source. */
  addSubmesh(submesh: MeshBuilderSubmesh): Result<void, AssetError>;
  /** Derive one immutable MeshAsset from the accumulated source. */
  build(): Result<MeshAsset, AssetError>;
}

function failure(field: string, value: unknown, reason: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected: `valid MeshBuilder ${field}: ${reason}`,
      hint: ASSET_ERROR_HINTS['asset-invalid-value'],
      detail: { field, value, reason },
    }),
  );
}

function sourceView(key: AttributeKey, value: AttributeSource): AttributeView | undefined {
  if (key === 'skinIndex') {
    if (value instanceof Uint16Array) return value;
    if (value instanceof ArrayBuffer && value.byteLength % Uint16Array.BYTES_PER_ELEMENT === 0) {
      return new Uint16Array(value);
    }
    return undefined;
  }
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(value);
  }
  return undefined;
}

function attributeKeys(attributes: VertexAttributeMap): AttributeKey[] {
  return deriveVertexLayoutProjection(attributes).attributes.map((attribute) => attribute.key);
}

function appendArray(target: AttributeView, source: AttributeView): AttributeView {
  if (target instanceof Uint16Array && source instanceof Uint16Array) {
    const output = new Uint16Array(target.length + source.length);
    output.set(target, 0);
    output.set(source, target.length);
    return output;
  }
  if (target instanceof Float32Array && source instanceof Float32Array) {
    const output = new Float32Array(target.length + source.length);
    output.set(target, 0);
    output.set(source, target.length);
    return output;
  }
  // The caller groups batches by canonical key, so this branch only protects
  // against an internally inconsistent future storage change.
  return target;
}

function copySlots(slots: readonly MeshMaterialSlot[] | undefined): MeshMaterialSlot[] {
  return (slots ?? [{ slotName: 'Default' }]).map((slot) => ({
    slotName: slot.slotName,
    ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
    ...(slot.defaultMaterial === undefined ? {} : { defaultMaterial: slot.defaultMaterial }),
  }));
}

function validateAttributeBatch(
  attributes: VertexAttributeMap,
): Result<readonly (readonly [AttributeKey, AttributeView])[], AssetError> {
  const projection = deriveVertexLayoutProjection(attributes);
  if (projection.attributes.length === 0)
    return failure('attributes', [], 'at least one canonical attribute is required');
  const position = attributes.position;
  if (position === undefined)
    return failure('attributes.position', undefined, 'position is required');
  const positionView = sourceView('position', position);
  if (positionView === undefined) {
    return failure(
      'attributes.position',
      typeof position,
      'position must use Float32Array or ArrayBuffer',
    );
  }
  if (positionView.length === 0 || positionView.length % 3 !== 0) {
    return failure(
      'attributes.position',
      positionView.length,
      'position cardinality must be a non-zero multiple of 3',
    );
  }
  const vertexCount = positionView.length / 3;
  const views: (readonly [AttributeKey, AttributeView])[] = [];
  for (const { key, byteLength, format } of projection.attributes) {
    const value = attributes[key];
    if (value === undefined) continue;
    const view = key === 'position' ? positionView : sourceView(key, value);
    if (view === undefined) {
      return failure(
        key,
        typeof value,
        key === 'skinIndex' ? 'storage must be Uint16Array' : 'storage must be Float32Array',
      );
    }
    views.push([key, view]);
    const expectedLength = vertexCount * (byteLength / (format === 'uint16x4' ? 2 : 4));
    if (view.length !== expectedLength) {
      return failure(key, view.length, `cardinality must be ${expectedLength}`);
    }
    for (let elementIndex = 0; elementIndex < view.length; elementIndex += 1) {
      const valueAt = view[elementIndex];
      if (valueAt === undefined || !Number.isFinite(valueAt)) {
        return failure(key, valueAt, `${key}[${elementIndex}] must be finite`);
      }
      if (key === 'skinIndex' && (!Number.isInteger(valueAt) || valueAt < 0 || valueAt > 0xffff)) {
        return failure(key, valueAt, `${key}[${elementIndex}] must be an integer in [0, 65535]`);
      }
    }
  }
  return ok(views);
}

function validateSlots(slots: readonly MeshMaterialSlot[]): Result<void, AssetError> {
  if (slots.length === 0)
    return failure('materialSlots', slots.length, 'at least one material slot is required');
  const names = new Set<string>();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const name = slot?.slotName.trim() ?? '';
    if (name.length === 0 || names.has(name)) {
      return failure(`materialSlots[${index}].slotName`, name, 'must be non-empty and unique');
    }
    names.add(name);
  }
  return ok(undefined);
}

function completedSubmeshes(
  requested: readonly MeshBuilderSubmesh[],
  vertexCount: number,
  indexCount: number,
  materialSlotCount: number,
): Result<readonly Submesh[], AssetError> {
  const source =
    requested.length === 0
      ? [
          {
            indexOffset: 0,
            indexCount,
            vertexCount,
            topology: 'triangle-list' as const,
            materialSlot: 0,
          },
        ]
      : requested;
  const output: Submesh[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const candidate = source[index];
    if (candidate === undefined)
      return failure(`submeshes[${index}]`, undefined, 'entry is required');
    const indexOffset = candidate.indexOffset ?? 0;
    const submeshIndexCount = candidate.indexCount ?? (indexCount > 0 ? indexCount : 0);
    const submeshVertexCount = candidate.vertexCount ?? vertexCount;
    const topology = candidate.topology ?? 'triangle-list';
    const materialSlot = candidate.materialSlot ?? index;
    if (!TOPOLOGIES.includes(topology)) {
      return failure(
        `submeshes[${index}].topology`,
        topology,
        'must be a WebGPU primitive topology',
      );
    }
    if (
      !Number.isInteger(indexOffset) ||
      indexOffset < 0 ||
      !Number.isInteger(submeshIndexCount) ||
      submeshIndexCount < 0 ||
      !Number.isInteger(submeshVertexCount) ||
      submeshVertexCount < 0 ||
      submeshVertexCount > vertexCount ||
      !Number.isInteger(materialSlot) ||
      materialSlot < 0 ||
      materialSlot >= materialSlotCount
    ) {
      return failure(
        `submeshes[${index}]`,
        JSON.stringify(candidate),
        'range and material slot are invalid',
      );
    }
    if (indexCount === 0 && (indexOffset !== 0 || submeshIndexCount !== 0)) {
      return failure(
        `submeshes[${index}]`,
        JSON.stringify(candidate),
        'non-indexed meshes use indexOffset=0 and indexCount=0',
      );
    }
    if (indexCount > 0 && indexOffset + submeshIndexCount > indexCount) {
      return failure(
        `submeshes[${index}]`,
        JSON.stringify(candidate),
        'index range exceeds the accumulated index buffer',
      );
    }
    if (indexCount === 0 && isStripTopology(topology)) {
      return failure(
        `submeshes[${index}].topology`,
        topology,
        'strip topology requires an index buffer',
      );
    }
    output.push({
      indexOffset,
      indexCount: submeshIndexCount,
      vertexCount: submeshVertexCount,
      topology,
      materialSlot,
    });
  }
  return ok(Object.freeze(output));
}

type CornerOf = (position: number) => number;

/** The whole index buffer when one triangle-list range covers it exactly. */
function wholeTriangleList(
  submeshes: readonly Submesh[],
  indices: Uint16Array | Uint32Array | undefined,
): Uint16Array | Uint32Array | undefined {
  const only = submeshes.length === 1 ? submeshes[0] : undefined;
  if (
    indices !== undefined &&
    only?.topology === 'triangle-list' &&
    only.indexOffset === 0 &&
    only.indexCount === indices.length &&
    indices.length % 3 === 0
  )
    return indices;
  return undefined;
}

function pushTriangleList(corners: number[], corner: CornerOf, first: number, count: number): void {
  for (let k = 0; k + 2 < count; k += 3)
    corners.push(corner(first + k), corner(first + k + 1), corner(first + k + 2));
}

/**
 * Odd strip triangles swap their first two corners to keep one winding;
 * out-of-range values are primitive-restart markers that end a strip.
 */
function pushTriangleStrip(
  corners: number[],
  corner: CornerOf,
  first: number,
  count: number,
  vertexCount: number,
): void {
  let start = 0;
  for (let k = 0; k + 2 < count; k += 1) {
    const a = corner(first + k);
    const b = corner(first + k + 1);
    const c = corner(first + k + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      start = k + 1;
      continue;
    }
    if (a === b || b === c || a === c) continue;
    if ((k - start) % 2 === 0) corners.push(a, b, c);
    else corners.push(b, a, c);
  }
}

/**
 * Triangle corners of every triangle-list and triangle-strip submesh. Line and
 * point submeshes contribute nothing but share the derived stream. The whole
 * index buffer is reused when one triangle-list range covers it.
 */
function surfaceTriangles(
  submeshes: readonly Submesh[],
  indices: Uint16Array | Uint32Array | undefined,
  vertexCount: number,
): Uint16Array | Uint32Array | undefined {
  const whole = wholeTriangleList(submeshes, indices);
  if (whole !== undefined) return whole.length === 0 ? undefined : whole;
  const corners: number[] = [];
  const corner: CornerOf = (position) =>
    indices === undefined ? position : (indices[position] ?? 0);
  for (const submesh of submeshes) {
    const first = indices === undefined ? 0 : submesh.indexOffset;
    const count = indices === undefined ? submesh.vertexCount : submesh.indexCount;
    if (submesh.topology === 'triangle-list') pushTriangleList(corners, corner, first, count);
    else if (submesh.topology === 'triangle-strip')
      pushTriangleStrip(corners, corner, first, count, vertexCount);
  }
  return corners.length === 0 ? undefined : Uint32Array.from(corners);
}

/** Area-weighted (smooth across shared indices) unit normals; [0, 0, 1] where none exists. */
function areaWeightedNormals(
  positions: Float32Array,
  triangles: Uint16Array | Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let k = 0; k + 2 < triangles.length; k += 3) {
    const a = (triangles[k] ?? 0) * 3;
    const b = (triangles[k + 1] ?? 0) * 3;
    const c = (triangles[k + 2] ?? 0) * 3;
    const ax = positions[a] ?? 0;
    const ay = positions[a + 1] ?? 0;
    const az = positions[a + 2] ?? 0;
    const e1x = (positions[b] ?? 0) - ax;
    const e1y = (positions[b + 1] ?? 0) - ay;
    const e1z = (positions[b + 2] ?? 0) - az;
    const e2x = (positions[c] ?? 0) - ax;
    const e2y = (positions[c + 1] ?? 0) - ay;
    const e2z = (positions[c + 2] ?? 0) - az;
    // The unnormalized cross product weights each face by twice its area.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    addVec3(normals, a, nx, ny, nz);
    addVec3(normals, b, nx, ny, nz);
    addVec3(normals, c, nx, ny, nz);
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    if (!normalizeInPlace(normals, offset)) normals.set(Z_AXIS, offset);
  }
  return normals;
}

const Z_AXIS = [0, 0, 1] as const;

function addVec3(values: Float32Array, offset: number, x: number, y: number, z: number): void {
  values[offset] = (values[offset] ?? 0) + x;
  values[offset + 1] = (values[offset + 1] ?? 0) + y;
  values[offset + 2] = (values[offset + 2] ?? 0) + z;
}

function normalizeInPlace(values: Float32Array, offset: number): boolean {
  const x = values[offset] ?? 0;
  const y = values[offset + 1] ?? 0;
  const z = values[offset + 2] ?? 0;
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-12) || !Number.isFinite(length)) return false;
  values[offset] = x / length;
  values[offset + 1] = y / length;
  values[offset + 2] = z / length;
  return true;
}

/**
 * Unit per-vertex frame normals for tangent derivation. Authored normals are
 * normalized; a zero or non-finite one (unused vertex, degenerate triangle)
 * takes the derived face normal, so one vertex never voids the mesh's frame.
 */
function frameNormals(
  authored: Float32Array | undefined,
  positions: Float32Array,
  triangles: Uint16Array | Uint32Array,
): Float32Array {
  if (authored === undefined) return areaWeightedNormals(positions, triangles);
  const normals = authored.slice();
  let derived: Float32Array | undefined;
  for (let offset = 0; offset < normals.length; offset += 3) {
    if (normalizeInPlace(normals, offset)) continue;
    derived ??= areaWeightedNormals(positions, triangles);
    normals.set(derived.subarray(offset, offset + 3), offset);
  }
  return normals;
}

/**
 * Stock surface programs read normal, uv and tangent at fixed locations, so an
 * omitted member would leave their vertex state invalid at draw time. Meshes
 * with triangle submeshes derive the missing members once here: smooth
 * area-weighted normals, zero UVs, then UV tangents with a per-vertex
 * normal-plane frame wherever the UVs define none. Authored values are kept
 * verbatim, and every input yields a unit tangent, so completion never fails.
 */
function completeSurfaceStream(
  source: VertexAttributeMap,
  positions: Float32Array,
  submeshes: readonly Submesh[],
  indices: Uint16Array | Uint32Array | undefined,
): VertexAttributeMap {
  if (source.normal !== undefined && source.uv !== undefined && source.tangent !== undefined)
    return source;
  const vertexCount = positions.length / 3;
  const triangles = surfaceTriangles(submeshes, indices, vertexCount);
  if (triangles === undefined) return source;
  const authoredNormal = source.normal instanceof Float32Array ? source.normal : undefined;
  const unitNormals = frameNormals(authoredNormal, positions, triangles);
  const normal = authoredNormal ?? unitNormals;
  const uv = source.uv instanceof Float32Array ? source.uv : new Float32Array(vertexCount * 2);
  if (source.tangent !== undefined) return { ...source, normal, uv };
  // Unit normals and validated triangles leave only "no UV basis anywhere" as a
  // kernel failure; that case takes the per-vertex normal-plane frame below.
  const uvTangents = computeTangentVec4(positions, unitNormals, uv, triangles);
  if (uvTangents.ok) return { ...source, normal, uv, tangent: uvTangents.value };
  const tangent = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const n = vertex * 3;
    // Unit normals always admit a normal-plane frame.
    writeNormalPlaneTangent(
      tangent,
      vertex * 4,
      unitNormals[n] ?? 0,
      unitNormals[n + 1] ?? 0,
      unitNormals[n + 2] ?? 1,
    );
    tangent[vertex * 4 + 3] = 1;
  }
  return { ...source, normal, uv, tangent };
}

/**
 * Create a geometry-owned builder. All derived facts are computed once in
 * `build()` from the accumulated canonical attribute source.
 */
export function createMeshBuilder(options: MeshBuilderOptions = {}): MeshBuilder {
  const attributes: Partial<Record<AttributeKey, AttributeView>> = {};
  const indices: number[] = [];
  const submeshes: MeshBuilderSubmesh[] = [];
  const materialSlots = copySlots(options.materialSlots);

  const appendVertices = (batch: VertexAttributeMap): Result<void, AssetError> => {
    const captured: VertexAttributeMap = Object.fromEntries(
      CANONICAL_KEYS.map((key) => [key, batch[key]]),
    );
    const checked = validateAttributeBatch(captured);
    if (!checked.ok) return checked;
    const incomingKeys = checked.value.map(([key]) => key);
    const existingKeys = Object.keys(attributes);
    if (existingKeys.length > 0 && existingKeys.join('|') !== incomingKeys.join('|')) {
      return failure(
        'attributes',
        incomingKeys.join(','),
        'every appended batch must carry the same canonical keys',
      );
    }
    for (const [key, view] of checked.value) {
      const cloned = view.slice();
      const previous = attributes[key];
      attributes[key] = previous === undefined ? cloned : appendArray(previous, cloned);
    }
    return ok(undefined);
  };

  const appendIndices = (batch: ArrayLike<number>): Result<void, AssetError> => {
    for (let index = 0; index < batch.length; index += 1) {
      const value = Number(batch[index]);
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        return failure('indices', value, `indices[${index}] must be an integer in [0, 2^32-1]`);
      }
      indices.push(value);
    }
    return ok(undefined);
  };

  const addSubmesh = (submesh: MeshBuilderSubmesh): Result<void, AssetError> => {
    if (submesh === null || typeof submesh !== 'object') {
      return failure('submeshes', submesh, 'entry must be an object');
    }
    submeshes.push({ ...submesh });
    return ok(undefined);
  };

  const build = (): Result<MeshAsset, AssetError> => {
    // appendVertices admits and copies every channel; only private owned arrays remain here.
    const positionView = attributes.position;
    if (positionView === undefined)
      return failure('attributes', [], 'at least one canonical attribute is required');
    if (!(positionView instanceof Float32Array))
      return failure('attributes.position', typeof positionView, 'position storage is invalid');
    const slotCheck = validateSlots(materialSlots);
    if (!slotCheck.ok) return slotCheck;
    const vertexCount = positionView.length / 3;

    let maxIndex = 0;
    for (const value of indices) maxIndex = Math.max(maxIndex, value);
    const indexArray =
      indices.length === 0
        ? undefined
        : maxIndex <= 0xffff
          ? new Uint16Array(indices)
          : new Uint32Array(indices);
    if (indexArray !== undefined) {
      for (let index = 0; index < indexArray.length; index += 1) {
        const value = indexArray[index];
        if (value === undefined || value >= vertexCount) {
          return failure(
            'indices',
            value ?? -1,
            `indices[${index}] must be less than vertexCount (${vertexCount})`,
          );
        }
      }
    }

    const ranges = completedSubmeshes(
      submeshes,
      vertexCount,
      indexArray?.length ?? 0,
      materialSlots.length,
    );
    if (!ranges.ok) return ranges;
    const source = completeSurfaceStream(
      attributes as VertexAttributeMap,
      positionView,
      ranges.value,
      indexArray,
    );
    const packed = packInterleavedVertexAttributes(source, vertexCount);
    if (!packed.ok) return packed;
    const aabb = box3.fromPositions(box3.create(), positionView);
    const copiedAttributes: VertexAttributeMap = {};
    for (const key of attributeKeys(source)) {
      const value = source[key] as AttributeView | undefined;
      if (value === undefined) continue;
      const cloned = value.slice();
      if (key === 'skinIndex') {
        if (!(cloned instanceof Uint16Array)) {
          return failure(key, typeof value, 'skinIndex storage must be Uint16Array');
        }
        copiedAttributes.skinIndex = cloned;
      } else {
        if (!(cloned instanceof Float32Array)) {
          return failure(key, typeof value, `${key} storage must be Float32Array`);
        }
        copiedAttributes[key] = cloned;
      }
    }
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: packed.value.vertices,
      ...(indexArray === undefined ? {} : { indices: indexArray }),
      attributes: copiedAttributes,
      aabb,
      submeshes: ranges.value,
      materialSlots: Object.freeze(materialSlots.map((slot) => ({ ...slot }))),
    };
    return ok(Object.freeze(mesh));
  };

  if (options.attributes !== undefined) {
    const result = appendVertices(options.attributes);
    if (!result.ok) {
      // Keep construction side-effect free; the structured error is surfaced
      // by build() because the builder itself intentionally has no throw path.
      const constructionError = result.error;
      return {
        appendVertices,
        appendIndices,
        addSubmesh,
        build: () => err(constructionError),
      };
    }
  }
  if (options.indices !== undefined) {
    const result = appendIndices(options.indices);
    if (!result.ok) {
      const constructionError = result.error;
      return {
        appendVertices,
        appendIndices,
        addSubmesh,
        build: () => err(constructionError),
      };
    }
  }
  for (const submesh of options.submeshes ?? []) submeshes.push({ ...submesh });
  return { appendVertices, appendIndices, addSubmesh, build };
}
