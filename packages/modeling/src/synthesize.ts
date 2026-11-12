import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  cross,
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  normalize,
  type SignedAxis,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { EDGE_SHARP, type EditMesh, FACE_MIRRORED, NONE } from './mesh';
import { type FaceSelector, sel } from './selectors';

/** A world-space ray; the first face it hits is picked. */
export interface PickRay {
  readonly origin: Tuple3;
  readonly direction: Tuple3;
}

/**
 * A box select in a view: the rectangle `center +- right * halfWidth +- up * halfHeight`
 * swept along the view `direction`. A face is picked when every vertex projects inside
 * the rectangle; with `visible` (default) it must also face the viewer and be the
 * first face hit at its centroid.
 */
export interface PickBox {
  readonly center: Tuple3;
  readonly right: Tuple3;
  readonly up: Tuple3;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly direction: Tuple3;
  readonly visible?: boolean;
}

/** Element picks of a human: face ids, rays (clicks) and box selects; the result is their union. */
export interface FacePick {
  readonly faces?: readonly number[];
  readonly rays?: readonly PickRay[];
  readonly boxes?: readonly PickBox[];
}

/** Stability class of an atom, cheapest first: the rank decides between equal results. */
export type SynthesisAtomKind = 'tag' | 'role' | 'material' | 'mirrored' | 'region' | 'direction';

export interface SynthesisAtom {
  readonly kind: SynthesisAtomKind;
  /** `sel.*` source the atom contributes, as authors write it. */
  readonly expression: string;
}

export interface SelectorSynthesis {
  /** `sel.*` expression: paste it into a Pack or pass it to `model.select`. */
  readonly expression: string;
  /** Jaccard index |S n S'| / |S u S'| between the picked faces S and the result S'. */
  readonly jaccard: number;
  readonly picked: number;
  readonly matched: number;
  /** Faces in both. */
  readonly common: number;
  readonly atoms: readonly SynthesisAtom[];
  /**
   * True when no combination of at most `maxAtoms` atoms reached J = 1 and the result
   * names positions with `near(p, k)`: it holds for this build only (unstable).
   */
  readonly fallback: boolean;
  /** Next-best combinations, for the human to choose from (bounded). */
  readonly alternatives: readonly { readonly expression: string; readonly jaccard: number }[];
}

export interface SynthesisOptions {
  /** Most atoms combined with and/or/minus (1..4, default 4). */
  readonly maxAtoms?: number;
  /** Combinations kept per depth (default 8). */
  readonly beam?: number;
}

