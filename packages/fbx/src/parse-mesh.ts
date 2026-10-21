// parse-mesh.ts — FBX JSON POD to MeshPod bridge (t28).

import type { MeshPod, MorphTarget } from '@forgeax/engine-types';

const MORPH_MAX_TARGETS = 8;
const MORPH_MAX_ATTRIBUTES = 8;
const MORPH_COMPONENTS = [
  ['position', 3],
  ['normal', 3],
  ['tangent', 4],
] as const;

export interface FbxRawMesh {
  readonly name?: string;
  readonly vertices: number[];
  readonly indices?: number[];
  readonly attributes: Record<string, number[]>;
  readonly polygonCount: number;
  readonly sourceIndex: number;
  readonly materialIndex: number;
  readonly morphTargets?: readonly {
    readonly position?: number[];
    readonly normal?: number[];
    readonly tangent?: number[];
  }[];
  readonly morphWeights?: number[];
}

export interface FbxRawDocument {
  readonly meshes?: readonly FbxRawMesh[];
}

// feat-20260629-multi-uv-set-support m1-w6: TEXCOORD key prefix for attribute
// naming. Used by both parse-mesh (de-index path) and to-asset-pack (consumer).
const TEXCOORD_PREFIX = 'TEXCOORD_';

// FBX maps positions per control-point but normals / UVs per polygon-vertex
// (per index corner). When an attribute's element count equals the index count
// (and not the position count), it is corner-mapped and must be de-indexed:
// expand to one vertex per corner so positions / normals / uvs stay parallel
// (the layout buildMeshAsset and the engine vertex buffer assume). A glTF-style
// mesh (attributes already per-vertex) skips this path untouched.
function isCornerMapped(
  attrLen: number,
  components: number,
  posCount: number,
  idxCount: number,
): boolean {
  const elems = attrLen / components;
  return idxCount > 0 && elems === idxCount && elems !== posCount;
}

/** Gather a control-point or corner attribute into the expanded vertex domain. */
function expandAttribute(
  values: ArrayLike<number>,
  indices: readonly number[],
  components: number,
  cornerMapped = false,
): Float32Array {
  const output = new Float32Array(indices.length * components);
  for (let corner = 0; corner < indices.length; corner++) {
    const source = cornerMapped ? corner : (indices[corner] ?? 0);
    for (let component = 0; component < components; component++) {
      output[corner * components + component] = values[source * components + component] ?? 0;
    }
  }
  return output;
}

export function parseMesh(raw: FbxRawMesh, sourceIndex: number): MeshPod {
  const rawIndices = raw.indices && raw.indices.length > 0 ? raw.indices : undefined;
  const posCount = raw.vertices.length / 3;
  const idxCount = rawIndices?.length ?? 0;
  const normal = raw.attributes.NORMAL;
  const rawMorphTargets = raw.morphTargets ?? [];
  const morphAttributeCount = rawMorphTargets.reduce(
    (count, target) =>
      count + (target.position ? 1 : 0) + (target.normal ? 1 : 0) + (target.tangent ? 1 : 0),
    0,
  );
  if (rawMorphTargets.length > MORPH_MAX_TARGETS || morphAttributeCount > MORPH_MAX_ATTRIBUTES) {
    throw new Error('fbx-morph-invalid: morph target or attribute limit exceeded');
  }
  if (
    rawMorphTargets.some(
      (target) =>
        target.position === undefined &&
        target.normal === undefined &&
        target.tangent === undefined,
    )
  ) {
    throw new Error('fbx-morph-invalid: every target must contain POSITION, NORMAL, or TANGENT');
  }
  let morphTargets = rawMorphTargets.map((target): MorphTarget => {
    const out: {
      position?: Float32Array;
      normal?: Float32Array;
      tangent?: Float32Array;
    } = {};
    for (const [key, components] of MORPH_COMPONENTS) {
      const values = target[key];
      if (values === undefined) continue;
      if (values.length !== posCount * components) {
        throw new Error(`fbx-morph-invalid: ${key} length does not match vertex count`);
      }
      out[key] = new Float32Array(values);
    }
    return out;
  });
  if (raw.morphWeights !== undefined && raw.morphWeights.length !== morphTargets.length) {
    throw new Error('fbx-morph-invalid: default weight count does not match target count');
  }

  // Determine if any attribute is corner-mapped (NORMAL or any TEXCOORD_n).
  const normalCorner = normal !== undefined && isCornerMapped(normal.length, 3, posCount, idxCount);
  const uvCornerMap = new Map<string, boolean>();
  for (const key of Object.keys(raw.attributes)) {
    if (key.startsWith(TEXCOORD_PREFIX)) {
      const arr = raw.attributes[key];
      if (arr !== undefined && isCornerMapped(arr.length, 2, posCount, idxCount)) {
        uvCornerMap.set(key, true);
      }
    }
  }
  const hasAnyCorner = normalCorner || uvCornerMap.size > 0;

  let vertices: Float32Array;
  let indices: Uint16Array | Uint32Array | undefined;
  const attributes: Record<string, Float32Array> = {};
  if (rawIndices !== undefined && hasAnyCorner) {
    // Expand all channels into one corner domain; only NORMAL/TEXCOORD are
    // admitted from corner-mapped source attributes on this path.
    vertices = expandAttribute(raw.vertices, rawIndices, 3);
    if (normal !== undefined) {
      attributes.NORMAL = expandAttribute(normal, rawIndices, 3, normalCorner);
    }
    for (const key of Object.keys(raw.attributes)) {
      if (!key.startsWith(TEXCOORD_PREFIX)) continue;
      attributes[key] = expandAttribute(
        raw.attributes[key] ?? [],
        rawIndices,
        2,
        uvCornerMap.has(key),
      );
    }
    morphTargets = morphTargets.map((target): MorphTarget => {
      const expanded: { position?: Float32Array; normal?: Float32Array; tangent?: Float32Array } =
        {};
      for (const [key, components] of MORPH_COMPONENTS) {
        const values = target[key];
        if (values !== undefined) expanded[key] = expandAttribute(values, rawIndices, components);
      }
      return expanded;
    });
    indices = new Uint32Array(idxCount);
    for (let index = 0; index < idxCount; index++) indices[index] = index;
  } else {
    vertices = new Float32Array(raw.vertices);
    indices = rawIndices ? new Uint16Array(rawIndices) : undefined;
    for (const [key, values] of Object.entries(raw.attributes)) {
      attributes[key] = new Float32Array(values);
    }
  }

  const indexCount = indices?.length ?? 0;

  const submeshes = [
    {
      topology: 'triangle-list' as const,
      indexOffset: 0,
      indexCount,
      vertexCount: vertices.length / 3,
      materialIndex: raw.materialIndex >= 0 ? raw.materialIndex : null,
    },
  ];

  return {
    ...(raw.name !== undefined ? { name: raw.name } : {}),
    vertices,
    ...(indices ? { indices } : {}),
    attributes,
    submeshes,
    sourceIndex,
    ...(morphTargets.length === 0 ? {} : { morphTargets }),
    ...(raw.morphWeights === undefined ? {} : { morphWeights: new Float32Array(raw.morphWeights) }),
  };
}
