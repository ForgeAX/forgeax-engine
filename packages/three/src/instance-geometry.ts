import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import {
  BatchedMesh,
  type Camera,
  Color,
  InstancedMesh,
  type Material,
  Matrix3,
  Matrix4,
  Vector3,
} from 'three/src/Three.Core.js';
import { invalid } from './errors';

interface Instance {
  readonly matrix: Matrix4;
  readonly color: readonly number[];
  readonly weights?: readonly number[];
  readonly start?: number;
  readonly count?: number;
}

/** r184 source layout. Only source data is read; native Mesh owns GPU storage/draws. */
interface BatchSource {
  /** @internal Upstream draw roster. */
  _multiDrawCount: number;
  /** @internal Upstream draw offsets. */
  _multiDrawStarts: Int32Array;
  /** @internal Upstream draw sizes. */
  _multiDrawCounts: Int32Array;
  /** @internal Upstream instance lookup. */
  _indirectTexture: { image: { data: Uint32Array } };
  /** @internal Upstream transform version. */
  _matricesTexture: { version: number };
  /** @internal Upstream color version. */
  _colorsTexture: { version: number } | null;
}

export function instanceGeometryValues(
  mesh: InstancedMesh | BatchedMesh,
  camera: Camera,
  material: Material,
): unknown[] {
  if (mesh instanceof InstancedMesh)
    return [
      mesh.instanceMatrix.array,
      mesh.instanceMatrix.version,
      mesh.instanceColor?.array,
      mesh.instanceColor?.version,
      mesh.morphTexture,
      mesh.morphTexture?.version,
      mesh.count,
    ];
  // Reuse the upstream CPU roster, including holes, visibility, sorting and culling.
  BatchedMesh.prototype.onBeforeRender.call(
    mesh,
    undefined as never,
    undefined as never,
    camera,
    mesh.geometry,
    material,
    undefined as never,
  );
  const source = mesh as unknown as BatchSource;
  return [
    source._matricesTexture.version,
    source._colorsTexture?.version,
    source._multiDrawCount,
    ...source._multiDrawStarts.subarray(0, source._multiDrawCount),
    ...source._multiDrawCounts.subarray(0, source._multiDrawCount),
    ...source._indirectTexture.image.data.subarray(0, source._multiDrawCount),
  ];
}

/** Per-instance attributes have no native stream yet. Expand ordinary Mesh source
 * data once per source revision, keeping the same material and one native draw.
 * This intentionally trades CPU/upload memory for compatibility, not a second renderer.
 */