const RANK: Readonly<Record<SynthesisAtomKind, number>> = {
  tag: 0,
  role: 1,
  material: 2,
  mirrored: 2,
  region: 3,
  direction: 4,
};
const AXES: readonly SignedAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const FACING_DEGREES = 5;
const REGION_LIMIT = 32;
const NEAR_LIMIT = 64;

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function round(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

function point(p: Tuple3): string {
  return `[${p.map(round).join(', ')}]`;
}

/** Jaccard index of two id sets; two empty sets are equal (1). */
export function jaccard(a: Iterable<number>, b: Iterable<number>): number {
  const left = new Set(a);
  const right = new Set(b);
  let common = 0;
  for (const id of left) if (right.has(id)) common++;
  const union = left.size + right.size - common;
  return union === 0 ? 1 : common / union;
}

function triangles(mesh: EditMesh, f: number): Tuple3[][] {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  const local = triangulateLoop(points);
  if (local === undefined) return [];
  const out: Tuple3[][] = [];
  for (let i = 0; i < local.length; i += 3) {
    out.push([0, 1, 2].map((k) => points[local[i + k] as number] as Tuple3));
  }
  return out;
}

/** Moller-Trumbore distance along the ray, or undefined. */
function hitTriangle(origin: Tuple3, direction: Tuple3, [a, b, c]: Tuple3[]): number | undefined {
  const e1 = sub(b as Tuple3, a as Tuple3);
  const e2 = sub(c as Tuple3, a as Tuple3);
  const p = cross(direction, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-18) return undefined;
  const s = sub(origin, a as Tuple3);
  const u = dot(s, p) / det;
  if (u < -1e-9 || u > 1 + 1e-9) return undefined;
  const q = cross(s, e1);
  const v = dot(direction, q) / det;
  if (v < -1e-9 || u + v > 1 + 1e-9) return undefined;
  const t = dot(e2, q) / det;
  return t >= 0 ? t : undefined;
}

class RayCaster {
  private readonly tris: { face: number; tri: Tuple3[] }[] = [];
  constructor(mesh: EditMesh) {
    for (const f of mesh.faces())
      for (const tri of triangles(mesh, f)) this.tris.push({ face: f, tri });
  }
  /** First face along the ray and its distance. */
  first(origin: Tuple3, direction: Tuple3): { face: number; t: number } | undefined {
    let best: { face: number; t: number } | undefined;
    for (const { face, tri } of this.tris) {
      const t = hitTriangle(origin, direction, tri);
      if (t !== undefined && (best === undefined || t < best.t)) best = { face, t };
    }
    return best;
  }
}

function finite(values: readonly unknown[]): boolean {
  return values.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Resolve human picks to face ids of `mesh` (ascending): listed ids, the first face
 * each ray hits, and the faces inside each box select.
 */
export function pickFaces(mesh: EditMesh, pick: FacePick): Result<number[], ModelingError> {
  const out = new Set<number>();
  for (const f of pick.faces ?? []) {
    if (!Number.isInteger(f) || f < 0 || f >= mesh.faceHighWater || !mesh.isFaceAlive(f)) {
      return err(
        modelingError('model-invalid-argument', 'picked faces are live face ids', { face: f }),
      );
    }
    out.add(f);
  }
  let caster: RayCaster | undefined;
  const cast = () => {
    caster ??= new RayCaster(mesh);
    return caster;
  };
  for (const ray of pick.rays ?? []) {
    if (!finite([...ray.origin, ...ray.direction]) || dot(ray.direction, ray.direction) === 0) {
      return err(
        modelingError('model-invalid-argument', 'a pick ray has a finite origin and direction', {
          ray,
        }),
      );
    }
    const hit = cast().first(ray.origin, normalize(ray.direction));
    if (hit !== undefined) out.add(hit.face);
  }
  for (const box of pick.boxes ?? []) {
    const values = [...box.center, ...box.right, ...box.up, ...box.direction];
    if (
      !finite([...values, box.halfWidth, box.halfHeight]) ||
      box.halfWidth <= 0 ||
      box.halfHeight <= 0
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a pick box has a finite frame and positive half extents',
          { box },
        ),
      );
    }
    const right = normalize(box.right);
    const up = normalize(box.up);
    const toward = normalize(box.direction);
    const inside = (p: Tuple3) => {
      const d = sub(p, box.center);
      return (
        Math.abs(dot(d, right)) <= box.halfWidth + 1e-9 &&
        Math.abs(dot(d, up)) <= box.halfHeight + 1e-9
      );
    };
    let reach = 0;
    for (const v of mesh.vertices()) {
      const d = sub(mesh.position(v), box.center);
      reach = Math.max(reach, hypot3(d[0], d[1], d[2]));
    }
    for (const f of mesh.faces()) {
      if (!mesh.faceVertices(f).every((v) => inside(mesh.position(v)))) continue;
      if (box.visible !== false) {
        if (dot(faceNormal(mesh, f), toward) >= 0) continue;
        const c = faceCentroid(mesh, f);
        const back = reach * 2 + 1;
        const origin: Tuple3 = [
          c[0] - toward[0] * back,
          c[1] - toward[1] * back,
          c[2] - toward[2] * back,
        ];
        if (cast().first(origin, toward)?.face !== f) continue;
      }
      out.add(f);
    }
  }
  if (out.size === 0) {
    return err(
      modelingError(
        'model-selection-empty',
        'the picks hit at least one face',
        {
          faces: pick.faces?.length ?? 0,
          rays: pick.rays?.length ?? 0,
          boxes: pick.boxes?.length ?? 0,
        },
        'aim the rays at the subject or widen the box; model.render reports each view camera and pixel mapping',
      ),
    );
  }
  return ok([...out].sort((a, b) => a - b));
}

