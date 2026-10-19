import type {
  AssetGuid,
  MeshAsset,
  MeshCardLayout,
  MeshMaterialSlot,
  MorphTarget,
  Submesh,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import { PROCEDURAL_FLOATS_PER_VERTEX } from '../box';
import { admitsMeshCardLayout, validateMeshCardLayout } from '../mesh-card-artifact';
import { validateMeshCollisionAttachment } from '../mesh-collision';
import { deriveVertexLayoutProjection } from '../vertex-attribute-layout';

import { type UnpackedMeshBin, unpackMeshBin } from './mesh-bin';

type PackedMaterialSlots = readonly (UnpackedMeshBin['materialSlots'][number] & {
  /** Direct Pack JSON keeps the authoring GUID until the producer boundary. */
  readonly defaultMaterial?: string;
})[];

function parseGuid(value: string): AssetGuid | undefined {
  const compact = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = compact.slice(index * 2, index * 2 + 2);
    const parsed = Number.parseInt(pair, 16);
    if (!Number.isInteger(parsed)) return undefined;
    bytes[index] = parsed;
  }
  return bytes as AssetGuid;
}

function floatArray(value: unknown): Float32Array | undefined {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return new Float32Array(value as number[]);
  return undefined;
}

function indexArray(value: unknown): Uint16Array | Uint32Array | undefined {
  if (value instanceof Uint16Array || value instanceof Uint32Array) {
    return value.length === 0 ? undefined : value;
  }
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return undefined;
  return value.some((entry) => entry > 0xffff)
    ? new Uint32Array(value as number[])
    : new Uint16Array(value as number[]);
}

function integerArray(value: unknown): Uint16Array | undefined {
  if (value instanceof Uint16Array) return value;
  if (Array.isArray(value)) return new Uint16Array(value as number[]);
  return undefined;
}

function morphTargets(value: unknown): readonly MorphTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined;
  const targets: MorphTarget[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return undefined;
    const target: { position?: Float32Array; normal?: Float32Array; tangent?: Float32Array } = {};
    for (const [key, stream] of Object.entries(raw as Record<string, unknown>)) {
      if (key !== 'position' && key !== 'normal' && key !== 'tangent') return undefined;
      const typed = floatArray(stream);
      if (typed === undefined) return undefined;
      if (key === 'position') target.position = typed;
      else if (key === 'normal') target.normal = typed;
      else target.tangent = typed;
    }
    if (Object.keys(target).length === 0) return undefined;
    targets.push(target);
  }
  return targets;
}

function materialSlotsFor(
  raw: PackedMaterialSlots | undefined,
  submeshes: readonly Submesh[],
  refs: readonly string[],
): readonly MeshMaterialSlot[] {
  if (raw === undefined)
    return submeshes.map((_submesh, index) => ({ slotName: `LegacySlot_${index}` }));
  return raw.map((slot, index) => {
    const reference =
      slot.defaultMaterialRef === undefined ? slot.defaultMaterial : refs[slot.defaultMaterialRef];
    const defaultMaterial = reference === undefined ? undefined : parseGuid(reference);
    return {
      slotName:
        typeof slot.slotName === 'string' && slot.slotName.trim().length > 0
          ? slot.slotName
          : `LegacySlot_${index}`,
      ...(typeof slot.sourceKey === 'string' ? { sourceKey: slot.sourceKey } : {}),
      ...(defaultMaterial === undefined ? {} : { defaultMaterial }),
    };
  });
}

function submeshesFor(
  raw: readonly Record<string, unknown>[] | undefined,
  vertexCount: number,
  indexCount: number,
): readonly Submesh[] {
  const values =
    raw === undefined || raw.length === 0
      ? [{ indexOffset: 0, indexCount, vertexCount, topology: 'triangle-list' }]
      : raw;
  return values.map((value, index) => ({
    indexOffset: typeof value.indexOffset === 'number' ? value.indexOffset : 0,
    indexCount: typeof value.indexCount === 'number' ? value.indexCount : indexCount,
    vertexCount: typeof value.vertexCount === 'number' ? value.vertexCount : vertexCount,
    topology:
      value.topology === 'line-list' ||
      value.topology === 'line-strip' ||
      value.topology === 'point-list' ||
      value.topology === 'triangle-strip'
        ? value.topology
        : 'triangle-list',
    materialSlot: typeof value.materialSlot === 'number' ? value.materialSlot : index,
  }));
}

