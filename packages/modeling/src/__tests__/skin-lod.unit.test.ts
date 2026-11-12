import { PackageId } from '@forgeax/engine-pack/guid';
import type { MeshAsset, SkeletonAsset, SkinAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toColumnMajor } from '../affine';
import { model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';
import {
  jointTreeOfPaths,
  reduceSkinForLod,
  type SkinLodInput,
  type SkinLodOptions,
  type SkinLodResult,
} from '../skin-lod';

type Slot = readonly [joint: number, weight: number];

const NAMES = [
  'root',
  'spine',
  'armL',
  'handL',
  'fingerL',
  'armR',
  'handR',
  'fingerR',
  'head',
] as const;
const PARENTS = [-1, 0, 1, 2, 3, 1, 5, 6, 1];
const REST: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0, 1, 0],
  [0.5, 1.5, 0],
  [1, 1.5, 0],
  [1.5, 1.5, 0],
  [-0.5, 1.5, 0],
  [-1, 1.5, 0],
  [-1.5, 1.5, 0],
  [0, 2, 0],
];
const RIGID_COUNT = [10, 10, 8, 6, 1, 8, 6, 2, 5];

/** Column-major translation. */
function translate(t: readonly number[]): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0] as number, t[1] as number, t[2] as number, 1];
}

/** Column-major rotation about z by `degrees` (multiples of 30 only, so the table is exact enough). */
function rotateZ(degrees: number): number[] {
  const c = Math.cos((degrees * Math.PI) / 180);
  const s = Math.sin((degrees * Math.PI) / 180);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++)
        out[c * 4 + r] =
          (out[c * 4 + r] as number) + (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
  return out;
}

function inverseBindOf(rest: readonly (readonly number[])[]): Float32Array {
  const out = new Float32Array(rest.length * 16);
  for (const [i, p] of rest.entries()) out.set(translate(p.map((c) => -c)), i * 16);
  return out;
}

/** World matrices of every joint when each rotates about z by `angles[joint]` degrees locally. */
function poseWorlds(
  parents: readonly number[],
  rest: readonly (readonly number[])[],
  angles: Readonly<Record<number, number>>,
): Float32Array {
  const world: number[][] = [];
  for (const [i, parent] of parents.entries()) {
    const p = rest[i] as readonly number[];
    const offset = parent < 0 ? p : p.map((c, k) => c - ((rest[parent] as number[])[k] as number));
    const local = mul(translate(offset), rotateZ(angles[i] ?? 0));
    world.push(parent < 0 ? local : mul(world[parent] as number[], local));
  }
  const out = new Float32Array(parents.length * 16);
  for (const [i, w] of world.entries()) out.set(w, i * 16);
  return out;
}

function pack(vertices: readonly (readonly Slot[])[]): {
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
} {
  const skinIndex = new Uint16Array(vertices.length * 4);
  const skinWeight = new Float32Array(vertices.length * 4);
  for (const [v, slots] of vertices.entries()) {
    for (const [k, [joint, weight]] of slots.entries()) {
      skinIndex[v * 4 + k] = joint;
      skinWeight[v * 4 + k] = weight;
    }
  }
  return { skinIndex, skinWeight };
}

interface Fixture {
  readonly input: SkinLodInput;
  readonly positions: Float32Array;
  readonly vertexCount: number;
  /** First vertex of each kind: rigid joint j starts at rigidStart[j]; blends follow. */
  readonly rigidStart: readonly number[];
  readonly blend: {
    readonly handFinger: number;
    readonly fingerHand: number;
    readonly raw: number;
    readonly head: number;
  };
}

function figure(): Fixture {
  const slots: Slot[][] = [];
  const positions: number[] = [];
  const rigidStart: number[] = [];
  for (const [j, count] of RIGID_COUNT.entries()) {
    rigidStart.push(slots.length);
    for (let k = 0; k < count; k++) {
      slots.push([[j, 1]]);
      const p = REST[j] as readonly number[];
      positions.push((p[0] as number) + 0.1, (p[1] as number) + 0.0625 * k, p[2] as number);
    }
  }
  const handFinger = slots.length;
  slots.push([
    [3, 0.5],
    [4, 0.25],
    [2, 0.25],
  ]);
  positions.push(1.25, 1.5, 0);
  const fingerHand = slots.length;
  slots.push([
    [4, 0.625],
    [3, 0.375],
  ]);
  positions.push(1.5 - 0.0625, 1.5, 0);
  const raw = slots.length;
  slots.push([
    [7, 0.45],
    [6, 0.27],
    [5, 0.18],
  ]);
  positions.push(-1.25, 1.5, 0);
  const head = slots.length;
  slots.push([
    [8, 0.5],
    [1, 0.5],
  ]);
  positions.push(0, 1.5, 0);
  const { skinIndex, skinWeight } = pack(slots);
  return {
    input: {
      names: NAMES,
      parents: PARENTS,
      inverseBind: inverseBindOf(REST),
      skinIndex,
      skinWeight,
    },
    positions: new Float32Array(positions),
    vertexCount: slots.length,
    rigidStart,
    blend: { handFinger, fingerHand, raw, head },
  };
}