interface Candidate {
  readonly kind: SynthesisAtomKind;
  readonly expression: string;
  readonly selector: FaceSelector;
  readonly bits: Uint8Array;
  readonly count: number;
  readonly cost: number;
}

function bitsOf(mesh: EditMesh, ids: readonly number[]): Uint8Array {
  const bits = new Uint8Array(mesh.faceHighWater);
  for (const id of ids) bits[id] = 1;
  return bits;
}

/** Sharp-bounded smooth regions: connected faces across edges without the sharp flag. */
function smoothRegions(mesh: EditMesh): Int32Array {
  const region = new Int32Array(mesh.faceHighWater).fill(-1);
  let next = 0;
  for (const seed of mesh.faces()) {
    if ((region[seed] as number) >= 0) continue;
    const stack = [seed];
    region[seed] = next;
    while (stack.length > 0) {
      const f = stack.pop() as number;
      for (const h of mesh.faceHalves(f)) {
        if (((mesh.eFlags[h >> 1] as number) & EDGE_SHARP) !== 0) continue;
        const g = mesh.hFace[h ^ 1] as number;
        if (g !== NONE && (region[g] as number) < 0) {
          region[g] = next;
          stack.push(g);
        }
      }
    }
    next++;
  }
  return region;
}

function atoms(mesh: EditMesh, target: readonly number[]): Candidate[] {
  const out: Candidate[] = [];
  const add = (kind: SynthesisAtomKind, expression: string, selector: FaceSelector) => {
    const ids = selector.evaluate(mesh);
    if (ids.length === 0) return;
    out.push({
      kind,
      expression,
      selector,
      bits: bitsOf(mesh, ids),
      count: ids.length,
      cost: RANK[kind] + expression.length / 1000,
    });
  };
  const tags = new Set<number>();
  const roles = new Map<number, Set<number>>();
  const materials = new Set<number>();
  let mirrored = false;
  for (const f of target) {
    for (let t = 0; t < mesh.tagNames.length; t++) if (mesh.hasTag(f, t)) tags.add(t);
    const l = mesh.fLabel[f] as number;
    if (l > 0) {
      const set = roles.get(l) ?? new Set<number>();
      set.add(mesh.fRole[f] as number);
      roles.set(l, set);
    }
    materials.add(mesh.fMaterial[f] as number);
    if (((mesh.fFlags[f] as number) & FACE_MIRRORED) !== 0) mirrored = true;
  }
  for (const t of [...tags].sort((a, b) => a - b)) {
    const name = mesh.tagNames[t] as string;
    add('tag', `sel.tag(${quote(name)})`, sel.tag(name));
  }
  for (const [l, set] of [...roles].sort((a, b) => a[0] - b[0])) {
    const label = mesh.labelNames[l] as string;
    add('role', `sel.createdBy(${quote(label)})`, sel.createdBy(label));
    for (const r of [...set].sort((a, b) => a - b)) {
      const role = mesh.roleNames[r] as string;
      if (role === '') continue;
      add('role', `sel.createdBy(${quote(label)}, ${quote(role)})`, sel.createdBy(label, role));
    }
  }
  for (const m of [...materials].sort((a, b) => a - b)) {
    const slot = mesh.materialNames[m] as string;
    add('material', `sel.material(${quote(slot)})`, sel.material(slot));
  }
  if (mirrored) add('mirrored', 'sel.mirrored()', sel.mirrored());
  for (const axis of AXES) {
    add('direction', `sel.extreme('${axis}')`, sel.extreme(axis));
    add('direction', `sel.facing('${axis}', ${FACING_DEGREES})`, sel.facing(axis, FACING_DEGREES));
  }
  // Smooth regions the picks touch, each seeded by the cheapest atom inside it.
  const region = smoothRegions(mesh);
  const touched = [...new Set(target.map((f) => region[f] as number))].slice(0, REGION_LIMIT);
  const seeds = out.slice();
  for (const r of touched) {
    const members = mesh.faces().filter((f) => region[f] === r);
    const inRegion = (ids: readonly number[]) => ids.every((f) => region[f] === r);
    let seeded = false;
    for (const seed of [...seeds].sort((a, b) => a.cost - b.cost)) {
      const ids = seed.selector.evaluate(mesh);
      if (inRegion(ids)) {
        add('region', `${seed.expression}.connected('smooth')`, seed.selector.connected('smooth'));
        seeded = true;
        break;
      }
      const largest = seed.selector.largest();
      if (inRegion(largest.evaluate(mesh))) {
        add(
          'region',
          `${seed.expression}.largest().connected('smooth')`,
          largest.connected('smooth'),
        );
        seeded = true;
        break;
      }
    }
    if (!seeded) {
      // No semantic seed: the region around its largest face, named by position.
      let best = members[0] as number;
      for (const f of members) if (faceArea(mesh, f) > faceArea(mesh, best)) best = f;
      const c = faceCentroid(mesh, best).map(round) as Tuple3;
      const near = sel.near(c, 1);
      if (inRegion(near.evaluate(mesh))) {
        out.push({
          kind: 'region',
          expression: `sel.near(${point(c)}, 1).connected('smooth')`,
          selector: near.connected('smooth'),
          bits: bitsOf(mesh, members),
          count: members.length,
          // Position-named seeds rank after every semantic and direction atom.
          cost: RANK.direction + 2,
        });
      }
    }
  }
  // Equal sets keep the cheapest expression.
  const unique = new Map<string, Candidate>();
  for (const c of out.sort((a, b) => a.cost - b.cost)) {
    const key = c.bits.join('');
    if (!unique.has(key)) unique.set(key, c);
  }
  return [...unique.values()];
}

