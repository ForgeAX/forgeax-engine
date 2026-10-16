// transform.ts - decomposeNodeTransform (w11).
//
// glTF 2.0 spec section 3.7 (node):
//   - node.matrix     : 16 floats column-major (mutually exclusive with TRS,
//                       per spec, but real-world DCC tools occasionally
//                       export both - forgeax tolerates this with stderr
//                       warn + diagnostics record per requirements section
//                       boundary cases)
//   - node.translation: VEC3 (default identity translation)
//   - node.rotation   : VEC4 quaternion (default identity rotation)
//   - node.scale      : VEC3 (default identity scale)
//
// This wrapper hides the math package's in-place 3-arg `mat4.decompose`
// signature behind a POD readonly tuple return so the importer surface
// stays Vec3/Quat brand-free at the API boundary (charter proposition 5
// consistent abstraction; plan-strategy decision section 2.7 / OQ-2).

import { mat4, quat, vec3 } from '@forgeax/engine-math';

/** glTF VEC3 literal accepted by node.translation / node.scale. */
export type Vec3Tuple = readonly [number, number, number];
/** glTF VEC4 quaternion literal accepted by node.rotation. */
export type Vec4Tuple = readonly [number, number, number, number];

/** Minimal node JSON shape touched by the decomposer. */
export interface NodeTransformJson {
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
}

/** Mutable diagnostics accumulator (writes to .matrixTrsCoexistNodes only). */
export interface TransformDiagnostics {
  matrixTrsCoexistNodes: number[];
}

export interface DecomposedTransform {
  readonly translation: Vec3Tuple;
  readonly rotation: Vec4Tuple;
  readonly scale: Vec3Tuple;
}

const IDENTITY: DecomposedTransform = {
  translation: [0, 0, 0] as const,
  rotation: [0, 0, 0, 1] as const,
  scale: [1, 1, 1] as const,
};

function tuple3(arr: readonly number[] | undefined, fallback: Vec3Tuple): Vec3Tuple {
  if (arr === undefined || arr.length < 3) return fallback;
  return [arr[0] ?? fallback[0], arr[1] ?? fallback[1], arr[2] ?? fallback[2]];
}

function tuple4(arr: readonly number[] | undefined, fallback: Vec4Tuple): Vec4Tuple {
  if (arr === undefined || arr.length < 4) return fallback;
  return [
    arr[0] ?? fallback[0],
    arr[1] ?? fallback[1],
    arr[2] ?? fallback[2],
    arr[3] ?? fallback[3],
  ];
}

/**
 * Decompose a glTF node's transform into a POD readonly TRS triple.
 *
 * Decision tree:
 *   1. matrix present                -> mat4.decompose 3-arg in-place; if
 *                                       any TRS field is also present,
 *                                       stderr warn + push nodeIndex into
 *                                       diagnostics.matrixTrsCoexistNodes.
 *   2. only TRS fields present       -> use them verbatim (defaults filled).
 *   3. nothing present               -> identity (0/0/0, 0/0/0/1, 1/1/1).
 *
 * Return type is `readonly` POD tuple, deliberately not Vec3/Quat from
 * @forgeax/engine-math, so the importer's IR stays brand-free
 * (plan-strategy decision section 2.7 / OQ-2).
 */
export function decomposeNodeTransform(
  node: NodeTransformJson,
  nodeIndex: number,
  diagnostics: TransformDiagnostics,
): DecomposedTransform {
  const hasMatrix = node.matrix !== undefined && node.matrix.length === 16;
  const hasTrs =
    node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined;

  if (hasMatrix) {
    if (hasTrs) {
      console.error(`[warn] node[${nodeIndex}] has both matrix and TRS, matrix takes precedence`);
      diagnostics.matrixTrsCoexistNodes.push(nodeIndex);
    }
    const out_t = vec3.create();
    const out_r = quat.create();
    const out_s = vec3.create(1, 1, 1);
    // node.matrix is glTF column-major float[16]; mat4.decompose accepts
    // Mat4Like (any indexable [0..15] number container).
    const m = node.matrix as readonly number[];
    mat4.decompose(out_t, out_r, out_s, m as unknown as Parameters<typeof mat4.decompose>[3]);
    return {
      translation: [out_t[0] ?? 0, out_t[1] ?? 0, out_t[2] ?? 0] as const,
      rotation: [out_r[0] ?? 0, out_r[1] ?? 0, out_r[2] ?? 0, out_r[3] ?? 1] as const,
      scale: [out_s[0] ?? 1, out_s[1] ?? 1, out_s[2] ?? 1] as const,
    };
  }

  if (!hasTrs) {
    return IDENTITY;
  }

  return {
    translation: tuple3(node.translation, IDENTITY.translation),
    rotation: tuple4(node.rotation, IDENTITY.rotation),
    scale: tuple3(node.scale, IDENTITY.scale),
  };
}