function deriveAabb(vertices: Float32Array, stride: number): Float32Array | undefined {
  if (stride < 3 || vertices.length < 3 || vertices.length % stride !== 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < vertices.length; offset += stride) {
    const x = vertices[offset];
    const y = vertices[offset + 1];
    const z = vertices[offset + 2];
    if (x === undefined || y === undefined || z === undefined) return undefined;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return Float32Array.of(minX, minY, minZ, maxX, maxY, maxZ);
}

function meshFromParts(
  parts: {
    readonly vertices: unknown;
    readonly indices?: unknown;
    readonly attributes?: unknown;
    readonly aabb?: unknown;
    readonly submeshes?: readonly Record<string, unknown>[];
    readonly cardLayout?: MeshCardLayout;
    readonly collision?: unknown;
    readonly materialSlots?: PackedMaterialSlots;
    readonly morphTargets?: unknown;
    readonly morphWeights?: unknown;
    readonly floatsPerVertex?: number;
    readonly uvSetCount?: number;
  },
  refs: readonly string[],
): MeshAsset | undefined {
  const vertices = floatArray(parts.vertices);
  if (vertices === undefined || vertices.length === 0) return undefined;
  const indices = indexArray(parts.indices);
  const sourceAttributes =
    parts.attributes !== null && typeof parts.attributes === 'object'
      ? (parts.attributes as Record<string, unknown>)
      : {};
  const attributes: VertexAttributeMap = {};
  for (const key of [
    'position',
    'normal',
    'uv',
    'tangent',
    'uv1',
    'uv2',
    'uv3',
    'uv4',
    'uv5',
    'uv6',
    'uv7',
    'color',
  ] as const) {
    const value = floatArray(sourceAttributes[key]);
    if (value !== undefined) attributes[key] = value;
  }
  const skinIndex = integerArray(sourceAttributes.skinIndex);
  const skinWeight = floatArray(sourceAttributes.skinWeight);
  if (skinIndex !== undefined) attributes.skinIndex = skinIndex;
  if (skinWeight !== undefined) attributes.skinWeight = skinWeight;
  const stride = parts.floatsPerVertex ?? 0;
  const vertexCount = stride > 0 ? vertices.length / stride : vertices.length;
  const submeshes = submeshesFor(parts.submeshes, vertexCount, indices?.length ?? 0);
  if (parts.submeshes?.some((section) => section.cardLayout !== undefined)) return undefined;
  if (
    parts.cardLayout !== undefined &&
    (!validateMeshCardLayout(parts.cardLayout).ok ||
      !admitsMeshCardLayout({
        submeshes,
        morphTargets: parts.morphTargets,
        skinIndex: attributes.skinIndex,
      }))
  )
    return undefined;
  const materialSlots = materialSlotsFor(parts.materialSlots, submeshes, refs);
  const aabb = floatArray(parts.aabb) ?? deriveAabb(vertices, stride);
  if (aabb === undefined) return undefined;
  const morph = morphTargets(parts.morphTargets);
  const weights = floatArray(parts.morphWeights);
  if (morph !== undefined && weights !== undefined && morph.length !== weights.length)
    return undefined;
  const uvSetCount = parts.uvSetCount ?? 1;
  if (stride > 0 && uvSetCount > 1) {
    const hasSkin = stride === 18 + (uvSetCount - 1) * 2;
    const firstOffset = hasSkin ? 18 : PROCEDURAL_FLOATS_PER_VERTEX;
    const extraUvKeys = ['uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7'] as const;
    for (let set = 1; set < uvSetCount; set += 1) {
      const key = extraUvKeys[set - 1];
      if (key === undefined) return undefined;
      const values = new Float32Array(vertexCount * 2);
      const sourceOffset = firstOffset + (set - 1) * 2;
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const source = vertex * stride + sourceOffset;
        values[vertex * 2] = vertices[source] ?? 0;
        values[vertex * 2 + 1] = vertices[source + 1] ?? 0;
      }
      attributes[key] = values;
    }
  }
  const collision =
    parts.collision === undefined
      ? undefined
      : validateMeshCollisionAttachment(
          {
            kind: 'mesh',
            vertices,
            attributes,
            submeshes,
            materialSlots,
            ...(indices === undefined ? {} : { indices }),
            ...(morph === undefined ? {} : { morphTargets: morph }),
          },
          parts.collision,
        );
  if (collision !== undefined && !collision.ok) return undefined;
  return {
    kind: 'mesh',
    vertices,
    ...(indices === undefined ? {} : { indices }),
    attributes,
    aabb,
    submeshes,
    ...(collision?.ok ? { collision: collision.value } : {}),
    ...(parts.cardLayout === undefined ? {} : { cardLayout: parts.cardLayout }),
    materialSlots,
    ...(morph === undefined ? {} : { morphTargets: morph }),
    ...(weights === undefined ? {} : { morphWeights: weights }),
  };
}

export function decodeMeshBinary(
  bytes: Uint8Array,
  refs: readonly string[],
): MeshAsset | undefined {
  const decoded = unpackMeshBin(bytes);
  if (!decoded.ok) return undefined;
  return meshFromParts(
    {
      ...decoded.value,
      floatsPerVertex: decoded.value.projection.arrayStride / Float32Array.BYTES_PER_ELEMENT,
    },
    refs,
  );
}

export function normalizeMeshPayload(
  payload: unknown,
  refs: readonly string[],
): MeshAsset | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const source = payload as Record<string, unknown>;
  if (source.kind !== 'mesh' || source.distanceField !== undefined) return undefined;
  const sourceAttributes =
    source.attributes !== null && typeof source.attributes === 'object'
      ? (source.attributes as VertexAttributeMap)
      : undefined;
  const projection =
    sourceAttributes === undefined ? undefined : deriveVertexLayoutProjection(sourceAttributes);
  const floatsPerVertex =
    projection === undefined || projection.attributes.length === 0
      ? PROCEDURAL_FLOATS_PER_VERTEX
      : projection.arrayStride / Float32Array.BYTES_PER_ELEMENT;
  return meshFromParts(
    {
      vertices: source.vertices,
      ...(source.collision === undefined ? {} : { collision: source.collision }),
      ...(source.cardLayout === undefined
        ? {}
        : { cardLayout: source.cardLayout as MeshCardLayout }),
      ...(source.indices === undefined ? {} : { indices: source.indices }),
      ...(source.attributes === undefined ? {} : { attributes: source.attributes }),
      ...(source.aabb === undefined ? {} : { aabb: source.aabb }),
      submeshes: Array.isArray(source.submeshes)
        ? (source.submeshes as Record<string, unknown>[])
        : [],
      ...(Array.isArray(source.materialSlots)
        ? { materialSlots: source.materialSlots as PackedMaterialSlots }
        : {}),
      ...(source.morphTargets === undefined ? {} : { morphTargets: source.morphTargets }),
      ...(source.morphWeights === undefined ? {} : { morphWeights: source.morphWeights }),
      floatsPerVertex,
    },
    refs,
  );
}