interface State {
  readonly expression: string;
  readonly selector: FaceSelector;
  readonly bits: Uint8Array;
  readonly used: readonly Candidate[];
  readonly common: number;
  readonly count: number;
  readonly jaccard: number;
  readonly cost: number;
}

function better(a: State, b: State): number {
  return b.jaccard - a.jaccard || a.used.length - b.used.length || a.cost - b.cost;
}

/**
 * Synthesize the shortest `sel.*` expression whose result equals the picked faces
 * (design 12): atoms are the picks' tags, createdBy roles, materials, mirroring,
 * direction extremes and facings, and sharp-bounded smooth regions; a beam search
 * combines at most `maxAtoms` with and/or/minus toward Jaccard J = 1. Without an
 * exact combination the result names positions (`near(p, k)`) and is flagged
 * `fallback`: it is not expected to survive a rebuild.
 */
export function synthesizeSelector(
  mesh: EditMesh,
  faces: readonly number[],
  options: SynthesisOptions = {},
): Result<SelectorSynthesis, ModelingError> {
  const maxAtoms = options.maxAtoms ?? 4;
  const beam = options.beam ?? 8;
  if (!Number.isInteger(maxAtoms) || maxAtoms < 1 || maxAtoms > 4) {
    return err(
      modelingError('model-invalid-argument', 'maxAtoms is an integer in 1..4', { maxAtoms }),
    );
  }
  if (!Number.isInteger(beam) || beam < 1) {
    return err(modelingError('model-invalid-argument', 'beam is an integer >= 1', { beam }));
  }
  const target = [...new Set(faces)].sort((a, b) => a - b);
  for (const f of target) {
    if (!Number.isInteger(f) || f < 0 || f >= mesh.faceHighWater || !mesh.isFaceAlive(f)) {
      return err(
        modelingError('model-invalid-argument', 'picked faces are live face ids', { face: f }),
      );
    }
  }
  if (target.length === 0) {
    return err(modelingError('model-selection-empty', 'at least one picked face', {}));
  }
  const goal = bitsOf(mesh, target);
  const size = target.length;
  const state = (
    expression: string,
    selector: FaceSelector,
    bits: Uint8Array,
    used: readonly Candidate[],
  ): State => {
    let common = 0;
    let count = 0;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] === 1) {
        count++;
        if (goal[i] === 1) common++;
      }
    }
    return {
      expression,
      selector,
      bits,
      used,
      common,
      count,
      jaccard: common / (size + count - common),
      cost: used.reduce((sum, c) => sum + c.cost, 0),
    };
  };
  const pool = atoms(mesh, target);
  let frontier = pool
    .filter((c) => c.bits.some((b, i) => b === 1 && goal[i] === 1))
    .map((c) => state(c.expression, c.selector, c.bits, [c]))
    .sort(better);
  const seen = new Map<string, State>();
  const remember = (s: State) => {
    const key = s.bits.join('');
    const old = seen.get(key);
    if (old === undefined || better(s, old) < 0) seen.set(key, s);
  };
  for (const s of frontier) remember(s);
  frontier = frontier.slice(0, beam);
  for (let depth = 2; depth <= maxAtoms; depth++) {
    if (frontier.some((s) => s.jaccard === 1)) break;
    const next: State[] = [];
    for (const s of frontier) {
      for (const atom of pool) {
        if (s.used.includes(atom)) continue;
        const ops: ['and' | 'or' | 'minus', (x: number, y: number) => number][] = [
          ['and', (x, y) => x & y],
          ['or', (x, y) => x | y],
          ['minus', (x, y) => x & (1 - y)],
        ];
        for (const [word, op] of ops) {
          const bits = new Uint8Array(s.bits.length);
          for (let i = 0; i < bits.length; i++)
            bits[i] = op(s.bits[i] as number, atom.bits[i] as number);
          const candidate = state(
            `${s.expression}.${word}(${atom.expression})`,
            s.selector[word](atom.selector),
            bits,
            [...s.used, atom],
          );
          if (candidate.jaccard <= s.jaccard) continue;
          next.push(candidate);
        }
      }
    }
    if (next.length === 0) break;
    for (const s of next) remember(s);
    frontier = next.sort(better).slice(0, beam);
  }
  const ranked = [...seen.values()].sort(better);
  let best = ranked[0];
  let fallback = false;
  if (best === undefined || best.jaccard < 1) {
    // Positional fallback (design 12 step 3): near(p, k) alone, else the closest
    // combination corrected face by face with near(centroid, 1).
    const centroids = new Map(target.map((f) => [f, faceCentroid(mesh, f)]));
    const mean = [0, 1, 2].map(
      (k) => [...centroids.values()].reduce((sum, c) => sum + (c[k] as number), 0) / size,
    ) as Tuple3;
    const near = (c: Tuple3, k: number) => ({
      expression: `sel.near(${point(c)}, ${k})`,
      selector: sel.near(c.map(round) as Tuple3, k),
    });
    const tries: { expression: string; selector: FaceSelector; used: readonly Candidate[] }[] = [
      { ...near(mean, size), used: [] },
    ];
    let corrected: { base?: State; missing: number[]; extra: number[] } | undefined;
    for (const base of [undefined, ...ranked.slice(0, 20)]) {
      const missing = target.filter((f) => base?.bits[f] !== 1);
      const extra =
        base === undefined ? [] : mesh.faces().filter((f) => base.bits[f] === 1 && goal[f] !== 1);
      if (
        corrected === undefined ||
        missing.length + extra.length < corrected.missing.length + corrected.extra.length
      ) {
        corrected = { ...(base === undefined ? {} : { base }), missing, extra };
      }
    }
    if (
      corrected !== undefined &&
      corrected.missing.length + corrected.extra.length <= NEAR_LIMIT
    ) {
      let acc: { expression: string; selector: FaceSelector } | undefined = corrected.base;
      for (const f of corrected.missing) {
        const part = near(centroids.get(f) as Tuple3, 1);
        acc =
          acc === undefined
            ? part
            : {
                expression: `${acc.expression}.or(${part.expression})`,
                selector: acc.selector.or(part.selector),
              };
      }
      for (const f of corrected.extra) {
        const part = near(faceCentroid(mesh, f), 1);
        const base = acc as { expression: string; selector: FaceSelector };
        acc = {
          expression: `${base.expression}.minus(${part.expression})`,
          selector: base.selector.minus(part.selector),
        };
      }
      if (acc !== undefined) tries.push({ ...acc, used: corrected.base?.used ?? [] });
    }
    for (const t of tries) {
      const s = state(t.expression, t.selector, bitsOf(mesh, t.selector.evaluate(mesh)), t.used);
      if (best === undefined || s.jaccard > best.jaccard) {
        best = s;
        fallback = true;
      }
      if (s.jaccard === 1) break;
    }
  }
  const chosen = best as State;
  // The returned expression is re-evaluated from its selector, never trusted from the bit sets.
  const evaluated = chosen.selector.evaluate(mesh);
  const common = evaluated.filter((f) => goal[f] === 1).length;
  return ok({
    expression: chosen.expression,
    jaccard: common / (size + evaluated.length - common),
    picked: size,
    matched: evaluated.length,
    common,
    atoms: chosen.used.map((c) => ({ kind: c.kind, expression: c.expression })),
    fallback,
    alternatives: ranked
      .filter((s) => s !== chosen)
      .slice(0, 5)
      .map((s) => ({ expression: s.expression, jaccard: Math.round(s.jaccard * 1e4) / 1e4 })),
  });
}

