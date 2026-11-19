import {
  deriveVertexLayoutProjection,
  type ReadonlyMeshAttributeWindow,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { WaterDependencySnapshot } from './contracts.js';

export interface WaterDependencyMeshView {
  readonly position: ReadonlyMeshAttributeWindow;
  readonly color?: ReadonlyMeshAttributeWindow;
  readonly indices: readonly number[];
  readonly submeshes: readonly Readonly<{
    topology: string;
    indexOffset: number;
    indexCount: number;
  }>[];
}

function frozenNumbers(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) && Object.isFrozen(value) && value.every((v) => typeof v === 'number')
  );
}

interface DependencyMeshRecord {
  readonly attributeStorage?: 'interleaved';
  readonly vertices?: unknown;
  readonly attributes: Record<string, unknown>;
  readonly indices?: unknown;
  readonly submeshes: readonly unknown[];
}

function dependencyMeshRecord(value: unknown): DependencyMeshRecord | undefined {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return undefined;
  const mesh = value as {
    kind?: unknown;
    attributeStorage?: unknown;
    vertices?: unknown;
    attributes?: Record<string, unknown>;
    indices?: unknown;
    submeshes?: unknown;
  };
  if (
    mesh.kind !== 'mesh' ||
    !mesh.attributes ||
    typeof mesh.attributes !== 'object' ||
    !Object.isFrozen(mesh.attributes) ||
    !Array.isArray(mesh.submeshes) ||
    !Object.isFrozen(mesh.submeshes) ||
    (mesh.attributeStorage !== undefined && mesh.attributeStorage !== 'interleaved')
  )
    return undefined;
  return mesh as DependencyMeshRecord;
}

function validInterleavedStorage(
  mesh: DependencyMeshRecord,
  layout: VertexLayoutProjection,
  kinds: WaterDependencySnapshot['payloadArrayKinds'],
): boolean {
  if (mesh.attributeStorage !== 'interleaved') return true;
  return !(
    !frozenNumbers(mesh.vertices) ||
    kinds?.vertices !== 'float32' ||
    layout.arrayStride === 0 ||
    (mesh.vertices.length * 4) % layout.arrayStride !== 0 ||
    layout.attributes.some((entry) => {
      const declaration = mesh.attributes?.[entry.key];
      const kind =
        entry.format === 'uint32' ? 'uint32' : entry.format === 'uint16x4' ? 'uint16' : 'float32';
      return (
        !frozenNumbers(declaration) ||
        declaration.length !== 0 ||
        kinds?.attributes?.[entry.key] !== kind
      );
    })
  );
}

function attributeWindow(
  mesh: DependencyMeshRecord,
  layout: VertexLayoutProjection,
  kinds: WaterDependencySnapshot['payloadArrayKinds'],
  key: 'position' | 'color',
): ReadonlyMeshAttributeWindow | undefined {
  const interleaved = mesh.attributeStorage === 'interleaved';
  const entry = layout.attributes.find((row) => row.key === key);
  if (!entry || kinds?.attributes?.[key] !== 'float32') return undefined;
  const data = interleaved ? mesh.vertices : mesh.attributes?.[key];
  if (!frozenNumbers(data)) return undefined;
  const components = entry.byteLength / 4;
  const stride = interleaved ? layout.arrayStride / 4 : components;
  const count = data.length / stride;
  const offset = interleaved ? entry.offset / 4 : 0;
  if (!Number.isSafeInteger(count) || count === 0) return undefined;
  for (let vertex = 0; vertex < count; vertex++)
    for (let component = 0; component < components; component++) {
      const v = data[offset + vertex * stride + component];
      if (v === undefined || !Number.isFinite(v) || !Number.isFinite(Math.fround(v)))
        return undefined;
    }
  return Object.freeze({ data, offset, stride, components, count });
}

function validIndices(
  indices: unknown,
  kinds: WaterDependencySnapshot['payloadArrayKinds'],
  vertexCount: number,
): indices is readonly number[] {
  const maximumIndex =
    kinds?.indices === 'uint16' ? 0xffff : kinds?.indices === 'uint32' ? 0xffffffff : -1;
  return (
    frozenNumbers(indices) &&
    indices.length > 0 &&
    maximumIndex >= 0 &&
    indices.every((i) => Number.isSafeInteger(i) && i >= 0 && i <= maximumIndex && i < vertexCount)
  );
}

type DependencySubmesh = WaterDependencyMeshView['submeshes'][number];

function validSubmeshRange(value: unknown, indexCount: number): value is DependencySubmesh {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  const row = value as { topology?: unknown; indexOffset?: unknown; indexCount?: unknown };
  if (
    typeof row.topology !== 'string' ||
    typeof row.indexOffset !== 'number' ||
    typeof row.indexCount !== 'number' ||
    !Number.isSafeInteger(row.indexOffset) ||
    !Number.isSafeInteger(row.indexCount) ||
    row.indexOffset < 0 ||
    row.indexCount < 0 ||
    row.indexOffset + row.indexCount > indexCount
  )
    return false;
  return row.topology !== 'triangle-list' || row.indexCount % 3 === 0;
}

function validTriangleSubmeshes(
  submeshes: readonly unknown[],
  indexCount: number,
): submeshes is WaterDependencyMeshView['submeshes'] {
  let hasTriangles = false;
  for (const row of submeshes) {
    if (!validSubmeshRange(row, indexCount)) return false;
    if (row.topology === 'triangle-list') {
      hasTriangles ||= row.indexCount > 0;
    }
  }
  return hasTriangles;
}

/** Reads the immutable dependency backing directly, using Geometry's canonical layout.
 * Packed integer lanes are never interpreted as finite float attributes. */
export function waterDependencyMeshView(
  value: unknown,
  kinds: WaterDependencySnapshot['payloadArrayKinds'],
): WaterDependencyMeshView | undefined {
  const mesh = dependencyMeshRecord(value);
  if (!mesh) return undefined;
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  if (!validInterleavedStorage(mesh, layout, kinds)) return undefined;
  const position = attributeWindow(mesh, layout, kinds, 'position');
  const color = attributeWindow(mesh, layout, kinds, 'color');
  if (
    !position ||
    (mesh.attributes.color !== undefined && (!color || color.count !== position.count))
  )
    return undefined;
  const indices = mesh.indices;
  if (!validIndices(indices, kinds, position.count)) return undefined;
  if (!validTriangleSubmeshes(mesh.submeshes, indices.length)) return undefined;
  return Object.freeze({
    position,
    ...(color ? { color } : {}),
    indices,
    submeshes: mesh.submeshes,
  });
}
