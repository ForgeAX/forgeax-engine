import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import {
  type BatchedMesh,
  type BufferGeometry,
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

/** r187 source layout. Only source data is read; native Mesh owns GPU storage/draws. */
interface BatchSource {
  /** @internal Pinned upstream CPU visibility/sort roster, without GPU dispatch. */
  _updateDrawParameters(camera: Camera, geometry: BufferGeometry, material: Material): void;
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

/** A Three pool slot can collapse every vertex to one finite point. */
export function isCollapsedInstance(matrix: ArrayLike<number>, offset: number): boolean {
  return (
    matrix[offset] === 0 &&
    matrix[offset + 1] === 0 &&
    matrix[offset + 2] === 0 &&
    matrix[offset + 3] === 0 &&
    matrix[offset + 4] === 0 &&
    matrix[offset + 5] === 0 &&
    matrix[offset + 6] === 0 &&
    matrix[offset + 7] === 0 &&
    matrix[offset + 8] === 0 &&
    matrix[offset + 9] === 0 &&
    matrix[offset + 10] === 0 &&
    matrix[offset + 11] === 0 &&
    Number.isFinite(matrix[offset + 12]) &&
    Number.isFinite(matrix[offset + 13]) &&
    Number.isFinite(matrix[offset + 14]) &&
    matrix[offset + 15] === 1
  );
}

export function instanceGeometryValues(
  mesh: InstancedMesh | BatchedMesh,
  camera: Camera,
  material: Material,
  rosters: WeakMap<BatchedMesh, Uint32Array>,
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
  // r187 defers its WebGPU roster to the drawing pipeline. Native expansion
  // consumes the upstream CPU roster directly, including holes, sorting and culling.
  const source = mesh as unknown as BatchSource;
  source._updateDrawParameters(camera, mesh.geometry, material);
  const count = source._multiDrawCount;
  const ids = source._indirectTexture.image.data;
  let roster = rosters.get(mesh);
  let equal = roster?.length === count * 3;
  for (let i = 0; equal && i < count; i++) {
    equal =
      roster?.[3 * i] === source._multiDrawStarts[i] &&
      roster?.[3 * i + 1] === source._multiDrawCounts[i] &&
      roster?.[3 * i + 2] === ids[i];
  }
  if (!roster || !equal) {
    roster = new Uint32Array(count * 3);
    for (let i = 0; i < count; i++) {
      roster[i * 3] = source._multiDrawStarts[i] as number;
      roster[i * 3 + 1] = source._multiDrawCounts[i] as number;
      roster[i * 3 + 2] = ids[i] as number;
    }
    rosters.set(mesh, roster);
  }
  return [source._matricesTexture.version, source._colorsTexture?.version, roster];
}

function projectInstanceEntries(mesh: InstancedMesh | BatchedMesh, base: MeshAsset): Instance[] {
  const entries: Instance[] = [];
  const color = new Color();
  if (mesh instanceof InstancedMesh) {
    const morph = { morphTargetInfluences: [] as number[] };
    for (let index = 0; index < mesh.count; index++) {
      if (isCollapsedInstance(mesh.instanceMatrix.array, index * 16)) continue;
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
  return entries;
}

// Three approximates instance normals using the squared column lengths. Native
// inverse-transpose normals agree for ordinary orthogonal TRS instances.
function admitsNativeTintMatrices(mesh: InstancedMesh): boolean {
  const data = mesh.instanceMatrix.array;
  const x = new Vector3(),
    y = new Vector3(),
    z = new Vector3(),
    cross = new Vector3();
  for (let i = 0; i < mesh.count * 16; i += 16) {
    if (isCollapsedInstance(data, i)) continue;
    if (data[i + 3] !== 0 || data[i + 7] !== 0 || data[i + 11] !== 0 || data[i + 15] !== 1)
      return false;
    x.fromArray(data, i).normalize();
    y.fromArray(data, i + 4).normalize();
    z.fromArray(data, i + 8).normalize();
    if (
      !(
        Math.abs(x.dot(y)) <= 1e-6 &&
        Math.abs(y.dot(z)) <= 1e-6 &&
        Math.abs(z.dot(x)) <= 1e-6 &&
        cross.crossVectors(x, y).dot(z) > 0
      )
    )
      return false;
  }
  return true;
}

/** A uniform instance tint can use one colored source mesh and native instance matrices. */
export class InstanceTints {
  private readonly entries = new WeakMap<
    InstancedMesh,
    {
      matrices: InstancedMesh['instanceMatrix']['array'];
      matrixVersion: number;
      attribute: InstancedMesh['instanceColor'];
      array: Float32Array;
      version: number;
      count: number;
      tint: readonly number[] | undefined;
    }
  >();

  common(mesh: InstancedMesh): readonly number[] | undefined {
    const attribute = mesh.instanceColor;
    if (
      attribute === null ||
      mesh.getColorAt !== InstancedMesh.prototype.getColorAt ||
      mesh.getMatrixAt !== InstancedMesh.prototype.getMatrixAt ||
      !(attribute.array instanceof Float32Array) ||
      attribute.itemSize !== 3 ||
      attribute.normalized ||
      mesh.count < 1 ||
      mesh.count > attribute.count
    )
      return undefined;
    const { array, version } = attribute;
    const cached = this.entries.get(mesh);
    if (
      cached?.attribute === attribute &&
      cached.array === array &&
      cached.matrices === mesh.instanceMatrix.array &&
      cached.matrixVersion === mesh.instanceMatrix.version &&
      cached.version === version &&
      cached.count === mesh.count
    )
      return cached.tint;
    const [r, g, b] = array;
    let tint: readonly number[] | undefined;
    if (r !== undefined && g !== undefined && b !== undefined && [r, g, b].every(Number.isFinite)) {
      let end = 3;
      while (
        end < mesh.count * 3 &&
        array[end] === r &&
        array[end + 1] === g &&
        array[end + 2] === b
      )
        end += 3;
      if (end === mesh.count * 3 && admitsNativeTintMatrices(mesh)) tint = [r, g, b];
    }
    this.entries.set(mesh, {
      attribute,
      array,
      version,
      count: mesh.count,
      tint,
      matrices: mesh.instanceMatrix.array,
      matrixVersion: mesh.instanceMatrix.version,
    });
    return tint;
  }
}

export function tintInstanceGeometry(base: MeshAsset, tint: readonly number[]): MeshAsset {
  const count = (base.attributes.position as Float32Array).length / 3;
  const source = base.attributes.color as Float32Array | undefined;
  const color = new Float32Array(count * 4);
  for (let i = 0; i < color.length; i += 4) {
    for (let lane = 0; lane < 3; lane++)
      color[i + lane] = (source?.[i + lane] ?? 1) * (tint[lane] as number);
    color[i + 3] = source?.[i + 3] ?? 1;
  }
  const attributes = { ...base.attributes, color };
  return {
    ...base,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
  };
}

/** Per-instance attributes have no native stream yet. Expand ordinary Mesh source
 * data once per source revision, keeping the same material and one native draw.
 * This intentionally trades CPU/upload memory for compatibility, not a second renderer.
 */
export function projectInstanceGeometry(
  mesh: InstancedMesh | BatchedMesh,
  base: MeshAsset,
): MeshAsset | undefined {
  const entries = projectInstanceEntries(mesh, base);
  if (entries.length === 0) return undefined;
  const arrays: Record<string, number[]> = Object.fromEntries(
    Object.keys(base.attributes).map((name) => [name, []]),
  );
  arrays.color ??= [];
  const indices: number[] = [];
  const submeshes: MeshAsset['submeshes'][number][] = [];
  const positionCount = (base.attributes.position as Float32Array).length / 3;
  const vector = new Vector3();
  const streams = Object.entries(arrays).map(([name, output]) => {
    const source = base.attributes[name as keyof VertexAttributeMap] as Float32Array | undefined;
    const width = name === 'color' ? 4 : (source?.length ?? 0) / positionCount;
    return { name, output, source, width, values: new Array<number>(width) };
  });
  const prepared = entries.map((entry) => {
    const m = entry.matrix.elements;
    if (
      !m.every(Number.isFinite) ||
      entry.matrix.determinant() === 0 ||
      !entry.color.every(Number.isFinite)
    )
      return invalid('Instance matrix/color', mesh.uuid).unwrap();
    if (entry.weights !== undefined && !entry.weights.every(Number.isFinite))
      return invalid('Instance morph weights', mesh.uuid).unwrap();
    // Three's instance normal contract uses column lengths, including its shear approximation.
    const square = (i: number) =>
      (m[i] as number) ** 2 + (m[i + 1] as number) ** 2 + (m[i + 2] as number) ** 2;
    return {
      entry,
      linear: new Matrix3().setFromMatrix4(entry.matrix),
      normalScale: new Vector3(square(0), square(4), square(8)),
    };
  });
  for (const submesh of base.submeshes) {
    const offset = indices.length;
    for (const { entry, linear, normalScale } of prepared) {
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
          for (const { name, output, source, width, values } of streams) {
            for (let lane = 0; lane < width; lane++)
              values[lane] = source?.[sourceIndex * width + lane] ?? 1;
            if (name === 'position' || name === 'normal') {
              for (let i = 0; i < (entry.weights?.length ?? 0); i++) {
                const delta = base.morphTargets?.[i]?.[name];
                const weight = entry.weights?.[i] ?? 0;
                for (let lane = 0; lane < 3; lane++)
                  values[lane] =
                    (values[lane] ?? 0) + (delta?.[sourceIndex * 3 + lane] ?? 0) * weight;
              }
              vector.fromArray(values);
              if (name === 'position') vector.applyMatrix4(entry.matrix);
              else vector.divide(normalScale).applyMatrix3(linear);
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
