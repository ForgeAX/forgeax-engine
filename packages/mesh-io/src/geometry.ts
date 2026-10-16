import {
  computeTangentVec4,
  createMeshBuilder,
  writeNormalPlaneTangent,
} from '@forgeax/engine-geometry';
import {
  type AssetError,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { formatFailure } from './errors.js';

export interface ImportedMesh {
  readonly name: string;
  readonly mesh: MeshAsset;
}

export interface MeshExportMaterial {
  readonly name?: string;
  readonly color?: readonly [number, number, number];
  readonly opacity?: number;
  readonly metallic?: number;
  readonly roughness?: number;
  readonly doubleSided?: boolean;
}

/** A static mesh placement, in engine units and column-major world coordinates. */
export interface MeshExportItem {
  readonly name: string;
  readonly mesh: MeshAsset;
  readonly matrix?: readonly number[];
  readonly materials?: readonly MeshExportMaterial[];
}

export function geometryToMesh(geometry: BufferGeometry): Result<MeshAsset, AssetError> {
  if (geometry.getAttribute('normal') === undefined) geometry.computeVertexNormals();
  const attributes: VertexAttributeMap = {};
  for (const [name, key] of [
    ['position', 'position'],
    ['normal', 'normal'],
    ['uv', 'uv'],
    ['color', 'color'],
  ] as const) {
    const attribute = geometry.getAttribute(name);
    if (attribute === undefined) continue;
    const values = new Float32Array(attribute.count * (name === 'color' ? 4 : attribute.itemSize));
    for (let i = 0; i < attribute.count; i++) {
      const components = name === 'color' ? 4 : attribute.itemSize;
      for (let component = 0; component < components; component++) {
        values[i * components + component] =
          component === 3 && attribute.itemSize === 3 ? 1 : attribute.getComponent(i, component);
      }
    }
    attributes[key] = values;
  }
  const count = geometry.getAttribute('position')?.count ?? 0;
  if (count > 10_000_000) return formatFailure('position', 'mesh exceeds ten million vertices');
  const indices =
    geometry.index === null
      ? Uint32Array.from({ length: count }, (_, i) => i)
      : Uint32Array.from(geometry.index.array);
  // Publish the Standard vertex contract at import, as the glTF bridge does.
  // Missing/collapsed UVs cannot define texture orientation. Use a finite
  // normal-plane basis only when the shared UV-derived kernel rejects that case.
  attributes.uv ??= new Float32Array(count * 2);
  const tangents = computeTangentVec4(
    attributes.position as Float32Array,
    attributes.normal as Float32Array,
    attributes.uv as Float32Array,
    indices,
  );
  if (tangents.ok) attributes.tangent = tangents.value;
  else {
    const normals = attributes.normal as Float32Array;
    const basis = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const nx = normals[i * 3] ?? 0,
        ny = normals[i * 3 + 1] ?? 0,
        nz = normals[i * 3 + 2] ?? 0;
      if (!writeNormalPlaneTangent(basis, i * 4, nx, ny, nz))
        return formatFailure('normal', 'triangle normals must define a finite tangent plane');
      basis[i * 4 + 3] = 1;
    }
    attributes.tangent = basis;
  }
  const groups =
    geometry.groups.length === 0
      ? [{ start: 0, count: indices.length, materialIndex: 0 }]
      : geometry.groups;
  if (groups.some((group) => group.count % 3 !== 0))
    return formatFailure('groups', 'only complete triangle-list groups are supported');
  const slots = Array.from(
    { length: Math.max(...groups.map((group) => group.materialIndex ?? 0)) + 1 },
    (_, i) => ({ slotName: `Material_${i}` }),
  );
  return createMeshBuilder({
    attributes,
    indices,
    materialSlots: slots,
    submeshes: groups.map((group) => ({
      indexOffset: group.start,
      indexCount: group.count,
      vertexCount: count,
      materialSlot: group.materialIndex ?? 0,
      topology: 'triangle-list',
    })),
  }).build();
}