export function projectInstanceGeometry(
  mesh: InstancedMesh | BatchedMesh,
  base: MeshAsset,
): MeshAsset | undefined {
  const entries: Instance[] = [];
  const color = new Color();
  if (mesh instanceof InstancedMesh) {
    const morph = { morphTargetInfluences: [] as number[] };
    for (let index = 0; index < mesh.count; index++) {
      const matrix = new Matrix4();
      mesh.getMatrixAt(index, matrix);
      color.setRGB(1, 1, 1);
      if (mesh.instanceColor !== null) mesh.getColorAt(index, color);
      if (mesh.morphTexture !== null) {
        morph.morphTargetInfluences = Array.from(
          { length: base.morphTargets?.length ?? 0 },
          () => 0,
        );
        mesh.getMorphAt(index, morph as never);
      }
      entries.push({
        matrix,
        color: color.toArray(),
        ...(mesh.morphTexture === null ? {} : { weights: [...morph.morphTargetInfluences] }),
      });
    }
  } else {
    const source = mesh as unknown as BatchSource;
    for (let index = 0; index < source._multiDrawCount; index++) {
      const instance = source._indirectTexture.image.data[index] ?? 0;
      const matrix = new Matrix4();
      mesh.getMatrixAt(instance, matrix);
      mesh.getColorAt(instance, color);
      const bytes = mesh.geometry.index?.array.BYTES_PER_ELEMENT ?? 1;
      entries.push({
        matrix,
        color: color.toArray(),
        start: (source._multiDrawStarts[index] ?? 0) / bytes,
        count: source._multiDrawCounts[index] ?? 0,
      });
    }
  }
  if (entries.length === 0) return undefined;
  const arrays: Record<string, number[]> = Object.fromEntries(
    Object.keys(base.attributes).map((name) => [name, []]),
  );
  arrays.color ??= [];
  const indices: number[] = [];
  const submeshes: MeshAsset['submeshes'][number][] = [];
  const positionCount = (base.attributes.position as Float32Array).length / 3;
  const vector = new Vector3();
  // Three's instance normal contract uses column lengths, including its shear approximation.
  for (const submesh of base.submeshes) {
    const offset = indices.length;
    for (const entry of entries) {
      if (
        !entry.matrix.elements.every(Number.isFinite) ||
        entry.matrix.determinant() === 0 ||
        !entry.color.every(Number.isFinite)
      )
        return invalid('Instance matrix/color', mesh.uuid).unwrap();
      const linear = new Matrix3().setFromMatrix4(entry.matrix),
        m = entry.matrix.elements;
      const normalScale = [0, 4, 8].map(
        (i) => (m[i] ?? 0) ** 2 + (m[i + 1] ?? 0) ** 2 + (m[i + 2] ?? 0) ** 2,
      );
      const remap = new Map<number, number>();
      const first = Math.max(submesh.indexOffset, entry.start ?? 0);
      const last = Math.min(
        submesh.indexOffset + submesh.indexCount,
        (entry.start ?? 0) + (entry.count ?? Infinity),
      );
      for (let cursor = first; cursor < last; cursor++) {
        const sourceIndex = (base.indices as Uint16Array | Uint32Array)[cursor] ?? 0;
        let target = remap.get(sourceIndex);
        if (target === undefined) {
          target = (arrays.position?.length ?? 0) / 3;
          remap.set(sourceIndex, target);
          for (const [name, output] of Object.entries(arrays)) {
            const source = base.attributes[name as keyof VertexAttributeMap] as
              | Float32Array
              | undefined;
            const width = name === 'color' ? 4 : (source?.length ?? 0) / positionCount;
            const values = Array.from(
              { length: width },
              (_, lane) => source?.[sourceIndex * width + lane] ?? 1,
            );
            if (name === 'position' || name === 'normal') {
              for (let i = 0; i < (entry.weights?.length ?? 0); i++) {
                const delta = base.morphTargets?.[i]?.[name];
                const weight = entry.weights?.[i] ?? 0;
                if (!Number.isFinite(weight))
                  return invalid('Instance morph weights', mesh.uuid).unwrap();
                for (let lane = 0; lane < 3; lane++)
                  values[lane] =
                    (values[lane] ?? 0) + (delta?.[sourceIndex * 3 + lane] ?? 0) * weight;
              }
              vector.fromArray(values);
              if (name === 'position') vector.applyMatrix4(entry.matrix);
              else vector.divide(new Vector3().fromArray(normalScale)).applyMatrix3(linear);
              vector.toArray(values);
            } else if (name === 'tangent')
              vector.fromArray(values).applyMatrix3(linear).toArray(values);
            else if (name === 'color') {
              for (let lane = 0; lane < 3; lane++)
                values[lane] = (values[lane] ?? 1) * (entry.color[lane] ?? 1);
            }
            output.push(...values);
          }
        }
        indices.push(target);
      }
    }
    if (indices.length > offset)
      submeshes.push({ ...submesh, indexOffset: offset, indexCount: indices.length - offset });
  }
  if (indices.length === 0) return undefined;
  const attributes = Object.fromEntries(
    Object.entries(arrays).map(([name, values]) => [name, new Float32Array(values)]),
  ) as VertexAttributeMap;
  const count = (arrays.position?.length ?? 0) / 3;
  const packed = packInterleavedVertexAttributes(attributes, count).unwrap();
  const { morphTargets: _morph, ...rest } = base;
  return {
    ...rest,
    attributes,
    vertices: packed.vertices,
    indices: count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    submeshes: submeshes.map((submesh) => ({ ...submesh, vertexCount: count })),
    aabb: box3.fromPositions(box3.create(), attributes.position as Float32Array),
  };
}