interface FaceFacts {
  readonly face: number;
  readonly normal: Tuple3;
  readonly area: number;
  readonly centroid: Tuple3;
}

/** Faces by provenance as `model.diff` groups them: label and role, or tags when unlabeled; plus material. */
function provenanceGroups(mesh: EditMesh): Map<string, FaceFacts[]> {
  const map = new Map<string, FaceFacts[]>();
  for (const f of mesh.faces()) {
    const label = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
    const identity =
      label === ''
        ? ['', '', mesh.tagNames.filter((_, t) => mesh.hasTag(f, t))]
        : [label, mesh.roleNames[mesh.fRole[f] as number] ?? '', []];
    const key = JSON.stringify([
      ...identity,
      mesh.materialNames[mesh.fMaterial[f] as number] ?? '',
    ]);
    const facts = {
      face: f,
      normal: faceNormal(mesh, f),
      area: faceArea(mesh, f),
      centroid: faceCentroid(mesh, f),
    };
    const list = map.get(key);
    if (list === undefined) map.set(key, [facts]);
    else list.push(facts);
  }
  return map;
}

/** Congruence classes of a group: equal normal (within 0.01) and area (within 1 %), such as rotated copies. */
function congruenceClasses(members: readonly FaceFacts[]): FaceFacts[][] {
  const classes: FaceFacts[][] = [];
  for (const m of members) {
    const found = classes.find((c) => {
      const first = c[0] as FaceFacts;
      return (
        dot(first.normal, m.normal) > 1 - 5e-5 &&
        Math.abs(first.area - m.area) <= 0.01 * Math.max(first.area, m.area)
      );
    });
    if (found === undefined) classes.push([m]);
    else found.push(m);
  }
  return classes;
}