export function exportObject(
  items: readonly MeshExportItem[],
  bakeMirroredWinding: boolean,
): Result<Object3D, AssetError> {
  if (items.length === 0) return formatFailure('items', 'at least one mesh is required');
  const root = new Object3D();
  for (const item of items) {
    for (const source of item.materials ?? []) {
      if (
        [source.opacity ?? 1, source.metallic ?? 0, source.roughness ?? 1].some(
          (value) => !Number.isFinite(value) || value < 0 || value > 1,
        ) ||
        source.color?.some((value) => !Number.isFinite(value) || value < 0)
      )
        return formatFailure(
          'material',
          'finite nonnegative color and opacity/metallic/roughness in [0, 1] are required',
        );
    }
    if (
      item.mesh.submeshes.some((submesh) => submesh.topology !== 'triangle-list') ||
      item.mesh.attributes.skinIndex !== undefined ||
      item.mesh.morphTargets !== undefined
    )
      return formatFailure(
        item.name,
        'static triangle meshes are required; bake skins and morphs before exporting',
      );
    const checked = createMeshBuilder({
      attributes: item.mesh.attributes,
      ...(item.mesh.indices === undefined ? {} : { indices: item.mesh.indices }),
      submeshes: item.mesh.submeshes,
      materialSlots: item.mesh.materialSlots,
    }).build();
    if (!checked.ok) return checked;
    const canonical = checked.value;
    if (
      item.matrix !== undefined &&
      (item.matrix.length !== 16 || !item.matrix.every(Number.isFinite))
    )
      return formatFailure('matrix', 'world matrix requires sixteen finite values');
    const matrix = item.matrix === undefined ? new Matrix4() : new Matrix4().fromArray(item.matrix);
    const geometry = new BufferGeometry();
    for (const [key, semantic, size] of [
      ['position', 'position', 3],
      ['normal', 'normal', 3],
      ['uv', 'uv', 2],
      ['uv1', 'uv1', 2],
      ['uv2', 'uv2', 2],
      ['uv3', 'uv3', 2],
      ['uv4', 'TEXCOORD_4', 2],
      ['uv5', 'TEXCOORD_5', 2],
      ['uv6', 'TEXCOORD_6', 2],
      ['uv7', 'TEXCOORD_7', 2],
      ['color', 'color', 4],
      ['tangent', 'tangent', 4],
    ] as const) {
      const attribute = canonical.attributes[key];
      if (attribute === undefined) continue;
      if (!(attribute instanceof Float32Array))
        return formatFailure(
          `${item.name}.${key}`,
          'export requires materialized float attributes',
        );
      geometry.setAttribute(semantic, new BufferAttribute(attribute, size));
    }
    if (canonical.indices !== undefined)
      geometry.setIndex(new BufferAttribute(canonical.indices, 1));
    if (bakeMirroredWinding && matrix.determinant() < 0) {
      const indices =
        canonical.indices?.slice() ??
        Uint32Array.from(
          { length: (canonical.attributes.position?.byteLength ?? 0) / 12 },
          (_, index) => index,
        );
      for (let index = 0; index < indices.length; index += 3) {
        const first = indices[index] ?? 0;
        indices[index] = indices[index + 2] ?? 0;
        indices[index + 2] = first;
      }
      geometry.setIndex(new BufferAttribute(indices, 1));
    }
    for (const submesh of canonical.submeshes)
      geometry.addGroup(
        submesh.indexOffset,
        submesh.indexCount || submesh.vertexCount,
        submesh.materialSlot,
      );
    const materials = item.mesh.materialSlots.map((slot, i) => {
      const source = item.materials?.[i] ?? {};
      const material = new MeshStandardMaterial({
        name: source.name ?? slot.slotName,
        opacity: source.opacity ?? 1,
        metalness: source.metallic ?? 0,
        roughness: source.roughness ?? 1,
        transparent: (source.opacity ?? 1) < 1,
        side: source.doubleSided ? 2 : 0,
        vertexColors: geometry.hasAttribute('color'),
      });
      if (source.color !== undefined) material.color.setRGB(...source.color);
      return material;
    });
    const mesh = new Mesh(geometry, materials);
    mesh.name = item.name.replace(/[\r\n]/g, '_');
    if (item.matrix !== undefined) {
      mesh.matrix.copy(matrix);
      mesh.matrixAutoUpdate = false;
    }
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  return ok(root);
}