function reduce(input: SkinLodInput, options: SkinLodOptions): SkinLodResult {
  const result = reduceSkinForLod(input, options);
  if (!result.ok) throw result.error;
  return result.value;
}

function influences(r: { skinIndex: Uint16Array; skinWeight: Float32Array }, v: number): Slot[] {
  const out: Slot[] = [];
  for (let k = 0; k < 4; k++) {
    const w = r.skinWeight[v * 4 + k] as number;
    if (w > 0) out.push([r.skinIndex[v * 4 + k] as number, w]);
  }
  return out;
}

function weightSum(r: { skinWeight: Float32Array }, v: number): number {
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += r.skinWeight[v * 4 + k] as number;
  return sum;
}

describe('reduceSkinForLod', () => {
  it('merges the lowest-mass leaves first and reports each merge', () => {
    const f = figure();
    const r = reduce(f.input, { budget: 6 });
    expect(r.report.before).toBe(9);
    expect(r.report.after).toBe(6);
    expect(r.report.merged).toEqual([
      { joint: 'fingerL', into: 'handL' },
      { joint: 'fingerR', into: 'handR' },
      { joint: 'head', into: 'spine' },
    ]);
    expect(r.joints).toEqual([0, 1, 2, 3, 5, 6]);
    expect(r.names).toEqual(['root', 'spine', 'armL', 'handL', 'armR', 'handR']);
    expect(Array.from(r.parents)).toEqual([-1, 0, 1, 2, 1, 4]);
  });

  it('moves vertices of a merged joint to the nearest surviving ancestor, through several merges', () => {
    const f = figure();
    const r = reduce(f.input, { budget: 4 });
    expect(r.report.merged.map((m) => m.joint)).toEqual([
      'fingerL',
      'fingerR',
      'head',
      'handR',
      'handL',
    ]);
    expect(r.report.merged.map((m) => m.into)).toEqual(['handL', 'handR', 'spine', 'armR', 'armL']);
    expect(r.names).toEqual(['root', 'spine', 'armL', 'armR']);
    expect(Array.from(r.parents)).toEqual([-1, 0, 1, 1]);
    expect(Array.from(r.remap)).toEqual([0, 1, 2, 2, 2, 3, 3, 3, 1]);
    expect(influences(r, f.rigidStart[4] as number)).toEqual([[2, 1]]);
    expect(influences(r, f.rigidStart[7] as number)).toEqual([[3, 1]]);
    expect(influences(r, f.rigidStart[8] as number)).toEqual([[1, 1]]);
    const [first, second] = [influences(r, f.blend.handFinger), influences(r, f.blend.fingerHand)];
    expect(first).toEqual([[2, 1]]);
    expect(second).toEqual([[2, 1]]);
  });

  it('sums merged weights into the survivor and renormalises', () => {
    const f = figure();
    const r = reduce(f.input, { budget: 6 });
    const [a, b] = influences(r, f.blend.handFinger) as [Slot, Slot];
    expect(a[0]).toBe(3);
    expect(a[1]).toBeCloseTo(0.75, 6);
    expect(b[0]).toBe(2);
    expect(b[1]).toBeCloseTo(0.25, 6);
    const [c, d] = influences(r, f.blend.raw) as [Slot, Slot];
    expect([c[0], d[0]]).toEqual([5, 4]);
    expect(c[1]).toBeCloseTo(0.8, 6);
    expect(d[1]).toBeCloseTo(0.2, 6);
    for (let v = 0; v < f.vertexCount; v++)
      expect(Math.abs(weightSum(r, v) - 1)).toBeLessThan(1e-6);
  });

  it('keeps rigid vertices single-influence at exactly 1 and untouched vertices bit for bit', () => {
    const f = figure();
    for (const budget of [8, 6, 4, 1]) {
      const r = reduce(f.input, { budget });
      for (let j = 0; j < 9; j++) {
        for (let k = 0; k < (RIGID_COUNT[j] as number); k++) {
          const v = (f.rigidStart[j] as number) + k;
          expect(influences(r, v)).toEqual([[r.remap[j], 1]]);
        }
      }
    }
    const r = reduce(f.input, { budget: 8 });
    expect(r.report.merged).toEqual([{ joint: 'fingerL', into: 'handL' }]);
    const v = f.blend.raw;
    expect(Array.from(r.skinWeight.subarray(v * 4, v * 4 + 4))).toEqual(
      Array.from(f.input.skinWeight.subarray(v * 4, v * 4 + 4)),
    );
    expect(Array.from(r.skinIndex.subarray(v * 4, v * 4 + 4))).toEqual([6, 5, 4, 0]);
  });

  it('keeps the surviving parent chain a tree rooted as before', () => {
    const f = figure();
    for (const budget of [9, 7, 5, 3, 1]) {
      const r = reduce(f.input, { budget });
      expect(r.report.after).toBe(budget);
      expect(r.parents[0]).toBe(-1);
      for (let k = 1; k < r.parents.length; k++) {
        const parent = r.parents[k] as number;
        expect(parent).toBeGreaterThanOrEqual(0);
        expect(parent).toBeLessThan(k);
        let up = PARENTS[r.joints[k] as number] as number;
        while (up >= 0 && !r.joints.includes(up)) up = PARENTS[up] as number;
        expect(r.joints[parent]).toBe(up);
      }
      expect(r.inverseBind.length).toBe(budget * 16);
      for (const [k, joint] of r.joints.entries()) {
        expect(Array.from(r.inverseBind.subarray(k * 16, k * 16 + 16))).toEqual(
          Array.from(f.input.inverseBind.subarray(joint * 16, joint * 16 + 16)),
        );
      }
    }
  });

  it('never merges a kept joint, so it also holds its ancestors', () => {
    const f = figure();
    const r = reduce(f.input, { budget: 6, keep: ['fingerL'] });
    expect(r.names).toContain('fingerL');
    expect(r.report.merged.map((m) => m.joint)).not.toContain('fingerL');
    expect(r.names).toEqual(['root', 'spine', 'armL', 'handL', 'fingerL', 'armR']);
    expect(r.report.merged).toEqual([
      { joint: 'fingerR', into: 'handR' },
      { joint: 'head', into: 'spine' },
      { joint: 'handR', into: 'armR' },
    ]);
    const tight = reduceSkinForLod(f.input, { budget: 4, keep: ['fingerL'] });
    expect(tight.ok).toBe(false);
    if (!tight.ok) {
      expect(tight.error.code).toBe('model-precondition');
      expect(tight.error.detail).toMatchObject({ budget: 4, floor: 5 });
    }
  });

  it('merges every leaf below the minimum mass without a budget', () => {
    const f = figure();
    const r = reduce(f.input, { minMass: 3 });
    expect(r.report.merged.map((m) => m.joint)).toEqual(['fingerL', 'fingerR']);
    expect(r.report.after).toBe(7);
    const both = reduce(f.input, { minMass: 3, budget: 5 });
    expect(both.report.merged.map((m) => m.joint)).toEqual(['fingerL', 'fingerR', 'head', 'handR']);
  });

  it('is deterministic and leaves its input alone', () => {
    const f = figure();
    const before = Array.from(f.input.skinWeight);
    const a = reduce(f.input, {
      budget: 5,
      positions: f.positions,
      poses: [poseWorlds(PARENTS, REST, { 4: 60 })],
    });
    const b = reduce(f.input, {
      budget: 5,
      positions: f.positions,
      poses: [poseWorlds(PARENTS, REST, { 4: 60 })],
    });
    expect(Array.from(a.skinWeight)).toEqual(Array.from(b.skinWeight));
    expect(Array.from(a.skinIndex)).toEqual(Array.from(b.skinIndex));
    expect(a.report).toEqual(b.report);
    expect(Array.from(f.input.skinWeight)).toEqual(before);
  });

  it('reports no displacement at the bind pose and none when only survivors move', () => {
    const f = figure();
    const bind = poseWorlds(PARENTS, REST, {});
    const atBind = reduce(f.input, { budget: 4, positions: f.positions, poses: [bind] });
    expect(atBind.report.maxDisplacement).toBeLessThan(1e-6);
    const armBent = poseWorlds(PARENTS, REST, { 2: 30, 1: -30 });
    const moved = reduce(f.input, { budget: 4, positions: f.positions, poses: [bind, armBent] });
    expect(moved.report.maxDisplacement).toBeLessThan(1e-5);
  });

  it('bounds and reports the error of a merged joint that moves', () => {
    const f = figure();
    const bent = poseWorlds(PARENTS, REST, { 4: 90 });
    const r = reduce(f.input, { budget: 6, positions: f.positions, poses: [bent] });
    expect(r.report.merged[0]).toEqual({ joint: 'fingerL', into: 'handL' });
    expect(r.report.maxDisplacement).toBeCloseTo(0.1 * Math.SQRT2, 5);
    const flat = reduce(f.input, { budget: 6 });
    expect(flat.report.maxDisplacement).toBeUndefined();
  });

  it('rejects unusable input with model-invalid-argument', () => {
    const f = figure();
    const code = (input: SkinLodInput, options: SkinLodOptions): string | undefined => {
      const result = reduceSkinForLod(input, options);
      return result.ok ? undefined : result.error.code;
    };
    expect(code(f.input, {})).toBe('model-invalid-argument');
    expect(code(f.input, { budget: 0 })).toBe('model-invalid-argument');
    expect(code(f.input, { budget: 2.5 })).toBe('model-invalid-argument');
    expect(code(f.input, { budget: 4, keep: ['elbow'] })).toBe('model-invalid-argument');
    expect(
      code(f.input, { budget: 4, positions: f.positions, poses: [new Float32Array(16)] }),
    ).toBe('model-invalid-argument');
    expect(code(f.input, { budget: 4, positions: new Float32Array(3), poses: [] })).toBe(
      'model-invalid-argument',
    );
    expect(code({ ...f.input, parents: [-1, 2, 0, 0, 0, 0, 0, 0, 0] }, { budget: 4 })).toBe(
      'model-invalid-argument',
    );
    expect(code({ ...f.input, names: [...NAMES.slice(0, 8), 'root'] }, { budget: 4 })).toBe(
      'model-invalid-argument',
    );
    expect(code({ ...f.input, inverseBind: new Float32Array(16) }, { budget: 4 })).toBe(
      'model-invalid-argument',
    );
    const bad = f.input.skinIndex.slice();
    bad[0] = 9;
    expect(code({ ...f.input, skinIndex: bad }, { budget: 4 })).toBe('model-invalid-argument');
  });

  it('holds its invariants on a 170-joint tree with mixed rigid and blended vertices', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const count = 170;
    const parents: number[] = [-1];
    for (let i = 1; i < count; i++) parents.push(next() < 0.7 ? i - 1 : Math.floor(next() * i));
    const names = parents.map((_, i) => `j${i}`);
    const rest = parents.map((_, i) => [i * 0.0625, (i % 7) * 0.125, 0]);
    const slots: Slot[][] = [];
    for (let v = 0; v < 900; v++) {
      const n = next() < 0.5 ? 1 : 2 + Math.floor(next() * 3);
      const joints = new Set<number>();
      while (joints.size < n) joints.add(Math.floor(next() * count));
      const raw = [...joints].map((j) => [j, 0.1 + next()] as const).sort((x, y) => y[1] - x[1]);
      const total = raw.reduce((a, [, w]) => a + w, 0);
      slots.push(n === 1 ? [[raw[0]?.[0] as number, 1]] : raw.map(([j, w]) => [j, w / total]));
    }
    const { skinIndex, skinWeight } = pack(slots);
    const input: SkinLodInput = {
      names,
      parents,
      inverseBind: inverseBindOf(rest),
      skinIndex,
      skinWeight,
    };
    const keep = ['j10', 'j33', 'j140'];
    const r = reduce(input, { budget: 100, keep });
    expect(r.report.after).toBe(100);
    expect(r.report.before).toBe(170);
    expect(r.report.merged.length).toBe(70);
    for (const name of keep) expect(r.names).toContain(name);
    const survivors = new Set(r.joints);
    const survivor = (j: number): number => {
      let up = j;
      while (up >= 0 && !survivors.has(up)) up = parents[up] as number;
      return up;
    };
    expect(survivors.has(0)).toBe(true);
    for (const [k, joint] of r.joints.entries()) {
      expect(r.parents[k]).toBe(
        joint === 0 ? -1 : r.joints.indexOf(survivor(parents[joint] as number)),
      );
    }
    for (let j = 0; j < count; j++) expect(r.joints[r.remap[j] as number]).toBe(survivor(j));
    const seen = new Set<string>();
    for (const m of r.report.merged) {
      const j = names.indexOf(m.joint);
      for (let c = 0; c < count; c++) {
        if (parents[c] === j) expect(seen.has(names[c] as string)).toBe(true);
      }
      seen.add(m.joint);
    }
    for (let v = 0; v < slots.length; v++) {
      expect(Math.abs(weightSum(r, v) - 1)).toBeLessThan(1e-6);
      const wanted = new Map<number, number>();
      for (const [j, w] of slots[v] as Slot[]) {
        const k = r.remap[j] as number;
        wanted.set(k, (wanted.get(k) ?? 0) + w);
      }
      const got = influences(r, v);
      expect(got.length).toBe(wanted.size);
      if ((slots[v] as Slot[]).length === 1) expect(got.length).toBe(1);
      for (const [k, w] of got) expect(w).toBeCloseTo(wanted.get(k) as number, 5);
      for (let i = 1; i < got.length; i++) {
        expect((got[i - 1] as Slot)[1]).toBeGreaterThanOrEqual((got[i] as Slot)[1]);
      }
    }
  });
});