function normalizedCentroids(members: readonly FaceFacts[]): Tuple3[] {
  const lo = [0, 1, 2].map((k) => minOf(members.map((m) => m.centroid[k] as number)));
  const hi = [0, 1, 2].map((k) => maxOf(members.map((m) => m.centroid[k] as number)));
  return members.map(
    (m) =>
      [0, 1, 2].map((k) => {
        const span = (hi[k] as number) - (lo[k] as number);
        return span > 1e-12 ? ((m.centroid[k] as number) - (lo[k] as number)) / span : 0.5;
      }) as Tuple3,
  );
}

/** Mismatch of two faces' shape: normal deviation and log area ratio. */
function shapeCost(a: FaceFacts, b: FaceFacts): number {
  const areaRatio = (Math.max(a.area, b.area) + 1e-30) / (Math.min(a.area, b.area) + 1e-30);
  return (1 - dot(a.normal, b.normal)) * 10 + (areaRatio - 1);
}

/**
 * Carry picked faces of a reference state to another build of the same Pack (other
 * parameter values) for the stability check. Faces are grouped by provenance as
 * `model.diff` groups them (label and role, or tags when unlabeled; plus material).
 * A group picked entirely maps to the whole counterpart group; a picked congruence
 * class (two or more faces with equal normal and area, such as rotated copies) maps
 * to the counterpart class of the closest shape; remaining picks pair one to one with
 * the nearest unused face of their group (group-normalized centroid plus shape).
 * Returns the expected faces of `target` and the number of picks without a counterpart.
 */
