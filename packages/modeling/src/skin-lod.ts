import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';

const INFLUENCES = 4;

/** A joint tree: parents precede children, one root (`-1`), unique names. */
export interface SkinLodSkeleton {
  readonly names: readonly string[];
  /** Per joint, the parent joint index; `-1` for the root (joint 0). */
  readonly parents: ArrayLike<number>;
}

/** What `rig.finish({ form: 'skinned' })` writes, with the joint tree of its `SkinAsset`. */
export interface SkinLodInput extends SkinLodSkeleton {
  /** `SkeletonAsset.inverseBindMatrices`: column-major mat4 per joint. */
  readonly inverseBind: Float32Array;
  /** Mesh `skinIndex`: 4 joint indices per vertex. */
  readonly skinIndex: Uint16Array;
  /** Mesh `skinWeight`: 4 weights per vertex (unused slots 0). */
  readonly skinWeight: Float32Array;
}

export interface SkinLodOptions {
  /** Keep at most this many joints (an integer >= 1). */
  readonly budget?: number;
  /** Also merge every leaf whose weight mass is below this (after earlier merges added theirs). */
  readonly minMass?: number;
  /** Joints that are never merged (animation targets, sockets); their ancestors stay too. */
  readonly keep?: readonly string[];
  /** Bind-pose vertex positions (xyz per vertex) for the displacement report. */
  readonly positions?: Float32Array;
  /** Test poses: column-major world matrix per original joint, to measure the displacement. */
  readonly poses?: readonly Float32Array[];
}

export interface SkinLodMerge {
  readonly joint: string;
  /** The joint's parent when it was merged (that parent may itself merge later). */
  readonly into: string;
}

export interface SkinLodReport {
  readonly before: number;
  readonly after: number;
  /** In merge order. */
  readonly merged: readonly SkinLodMerge[];
  /** Largest vertex displacement over the supplied poses; absent without poses. */
  readonly maxDisplacement?: number;
}

export interface SkinLodResult extends SkinLodSkeleton {
  /** Original index of each surviving joint, ascending. */
  readonly joints: readonly number[];
  /** Per original joint, the new index of its nearest surviving ancestor (itself if it survives). */
  readonly remap: Uint16Array;
  /** Column-major inverse bind matrices of the surviving joints, in new order. */
  readonly inverseBind: Float32Array;
  readonly skinIndex: Uint16Array;
  readonly skinWeight: Float32Array;
  readonly report: SkinLodReport;
}

/** Names and parents of a `SkinAsset.jointPaths` list (a path whose parent path is absent is a root). */
export function jointTreeOfPaths(jointPaths: readonly string[]): SkinLodSkeleton {
  const byPath = new Map<string, number>();
  for (const [i, path] of jointPaths.entries()) byPath.set(path, i);
  const parents = new Int32Array(jointPaths.length);
  const names: string[] = [];
  for (const [i, path] of jointPaths.entries()) {
    const cut = path.lastIndexOf('/');
    names.push(path.slice(cut + 1));
    parents[i] = cut < 0 ? -1 : (byPath.get(path.slice(0, cut)) ?? -1);
  }
  return { names, parents };
}

function invalid(
  expected: string,
  detail: Readonly<Record<string, unknown>>,
  hint?: string,
): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail, hint));
}

function validate(input: SkinLodInput, options: SkinLodOptions): Result<null, ModelingError> {
  const count = input.names.length;
  if (count === 0 || input.parents.length !== count) {
    return invalid('names and parents list the same, non-empty joint set', {
      names: count,
      parents: input.parents.length,
    });
  }
  if (new Set(input.names).size !== count) return invalid('unique joint names', {});
  for (let i = 0; i < count; i++) {
    const parent = input.parents[i] as number;
    const fine = i === 0 ? parent === -1 : Number.isInteger(parent) && parent >= 0 && parent < i;
    if (!fine) {
      return invalid(
        'one root at joint 0 and every parent before its children',
        { joint: input.names[i], parent },
        'reorder the joints parents first',
      );
    }
  }
  if (input.inverseBind.length !== count * 16) {
    return invalid('one column-major inverse bind matrix per joint', {
      expected: count * 16,
      got: input.inverseBind.length,
    });
  }
  const slots = input.skinIndex.length;
  if (slots !== input.skinWeight.length || slots % INFLUENCES !== 0) {
    return invalid('skinIndex and skinWeight hold 4 slots per vertex', {
      skinIndex: slots,
      skinWeight: input.skinWeight.length,
    });
  }
  for (let s = 0; s < slots; s++) {
    const w = input.skinWeight[s] as number;
    if ((input.skinIndex[s] as number) >= count || !(w >= 0) || !Number.isFinite(w)) {
      return invalid('joint indices below the joint count and finite non-negative weights', {
        vertex: Math.floor(s / INFLUENCES),
        slot: s % INFLUENCES,
      });
    }
  }
  const { budget, minMass, keep, positions, poses } = options;
  if (budget === undefined && minMass === undefined) {
    return invalid('a budget or a minMass policy', {}, 'pass budget: <joint count> and/or minMass');
  }
  if (budget !== undefined && !(Number.isInteger(budget) && budget >= 1)) {
    return invalid('budget is an integer >= 1', { budget });
  }
  if (minMass !== undefined && !(Number.isFinite(minMass) && minMass >= 0)) {
    return invalid('minMass is a finite number >= 0', { minMass });
  }
  for (const name of keep ?? []) {
    if (!input.names.includes(name)) return invalid('keep names existing joints', { joint: name });
  }
  if (poses !== undefined && poses.length > 0 && positions === undefined) {
    return invalid('poses come with the bind-pose positions', {});
  }
  if (positions !== undefined && positions.length !== (slots / INFLUENCES) * 3) {
    return invalid('one xyz position per skinned vertex', {
      expected: (slots / INFLUENCES) * 3,
      got: positions.length,
    });
  }
  for (const [i, pose] of (poses ?? []).entries()) {
    if (pose.length !== count * 16) {
      return invalid('one world matrix per original joint in every pose', {
        pose: i,
        expected: count * 16,
        got: pose.length,
      });
    }
  }
  return ok(null);
}