describe('jointTreeOfPaths', () => {
  it('reads names and parents from the SkinAsset joint paths', () => {
    const tree = jointTreeOfPaths([
      'body/root',
      'body/root/spine',
      'body/root/spine/arm',
      'body/root/leg',
    ]);
    expect(tree.names).toEqual(['root', 'spine', 'arm', 'leg']);
    expect(Array.from(tree.parents)).toEqual([-1, 0, 1, 0]);
  });
});

describe('reduceSkinForLod on a rig export', () => {
  it('reduces the skeleton, skin and mesh attributes that rig.finish writes', () => {
    const m = model();
    m.revolve({
      points: [
        [0, 0],
        ...Array.from({ length: 21 }, (_, i) => [0.2, i * 0.1] as [number, number]),
        [0, 2],
      ],
      segments: 16,
      label: 'limb',
    });
    m.uv.project({ mode: 'cylinder', scale: 1 });
    const r = rig(m, {
      joints: [
        { name: 'base', parent: null, position: [0, 0, 0] },
        { name: 'bend', parent: 'base', position: [0, 1, 0], kind: 'revolute', axis: 'z' },
        { name: 'tip', parent: 'bend', position: [0, 2, 0] },
      ],
    });
    r.bindAuto(sel.all(), ['base', 'bend', 'tip'], { part: 'skin' });
    const packageId = PackageId.parse('01900000-0000-7000-8000-0000000c0507');
    if (!packageId.ok) throw new Error('package id');
    const out = r.finish({ key: 'limb', packageId: packageId.value, form: 'skinned' });
    if (!out.ok) throw out.error;
    const mesh = out.value['mesh/limb'] as MeshAsset;
    const skeleton = out.value['skeleton/limb'] as SkeletonAsset;
    const skin = out.value['skin/limb'] as SkinAsset;
    const tree = jointTreeOfPaths(skin.jointPaths);
    expect(tree.names).toEqual(['base', 'bend', 'tip']);
    const input: SkinLodInput = {
      ...tree,
      inverseBind: skeleton.inverseBindMatrices,
      skinIndex: mesh.attributes.skinIndex as Uint16Array,
      skinWeight: mesh.attributes.skinWeight as Float32Array,
    };
    const positions = mesh.attributes.position as Float32Array;
    const world = (angle: number): Float32Array => {
      const pose = r.pose({ bend: angle });
      if (!pose.ok) throw pose.error;
      const out = new Float32Array(48);
      for (const [i, j] of pose.value.joints.entries()) out.set(toColumnMajor(j.world), i * 16);
      return out;
    };
    const fixedTip = reduce(input, { budget: 2, positions, poses: [world(0), world(45)] });
    expect(fixedTip.report.merged).toEqual([{ joint: 'tip', into: 'bend' }]);
    expect(fixedTip.report.maxDisplacement).toBeLessThan(1e-5);
    const rootOnly = reduce(input, { budget: 1, positions, poses: [world(45)] });
    expect(rootOnly.report.merged.map((x) => x.joint)).toEqual(['tip', 'bend']);
    expect(rootOnly.report.maxDisplacement).toBeGreaterThan(0.2);
    for (let v = 0; v < input.skinIndex.length / 4; v++) {
      expect(Math.abs(weightSum(rootOnly, v) - 1)).toBeLessThan(1e-6);
      expect(influences(rootOnly, v)).toEqual([[0, 1]]);
    }
  });
});