export function transferSelection(
  reference: EditMesh,
  faces: readonly number[],
  target: EditMesh,
): { readonly faces: number[]; readonly lost: number } {
  const picked = new Set(faces);
  const to = provenanceGroups(target);
  const out = new Set<number>();
  let lost = 0;
  for (const [key, members] of provenanceGroups(reference)) {
    const chosen = members.filter((m) => picked.has(m.face));
    if (chosen.length === 0) continue;
    const counterpart = to.get(key) ?? [];
    if (counterpart.length === 0) {
      lost += chosen.length;
      continue;
    }
    if (chosen.length === members.length) {
      for (const m of counterpart) out.add(m.face);
      continue;
    }
    const single: FaceFacts[] = [];
    const targetClasses = congruenceClasses(counterpart);
    for (const c of congruenceClasses(members)) {
      const inside = c.filter((m) => picked.has(m.face));
      if (inside.length === 0) continue;
      if (c.length < 2 || inside.length < c.length) {
        pushAll(single, inside);
        continue;
      }
      let best: FaceFacts[] | undefined;
      let bestCost = Infinity;
      for (const t of targetClasses) {
        const cost = shapeCost(c[0] as FaceFacts, t[0] as FaceFacts);
        if (cost < bestCost) {
          best = t;
          bestCost = cost;
        }
      }
      for (const m of best ?? []) out.add(m.face);
    }
    if (single.length === 0) continue;
    const a = normalizedCentroids(members);
    const b = normalizedCentroids(counterpart);
    const index = new Map(members.map((m, i) => [m.face, i]));
    const pairs: { i: number; j: number; d: number }[] = [];
    for (const m of single) {
      const i = index.get(m.face) as number;
      const p = a[i] as Tuple3;
      for (const [j, q] of b.entries()) {
        const d = hypot3(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        pairs.push({ i, j, d: d + shapeCost(m, counterpart[j] as FaceFacts) });
      }
    }
    pairs.sort((x, y) => x.d - y.d || x.i - y.i || x.j - y.j);
    const takenA = new Set<number>();
    const takenB = new Set<number>();
    for (const { i, j } of pairs) {
      if (takenA.has(i) || takenB.has(j)) continue;
      takenA.add(i);
      takenB.add(j);
      out.add((counterpart[j] as FaceFacts).face);
    }
    lost += single.length - takenA.size;
  }
  return { faces: [...out].sort((x, y) => x - y), lost };
}

/**
 * Triangle-list positions of the faces, lifted `lift` meters along each face normal so
 * an overlay drawn over the mesh wins the depth test (selection highlights).
 */
export function liftedFaceTriangles(
  mesh: EditMesh,
  faces: readonly number[],
  lift: number,
): number[] {
  const out: number[] = [];
  for (const f of faces) {
    const n = faceNormal(mesh, f);
    for (const tri of triangles(mesh, f)) {
      for (const p of tri) out.push(p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift);
    }
  }
  return out;
}