/** Per joint, the skin matrix `world * inverseBind` (rows of the affine part, row-major 3x4). */
function skinMatrices(world: Float32Array, inverseBind: Float32Array, count: number): Float64Array {
  const out = new Float64Array(count * 12);
  for (let j = 0; j < count; j++) {
    const w = j * 16;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += (world[w + k * 4 + r] as number) * (inverseBind[w + c * 4 + k] as number);
        }
        out[j * 12 + r * 4 + c] = sum;
      }
    }
  }
  return out;
}

function skinned(
  matrices: Float64Array,
  indices: ArrayLike<number>,
  weights: ArrayLike<number>,
  v: number,
  p: readonly number[],
  mapJoint: (slot: number) => number,
  out: number[],
): void {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  let total = 0;
  for (let k = 0; k < INFLUENCES; k++) total += weights[v * INFLUENCES + k] as number;
  if (!(total > 0)) {
    out[0] = p[0] as number;
    out[1] = p[1] as number;
    out[2] = p[2] as number;
    return;
  }
  for (let k = 0; k < INFLUENCES; k++) {
    const w = (weights[v * INFLUENCES + k] as number) / total;
    if (w === 0) continue;
    const m = mapJoint(indices[v * INFLUENCES + k] as number) * 12;
    for (let r = 0; r < 3; r++) {
      out[r] =
        (out[r] as number) +
        w *
          ((matrices[m + r * 4] as number) * (p[0] as number) +
            (matrices[m + r * 4 + 1] as number) * (p[1] as number) +
            (matrices[m + r * 4 + 2] as number) * (p[2] as number) +
            (matrices[m + r * 4 + 3] as number));
    }
  }
}

