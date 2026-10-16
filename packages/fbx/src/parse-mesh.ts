// parse-mesh.ts — FBX JSON POD to MeshPod bridge (t28).

import type { MeshPod, MorphTarget } from '@forgeax/engine-types';

const MORPH_MAX_TARGETS = 8;
const MORPH_MAX_ATTRIBUTES = 8;

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
  const morphTargets = rawMorphTargets.map((target): MorphTarget => {
    const out: {
      position?: Float32Array;
      normal?: Float32Array;
      tangent?: Float32Array;
    } = {};
    for (const [key, values, components] of [
      ['position', target.position, 3],
      ['normal', target.normal, 3],
      ['tangent', target.tangent, 4],
    ] as const) {
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

  if (rawIndices !== undefined && hasAnyCorner) {
    // De-index: one expanded vertex per corner. Position pulled through the
    // index; corner-mapped attributes copied straight; per-vertex attributes
    // gathered through the index. New index buffer is the identity sequence.
    const expandedPos = new Float32Array(idxCount * 3);
    const expandedNormal = normal !== undefined ? new Float32Array(idxCount * 3) : undefined;
    // feat-20260629-multi-uv-set-support m1-w6: expand all TEXCOORD_n sets.
    const expandedUvs = new Map<string, Float32Array>();
    for (const key of Object.keys(raw.attributes)) {
      if (key.startsWith(TEXCOORD_PREFIX)) {
        expandedUvs.set(key, new Float32Array(idxCount * 2));
      }
    }
    const expandedMorphTargets = morphTargets.map((target) => {
      const expanded: {
        position?: Float32Array;
        normal?: Float32Array;
        tangent?: Float32Array;
      } = {};
      for (const [key, values, components] of [
        ['position', target.position, 3],
        ['normal', target.normal, 3],
        ['tangent', target.tangent, 4],
      ] as const) {
        if (values === undefined) continue;
        const output = new Float32Array(idxCount * components);
        for (let corner = 0; corner < idxCount; corner++) {
          const vi = rawIndices[corner] ?? 0;
          for (let component = 0; component < components; component++) {
            output[corner * components + component] = values[vi * components + component] ?? 0;
          }
        }
        expanded[key] = output;
      }
      return expanded;
    });
    for (let corner = 0; corner < idxCount; corner++) {
      const vi = rawIndices[corner] ?? 0;
      expandedPos[corner * 3 + 0] = raw.vertices[vi * 3 + 0] ?? 0;
      expandedPos[corner * 3 + 1] = raw.vertices[vi * 3 + 1] ?? 0;
      expandedPos[corner * 3 + 2] = raw.vertices[vi * 3 + 2] ?? 0;
      if (normal !== undefined && expandedNormal !== undefined) {
        const src = normalCorner ? corner : vi;
        expandedNormal[corner * 3 + 0] = normal[src * 3 + 0] ?? 0;
        expandedNormal[corner * 3 + 1] = normal[src * 3 + 1] ?? 0;
        expandedNormal[corner * 3 + 2] = normal[src * 3 + 2] ?? 0;
      }
      for (const [key, expanded] of expandedUvs) {
        const srcArr = raw.attributes[key];
        if (srcArr !== undefined) {
          const src = uvCornerMap.get(key) ? corner : vi;
          expanded[corner * 2 + 0] = srcArr[src * 2 + 0] ?? 0;
          expanded[corner * 2 + 1] = srcArr[src * 2 + 1] ?? 0;
        }
      }
    }
    const identity = new Uint32Array(idxCount);
    for (let i = 0; i < idxCount; i++) identity[i] = i;
    const expandedAttrs: Record<string, Float32Array> = {};
    if (expandedNormal !== undefined) expandedAttrs.NORMAL = expandedNormal;
    for (const [key, val] of expandedUvs) {
      expandedAttrs[key] = val;
    }
    return {
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      vertices: expandedPos,
      indices: identity,
      attributes: expandedAttrs,
      submeshes: [
        {
          topology: 'triangle-list' as const,
          indexOffset: 0,
          indexCount: idxCount,
          vertexCount: idxCount,
          materialIndex: raw.materialIndex >= 0 ? raw.materialIndex : null,
        },
      ],
      sourceIndex,
      ...(expandedMorphTargets.length === 0 ? {} : { morphTargets: expandedMorphTargets }),
      ...(raw.morphWeights === undefined
        ? {}
        : { morphWeights: new Float32Array(raw.morphWeights) }),
    };
  }

  const vertices = new Float32Array(raw.vertices);
  const indices = rawIndices ? new Uint16Array(rawIndices) : undefined;

  const attributes: Record<string, Float32Array | Uint16Array | Uint32Array> = {};
  for (const [key, arr] of Object.entries(raw.attributes)) {
    attributes[key] = new Float32Array(arr);
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