function displacement(
  input: SkinLodInput,
  reduced: { skinIndex: Uint16Array; skinWeight: Float32Array },
  joints: readonly number[],
  positions: Float32Array,
  poses: readonly Float32Array[],
): number {
  const count = input.names.length;
  const vertices = input.skinIndex.length / INFLUENCES;
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  let max = 0;
  for (const pose of poses) {
    const matrices = skinMatrices(pose, input.inverseBind, count);
    for (let v = 0; v < vertices; v++) {
      const p = [
        positions[v * 3] as number,
        positions[v * 3 + 1] as number,
        positions[v * 3 + 2] as number,
      ];
      skinned(matrices, input.skinIndex, input.skinWeight, v, p, (j) => j, a);
      skinned(matrices, reduced.skinIndex, reduced.skinWeight, v, p, (k) => joints[k] as number, b);
      const dx = (a[0] as number) - (b[0] as number);
      const dy = (a[1] as number) - (b[1] as number);
      const dz = (a[2] as number) - (b[2] as number);
      max = Math.max(max, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
  }
  return max;
}

/**
 * Reduces a skinned rig for a lower LOD: leaves merge into their parent, lowest weight mass
 * first (a merged leaf adds its mass to the parent), until the budget is met, and a parent
 * only after its children. Vertex weights of a merged joint move to the nearest surviving
 * ancestor and are summed and renormalised, so a single-influence vertex stays at weight 1;
 * vertices touching no merged joint are copied. Pass `positions` and `poses` to measure the
 * largest vertex displacement the merge causes.
 */
export function reduceSkinForLod(
  input: SkinLodInput,
  options: SkinLodOptions,
): Result<SkinLodResult, ModelingError> {
  const valid = validate(input, options);
  if (!valid.ok) return valid;
  const count = input.names.length;
  const parent = (j: number): number => input.parents[j] as number;
  const vertices = input.skinIndex.length / INFLUENCES;

  const mass = new Float64Array(count);
  for (let s = 0; s < input.skinIndex.length; s++) {
    const joint = input.skinIndex[s] as number;
    mass[joint] = (mass[joint] as number) + (input.skinWeight[s] as number);
  }
  const pinned = new Uint8Array(count);
  pinned[0] = 1;
  for (const name of options.keep ?? []) {
    for (let j = input.names.indexOf(name); j >= 0 && pinned[j] === 0; j = parent(j)) pinned[j] = 1;
  }
  const children = new Int32Array(count);
  for (let j = 1; j < count; j++) children[parent(j)] = (children[parent(j)] as number) + 1;
  const alive = new Uint8Array(count).fill(1);
  const { budget, minMass } = options;
  const merged: SkinLodMerge[] = [];
  let left = count;
  for (;;) {
    let pick = -1;
    for (let j = 1; j < count; j++) {
      if (alive[j] === 0 || pinned[j] === 1 || children[j] !== 0) continue;
      if (pick < 0 || (mass[j] as number) <= (mass[pick] as number)) pick = j;
    }
    const over = budget !== undefined && left > budget;
    if (pick < 0) {
      if (over) {
        return err(
          modelingError(
            'model-precondition',
            'a budget no smaller than the joints that cannot merge',
            { budget, floor: left },
            'raise the budget or shorten the keep list',
          ),
        );
      }
      break;
    }
    if (!over && !(minMass !== undefined && (mass[pick] as number) < minMass)) break;
    const into = parent(pick);
    alive[pick] = 0;
    children[into] = (children[into] as number) - 1;
    mass[into] = (mass[into] as number) + (mass[pick] as number);
    merged.push({ joint: input.names[pick] as string, into: input.names[into] as string });
    left -= 1;
  }

  const joints: number[] = [];
  const remap = new Uint16Array(count);
  for (let j = 0; j < count; j++) {
    if (alive[j] === 1) {
      remap[j] = joints.length;
      joints.push(j);
    } else {
      remap[j] = remap[parent(j)] as number;
    }
  }
  const parents = new Int32Array(joints.length);
  const names: string[] = [];
  const inverseBind = new Float32Array(joints.length * 16);
  for (const [k, j] of joints.entries()) {
    parents[k] = j === 0 ? -1 : (remap[parent(j)] as number);
    names.push(input.names[j] as string);
    inverseBind.set(input.inverseBind.subarray(j * 16, j * 16 + 16), k * 16);
  }

  const skinIndex = new Uint16Array(vertices * INFLUENCES);
  const skinWeight = new Float32Array(vertices * INFLUENCES);
  const slotJoint = new Int32Array(INFLUENCES);
  const slotWeight = new Float64Array(INFLUENCES);
  for (let v = 0; v < vertices; v++) {
    const base = v * INFLUENCES;
    let touched = false;
    for (let k = 0; k < INFLUENCES; k++) {
      const joint = input.skinIndex[base + k] as number;
      skinIndex[base + k] = remap[joint] as number;
      skinWeight[base + k] = input.skinWeight[base + k] as number;
      if (alive[joint] === 0 && (input.skinWeight[base + k] as number) > 0) touched = true;
    }
    if (!touched) continue;
    let used = 0;
    let total = 0;
    for (let k = 0; k < INFLUENCES; k++) {
      const w = input.skinWeight[base + k] as number;
      if (w === 0) continue;
      const joint = remap[input.skinIndex[base + k] as number] as number;
      let slot = 0;
      while (slot < used && slotJoint[slot] !== joint) slot++;
      if (slot === used) {
        slotJoint[used] = joint;
        slotWeight[used] = 0;
        used++;
      }
      slotWeight[slot] = (slotWeight[slot] as number) + w;
      total += w;
    }
    for (let a = 1; a < used; a++) {
      const j = slotJoint[a] as number;
      const w = slotWeight[a] as number;
      let b = a - 1;
      while (b >= 0 && (slotWeight[b] as number) < w) {
        slotJoint[b + 1] = slotJoint[b] as number;
        slotWeight[b + 1] = slotWeight[b] as number;
        b--;
      }
      slotJoint[b + 1] = j;
      slotWeight[b + 1] = w;
    }
    for (let k = 0; k < INFLUENCES; k++) {
      skinIndex[base + k] = k < used ? (slotJoint[k] as number) : 0;
      skinWeight[base + k] = k < used ? (used === 1 ? 1 : (slotWeight[k] as number) / total) : 0;
    }
  }

  const poses = options.poses ?? [];
  const report: SkinLodReport = {
    before: count,
    after: joints.length,
    merged,
    ...(options.positions !== undefined && poses.length > 0
      ? {
          maxDisplacement: displacement(
            input,
            { skinIndex, skinWeight },
            joints,
            options.positions,
            poses,
          ),
        }
      : {}),
  };
  return ok({ names, parents, joints, remap, inverseBind, skinIndex, skinWeight, report });
}
