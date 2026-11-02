import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from './arrays';
import { cos, hypot3, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  type Axis,
  axisVector,
  cross,
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  normalize,
  type SignedAxis,
  sub,
  type Tuple3,
} from './geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, FACE_MIRRORED, NONE } from './mesh';
import { faceThickness } from './thickness';
import { edgeLoop, edgeRing } from './walk';

export type Domain = 'face' | 'edge' | 'vert';

/** Face, edge or vertex rule used by inclusion conversions. */
export type Inclusion = 'touching' | 'contained';

/** Which face vertices decide a geometric predicate. */
export type HitRule = 'all' | 'centroid' | 'any';

export type Cardinality =
  | { readonly kind: 'nonEmpty' }
  | { readonly kind: 'exactly'; readonly count: number }
  | { readonly kind: 'atLeast'; readonly count: number };

/** One resolved selector argument of an operation: its text, what it matched and what it asserted. */
export interface SelectorUse {
  readonly text: string;
  readonly domain: Domain;
  readonly matched: number;
  readonly assert: Cardinality;
  /**
   * Matched faces (edges: both sides, vertices: incident faces) per `label/role:count`, sorted;
   * more than 16 keys end in `+N#hash` over the whole key list, so no difference is dropped.
   */
  readonly provenance: readonly string[];
  /**
   * Geometry of the matched elements, comparable across parameter sets: the sign classes of
   * their face normals (a component within 0.4 of zero counts as zero) and the `label/role` of
   * the faces across their edges. Selections of more than 512 elements record `n[*] a[*]`.
   */
  readonly signature: string;
}

/** Selector uses of the operation being recorded; bounded so a looping operation stays small. */
export interface SelectorLog {
  readonly uses: SelectorUse[];
  truncated: boolean;
}

const MAX_SELECTOR_USES = 256;
let activeLog: SelectorLog | undefined;

/** Run `body` with `log` collecting every `Selector.resolve`; nested recordings restore the outer one. */
export function recordSelectors<T>(log: SelectorLog, body: () => T): T {
  const outer = activeLog;
  activeLog = log;
  try {
    return body();
  } finally {
    activeLog = outer;
  }
}

type Evaluate = (mesh: EditMesh) => number[];

/**
 * Selector expression. It is re-evaluated on every operation call, so it never
 * refers to stale element ids; evaluation results only appear in reports.
 */
export class Selector<D extends Domain> {
  readonly domain: D;
  readonly description: string;
  private readonly evaluator: Evaluate;
  readonly cardinality: Cardinality;
  private readonly sources: readonly Selector<Domain>[];
  private readonly argumentError: ModelingError | undefined;

  constructor(
    domain: D,
    description: string,
    evaluator: Evaluate,
    cardinality: Cardinality = { kind: 'nonEmpty' },
    sources: readonly Selector<Domain>[] = [],
    argumentError?: ModelingError,
  ) {
    this.domain = domain;
    this.description = description;
    this.evaluator = evaluator;
    this.cardinality = cardinality;
    this.sources = sources;
    this.argumentError = argumentError;
  }

  /** The first invalid argument anywhere in this expression, if any. */
  invalid(): ModelingError | undefined {
    if (this.argumentError !== undefined) return this.argumentError;
    for (const source of this.sources) {
      const found = source.invalid();
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Raw evaluation in ascending id order; does not check cardinality. Invalid expressions match nothing. */
  evaluate(mesh: EditMesh): number[] {
    if (this.invalid() !== undefined) return [];
    return this.evaluator(mesh);
  }

  and(other: Selector<D>): Selector<D> {
    return this.combine(other, 'and', (a, b) => a.filter((id) => b.has(id)));
  }

  or(other: Selector<D>): Selector<D> {
    return new Selector(
      this.domain,
      `(${this.description} or ${other.description})`,
      (mesh) => sortedUnique([...this.evaluate(mesh), ...other.evaluate(mesh)]),
      undefined,
      [this, other],
    );
  }

  minus(other: Selector<D>): Selector<D> {
    return this.combine(other, 'minus', (a, b) => a.filter((id) => !b.has(id)));
  }

  not(): Selector<D> {
    return new Selector(
      this.domain,
      `not ${this.description}`,
      (mesh) => {
        const excluded = new Set(this.evaluate(mesh));
        return domainIds(mesh, this.domain).filter((id) => !excluded.has(id));
      },
      undefined,
      [this],
    );
  }

  one(): Selector<D> {
    return this.withCardinality({ kind: 'exactly', count: 1 });
  }

  exactly(count: number): Selector<D> {
    return this.withCardinality({ kind: 'exactly', count });
  }

  atLeast(count: number): Selector<D> {
    return this.withCardinality({ kind: 'atLeast', count });
  }

  largest(this: FaceSelector): FaceSelector {
    return faceSel.largest(this);
  }

  smallest(this: FaceSelector): FaceSelector {
    return faceSel.smallest(this);
  }

  grow(this: FaceSelector, steps: number): FaceSelector {
    return faceSel.grow(this, steps);
  }

  /** Drop faces that touch an unselected face across an edge, `steps` times. */
  shrink(this: FaceSelector, steps: number): FaceSelector {
    return faceSel.shrink(this, steps);
  }

  /** Vertices of the selected faces: all of them, or only those whose faces are all selected. */
  toVerts(this: FaceSelector, include: Inclusion): VertSelector {
    return faceSel.toVerts(this, include);
  }

  /** Extend each selected edge along its edge loop (straight through valence-4 vertices). */
  loop(this: EdgeSelector): EdgeSelector {
    return edgeSel.loop(this);
  }

  /** Extend each selected edge along its edge ring (opposite edges of even-sided faces). */
  ring(this: EdgeSelector): EdgeSelector {
    return edgeSel.ring(this);
  }

  /** Flood across neighbors; `'smooth'` stops at sharp edges (a smoothing region). */
  connected(this: FaceSelector, across: 'any' | 'smooth'): FaceSelector {
    return faceSel.connected(this, across);
  }

  toEdges(this: FaceSelector, include: Inclusion): EdgeSelector {
    return faceSel.toEdges(this, include);
  }

  boundary(this: FaceSelector): EdgeSelector {
    return faceSel.boundary(this);
  }

  toFaces(this: EdgeSelector): FaceSelector {
    return edgeSel.toFaces(this);
  }

  /** Check the declared cardinality and return the evaluated ids. */
  resolve(mesh: EditMesh): Result<number[], ModelingError> {
    const invalid = this.invalid();
    if (invalid !== undefined) return err(invalid);
    const ids = this.evaluate(mesh);
    const c = this.cardinality;
    if (activeLog !== undefined) {
      if (activeLog.uses.length < MAX_SELECTOR_USES) {
        activeLog.uses.push({
          text: this.description,
          domain: this.domain,
          matched: ids.length,
          assert: c,
          provenance: provenanceCounts(mesh, this.domain, ids),
          signature: signatureOf(mesh, this.domain, ids),
        });
      } else {
        activeLog.truncated = true;
      }
    }
    if (ids.length === 0 && (c.kind === 'nonEmpty' || c.count > 0)) {
      return err(
        modelingError(
          'model-selection-empty',
          `selector ${this.description} matches at least one ${this.domain}`,
          {
            selector: this.description,
            ...emptySelectionHints(mesh, this.description),
          },
        ),
      );
    }
    if (
      (c.kind === 'exactly' && ids.length !== c.count) ||
      (c.kind === 'atLeast' && ids.length < c.count)
    ) {
      return err(
        modelingError(
          'model-selection-cardinality',
          `selector ${this.description} matches ${c.kind === 'exactly' ? 'exactly' : 'at least'} ${c.count}`,
          { selector: this.description, matched: ids.length },
        ),
      );
    }
    return ok(ids);
  }

  private combine(
    other: Selector<D>,
    word: string,
    op: (a: number[], b: Set<number>) => number[],
  ): Selector<D> {
    return new Selector(
      this.domain,
      `(${this.description} ${word} ${other.description})`,
      (mesh) => op(this.evaluate(mesh), new Set(other.evaluate(mesh))),
      undefined,
      [this, other],
    );
  }

  private withCardinality(cardinality: Cardinality): Selector<D> {
    return new Selector(this.domain, this.description, this.evaluator, cardinality, [this]);
  }
}

export type FaceSelector = Selector<'face'>;
export type EdgeSelector = Selector<'edge'>;
export type VertSelector = Selector<'vert'>;

function sortedUnique(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

const MAX_PROVENANCE_KEYS = 16;
const SIGNATURE_LIMIT = 512;
const NORMAL_ZERO_BAND = 0.4;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The first keys in full, then one `+N#hash` element covering the rest, so equal lists compare equal. */
function boundedList(keys: readonly string[]): string[] {
  if (keys.length <= MAX_PROVENANCE_KEYS) return [...keys];
  const rest = keys.slice(MAX_PROVENANCE_KEYS);
  return [...keys.slice(0, MAX_PROVENANCE_KEYS), `+${rest.length}#${fnv1a(rest.join('|'))}`];
}

function bump(counts: Int32Array, i: number): void {
  counts[i] = (counts[i] as number) + 1;
}

function provenanceCounts(mesh: EditMesh, domain: Domain, ids: readonly number[]): string[] {
  const roles = mesh.roleNames.length;
  const counts = new Int32Array(mesh.labelNames.length * roles);
  const { fLabel, fRole, hFace } = mesh;
  if (domain === 'face') {
    for (let i = 0; i < ids.length; i++) {
      const f = ids[i] as number;
      bump(counts, (fLabel[f] as number) * roles + (fRole[f] as number));
    }
  } else if (domain === 'edge') {
    for (let i = 0; i < ids.length; i++) {
      for (let side = 0; side < 2; side++) {
        const f = hFace[(ids[i] as number) * 2 + side] as number;
        if (f !== NONE) bump(counts, (fLabel[f] as number) * roles + (fRole[f] as number));
      }
    }
  } else {
    for (const f of incidentFaces(mesh, ids)) {
      bump(counts, (fLabel[f] as number) * roles + (fRole[f] as number));
    }
  }
  const keys: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] as number;
    if (n > 0) {
      keys.push(`${mesh.labelNames[Math.floor(i / roles)]}/${mesh.roleNames[i % roles]}:${n}`);
    }
  }
  return boundedList(keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Alive faces that use any of the vertices, in ascending id order. */
function incidentFaces(mesh: EditMesh, verts: readonly number[]): number[] {
  const mark = new Uint8Array(mesh.vertexHighWater);
  for (const v of verts) mark[v] = 1;
  const found = new Set<number>();
  for (let h = 0; h < mesh.halfHighWater; h++) {
    const f = mesh.hFace[h] as number;
    if (f !== NONE && mark[mesh.hVert[h] as number] === 1 && mesh.isEdgeAlive(h >> 1)) found.add(f);
  }
  return [...found].sort((a, b) => a - b);
}

function normalClass(n: Tuple3): string {
  let out = '';
  const names = ['x', 'y', 'z'];
  for (let a = 0; a < 3; a++) {
    const c = n[a] as number;
    if (c >= NORMAL_ZERO_BAND) out += `+${names[a]}`;
    else if (c <= -NORMAL_ZERO_BAND) out += `-${names[a]}`;
  }
  return out === '' ? '0' : out;
}

function signatureOf(mesh: EditMesh, domain: Domain, ids: readonly number[]): string {
  if (ids.length > SIGNATURE_LIMIT) return 'n[*] a[*]';
  let faces: number[];
  if (domain === 'face') faces = [...ids];
  else if (domain === 'edge') {
    faces = [];
    for (const id of ids) {
      for (const h of [id * 2, id * 2 + 1]) {
        const f = mesh.hFace[h] as number;
        if (f !== NONE) faces.push(f);
      }
    }
  } else faces = incidentFaces(mesh, ids);
  const classes = new Set<string>();
  const across = new Set<string>();
  for (const f of new Set(faces)) {
    classes.add(normalClass(faceNormal(mesh, f)));
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g !== NONE) {
        across.add(
          `${mesh.labelNames[mesh.fLabel[g] as number] ?? ''}/${mesh.roleNames[mesh.fRole[g] as number] ?? ''}`,
        );
      }
    }
  }
  const sorted = (set: Set<string>) => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `n[${sorted(classes).join(' ')}] a[${boundedList(sorted(across)).join(' ')}]`;
}

function domainIds(mesh: EditMesh, domain: Domain): number[] {
  return domain === 'face' ? mesh.faces() : domain === 'edge' ? mesh.edges() : mesh.vertices();
}

function emptySelectionHints(mesh: EditMesh, description: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    availableTags: [...mesh.tagNames],
    availableLabels: mesh.labelNames.slice(1),
  };
  const facing =
    /facing\(([+-][xyz])/.exec(description) ?? /extreme\(([+-][xyz])/.exec(description);
  if (facing?.[1]?.endsWith('z')) {
    const sign = facing[1][0] as '+' | '-';
    const up = `${sign}y` as SignedAxis;
    const hits = faceSel.facing(up, 1).evaluate(mesh).length;
    if (hits > 0) {
      out.coordinateHint = `the engine is Y-up; facing('${up}') matches ${hits} faces`;
    }
  }
  return out;
}

function faceFilter(
  description: string,
  keep: (mesh: EditMesh, f: number) => boolean,
): FaceSelector {
  return new Selector('face', description, (mesh) => mesh.faces().filter((f) => keep(mesh, f)));
}

/** A face filter whose name lookups run once per evaluation, not once per face. */
function namedFilter(
  description: string,
  prepare: (mesh: EditMesh) => ((f: number) => boolean) | undefined,
): FaceSelector {
  return new Selector('face', description, (mesh) => {
    const keep = prepare(mesh);
    return keep === undefined ? [] : mesh.faces().filter(keep);
  });
}

function hit(mesh: EditMesh, f: number, by: HitRule, test: (p: Tuple3) => boolean): boolean {
  if (by === 'centroid') return test(faceCentroid(mesh, f));
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  return by === 'all' ? points.every(test) : points.some(test);
}

function pickByArea(source: FaceSelector, largest: boolean): FaceSelector {
  return new Selector(
    'face',
    `${source.description}.${largest ? 'largest' : 'smallest'}()`,
    (mesh) => {
      let best = NONE;
      let bestArea = largest ? -Infinity : Infinity;
      for (const f of source.evaluate(mesh)) {
        const area = faceArea(mesh, f);
        if (largest ? area > bestArea : area < bestArea) {
          best = f;
          bestArea = area;
        }
      }
      return best === NONE ? [] : [best];
    },
    undefined,
    [source],
  );
}

function faceNeighbors(mesh: EditMesh, f: number, across: 'any' | 'smooth'): number[] {
  const out: number[] = [];
  for (const h of mesh.faceHalves(f)) {
    if (across === 'smooth' && ((mesh.eFlags[h >> 1] as number) & EDGE_SHARP) !== 0) continue;
    const g = mesh.hFace[h ^ 1] as number;
    if (g !== NONE) out.push(g);
  }
  return out;
}

/** Argument check for selector parameters; an invalid selector resolves to this error. */
function badArgument(name: string, value: unknown, expected: string): ModelingError {
  return modelingError('model-invalid-argument', `${name} is ${expected}`, { [name]: value });
}

function stepsError(steps: number): ModelingError | undefined {
  return Number.isInteger(steps) && steps >= 1
    ? undefined
    : badArgument('steps', steps, 'an integer >= 1');
}

/** Face selector constructors and modifiers. */
export const faceSel = {
  all(): FaceSelector {
    return new Selector('face', 'all()', (mesh) => mesh.faces());
  },
  tag(name: string): FaceSelector {
    return new Selector('face', `tag('${name}')`, (mesh) => {
      const t = mesh.tagIndex(name, false);
      if (t < 0) return [];
      const word = t >> 5;
      const mask = 1 << (t & 31);
      const selected: number[] = [];
      for (let f = 0; f < mesh.faceHighWater; f++) {
        if (((mesh.fTags[f * mesh.tagWords + word] as number) & mask) !== 0 && mesh.isFaceAlive(f))
          selected.push(f);
      }
      return selected;
    });
  },
  createdBy(label: string, role?: string): FaceSelector {
    return namedFilter(
      `createdBy('${label}'${role === undefined ? '' : `, '${role}'`})`,
      (mesh) => {
        const l = mesh.labelNames.indexOf(label);
        if (l <= 0) return undefined;
        if (role === undefined) return (f) => (mesh.fLabel[f] as number) === l;
        const r = mesh.roleNames.indexOf(role);
        if (r < 0) return undefined;
        return (f) => (mesh.fLabel[f] as number) === l && (mesh.fRole[f] as number) === r;
      },
    );
  },
  material(slot: string): FaceSelector {
    return namedFilter(`material('${slot}')`, (mesh) => {
      const m = mesh.materialNames.indexOf(slot);
      return m < 0 ? undefined : (f) => (mesh.fMaterial[f] as number) === m;
    });
  },
  mirrored(): FaceSelector {
    return faceFilter(
      'mirrored()',
      (mesh, f) => ((mesh.fFlags[f] as number) & FACE_MIRRORED) !== 0,
    );
  },
  /** Faces whose normal is within `degrees` of the axis. */
  facing(axis: SignedAxis, degrees = 1): FaceSelector {
    const direction = axisVector(axis);
    const limit = cos((degrees * Math.PI) / 180);
    return faceFilter(
      `facing(${axis}, ${degrees})`,
      (mesh, f) => dot(faceNormal(mesh, f), direction) >= limit - 1e-12,
    );
  },
  /** Faces whose centroid is farthest along the axis (ties within 1e-9 m are kept). */
  extreme(axis: SignedAxis): FaceSelector {
    const direction = axisVector(axis);
    return new Selector('face', `extreme(${axis})`, (mesh) => {
      const faces = mesh.faces();
      const reach = faces.map((f) => dot(faceCentroid(mesh, f), direction));
      const max = maxOf(reach);
      return faces.filter((_, i) => (reach[i] as number) >= max - 1e-9);
    });
  },
  inBox(min: Tuple3, max: Tuple3, options: { readonly by?: HitRule } = {}): FaceSelector {
    const by = options.by ?? 'all';
    const inside = (p: Tuple3) =>
      p[0] >= min[0] &&
      p[0] <= max[0] &&
      p[1] >= min[1] &&
      p[1] <= max[1] &&
      p[2] >= min[2] &&
      p[2] <= max[2];
    return faceFilter(`inBox([${min}], [${max}], ${by})`, (mesh, f) => hit(mesh, f, by, inside));
  },
  /** Faces on the positive side of the plane through `point` with `normal`. */
  side(point: Tuple3, normal: Tuple3, options: { readonly by?: HitRule } = {}): FaceSelector {
    const by = options.by ?? 'all';
    return faceFilter(`side([${point}], [${normal}], ${by})`, (mesh, f) =>
      hit(
        mesh,
        f,
        by,
        (p) => dot([p[0] - point[0], p[1] - point[1], p[2] - point[2]], normal) >= 0,
      ),
    );
  },
  largest(source: FaceSelector): FaceSelector {
    return pickByArea(source, true);
  },
  smallest(source: FaceSelector): FaceSelector {
    return pickByArea(source, false);
  },
  grow(source: FaceSelector, steps: number): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.grow(${steps})`,
      (mesh) => {
        const set = new Set(source.evaluate(mesh));
        for (let i = 0; i < steps; i++) {
          for (const f of [...set]) for (const g of faceNeighbors(mesh, f, 'any')) set.add(g);
        }
        return [...set].sort((a, b) => a - b);
      },
      undefined,
      [source],
      stepsError(steps),
    );
  },
  connected(source: FaceSelector, across: 'any' | 'smooth'): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.connected(${across})`,
      (mesh) => {
        const set = new Set(source.evaluate(mesh));
        const stack = [...set];
        while (stack.length > 0) {
          const f = stack.pop() as number;
          for (const g of faceNeighbors(mesh, f, across)) {
            if (!set.has(g)) {
              set.add(g);
              stack.push(g);
            }
          }
        }
        return [...set].sort((a, b) => a - b);
      },
      undefined,
      [source],
    );
  },
  /** Edges of the selected faces. */
  toEdges(source: FaceSelector, include: Inclusion): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.toEdges(${include})`,
      (mesh) => {
        const faces = new Set(source.evaluate(mesh));
        const out = new Set<number>();
        for (const f of faces) {
          for (const h of mesh.faceHalves(f)) {
            const other = mesh.hFace[h ^ 1] as number;
            if (include === 'touching' || other === NONE || faces.has(other)) out.add(h >> 1);
          }
        }
        return [...out].sort((a, b) => a - b);
      },
      undefined,
      [source],
    );
  },
  /** Edges with exactly one adjacent face in the selection. */
  boundary(source: FaceSelector): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.boundary()`,
      (mesh) => {
        const faces = new Set(source.evaluate(mesh));
        const out: number[] = [];
        for (const e of mesh.edges()) {
          const a = faces.has(mesh.hFace[e * 2] as number);
          const b = faces.has(mesh.hFace[e * 2 + 1] as number);
          if (a !== b) out.push(e);
        }
        return out;
      },
      undefined,
      [source],
    );
  },
  toVerts(source: FaceSelector, include: Inclusion): VertSelector {
    return new Selector(
      'vert',
      `${source.description}.toVerts(${include})`,
      (mesh) => {
        const faces = new Set(source.evaluate(mesh));
        const out = new Set<number>();
        for (const f of faces) for (const v of mesh.faceVertices(f)) out.add(v);
        if (include === 'contained') {
          for (const f of mesh.faces()) {
            if (faces.has(f)) continue;
            for (const v of mesh.faceVertices(f)) out.delete(v);
          }
        }
        return [...out].sort((a, b) => a - b);
      },
      undefined,
      [source],
    );
  },
  shrink(source: FaceSelector, steps: number): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.shrink(${steps})`,
      (mesh) => {
        let set = new Set(source.evaluate(mesh));
        for (let i = 0; i < steps; i++) {
          const current = set;
          set = new Set(
            [...current].filter((f) =>
              mesh.faceHalves(f).every((h) => {
                const g = mesh.hFace[h ^ 1] as number;
                return g === NONE || current.has(g);
              }),
            ),
          );
        }
        return [...set].sort((a, b) => a - b);
      },
      undefined,
      [source],
      stepsError(steps),
    );
  },
  /** The `count` faces whose centroids are nearest to `point` (ties keep lower ids). */
  near(point: Tuple3, count = 1): FaceSelector {
    const error =
      !Number.isInteger(count) || count < 1
        ? badArgument('count', count, 'an integer >= 1')
        : point.every(Number.isFinite)
          ? undefined
          : badArgument('point', point, 'three finite coordinates');
    return new Selector(
      'face',
      `near([${point}], ${count})`,
      (mesh) =>
        mesh
          .faces()
          .map((f) => {
            const c = faceCentroid(mesh, f);
            return { f, d: hypot3(c[0] - point[0], c[1] - point[1], c[2] - point[2]) };
          })
          .sort((a, b) => a.d - b.d || a.f - b.f)
          .slice(0, count)
          .map(({ f }) => f)
          .sort((a, b) => a - b),
      undefined,
      [],
      error,
    );
  },
  /**
   * Faces whose opposite surface lies closer than `maxWidth` behind them (measured
   * from the face centroid against its normal), such as thin walls and fins.
   */
  thin(maxWidth: number): FaceSelector {
    const error =
      Number.isFinite(maxWidth) && maxWidth > 0
        ? undefined
        : badArgument('maxWidth', maxWidth, 'a finite distance > 0');
    return new Selector(
      'face',
      `thin(${maxWidth})`,
      (mesh) => {
        const widths = faceThickness(mesh, maxWidth);
        return mesh.faces().filter((f) => (widths.get(f) ?? Infinity) < maxWidth);
      },
      undefined,
      [],
      error,
    );
  },
};

/** Edge selector constructors. */
export const edgeSel = {
  all(): EdgeSelector {
    return new Selector('edge', 'edges.all()', (mesh) => mesh.edges());
  },
  /** Interior edges whose dihedral angle compares to `degrees`; boundary edges never match. */
  dihedral(compare: '>' | '<', degrees: number): EdgeSelector {
    const limit = cos((degrees * Math.PI) / 180);
    return new Selector('edge', `dihedral(${compare} ${degrees})`, (mesh) =>
      mesh.edges().filter((e) => {
        const a = mesh.hFace[e * 2] as number;
        const b = mesh.hFace[e * 2 + 1] as number;
        if (a === NONE || b === NONE) return false;
        const cosine = dot(faceNormal(mesh, a), faceNormal(mesh, b));
        return compare === '>' ? cosine < limit - 1e-12 : cosine > limit + 1e-12;
      }),
    );
  },
  meshBoundary(): EdgeSelector {
    return new Selector('edge', 'meshBoundary()', (mesh) =>
      mesh.edges().filter((e) => mesh.isBoundaryEdge(e)),
    );
  },
  /** Edges whose direction is within `degrees` of the axis (either sense). */
  parallel(axis: Axis, degrees = 1): EdgeSelector {
    const direction = axisVector(axis);
    const limit = cos((degrees * Math.PI) / 180);
    return new Selector('edge', `parallel(${axis}, ${degrees})`, (mesh) =>
      mesh.edges().filter((e) => {
        const [a, b] = mesh.edgeVertices(e);
        const d = normalize(sub(mesh.position(b), mesh.position(a)));
        return Math.abs(dot(d, direction)) >= limit - 1e-12;
      }),
    );
  },
  /** Edges whose direction is within `degrees` of perpendicular to the axis. */
  perpendicular(axis: Axis, degrees = 1): EdgeSelector {
    const direction = axisVector(axis);
    const limit = sin((degrees * Math.PI) / 180);
    return new Selector('edge', `perpendicular(${axis}, ${degrees})`, (mesh) =>
      mesh.edges().filter((e) => {
        const [a, b] = mesh.edgeVertices(e);
        const d = normalize(sub(mesh.position(b), mesh.position(a)));
        return Math.abs(dot(d, direction)) <= limit + 1e-12;
      }),
    );
  },
  /** Interior edges where the surface folds inward (valleys). */
  concave(): EdgeSelector {
    return new Selector('edge', 'concave()', (mesh) =>
      mesh.edges().filter((e) => {
        const a = mesh.hFace[e * 2] as number;
        const b = mesh.hFace[e * 2 + 1] as number;
        if (a === NONE || b === NONE) return false;
        // Within face b, cross(normal, edge direction) points into b; the fold is a
        // valley when that direction rises along a's normal.
        const p = mesh.position(mesh.hVert[e * 2 + 1] as number);
        const q = mesh.position(mesh.hVert[e * 2] as number);
        const inward = cross(faceNormal(mesh, b), normalize(sub(q, p)));
        return dot(faceNormal(mesh, a), inward) > 1e-9;
      }),
    );
  },
  loop(source: EdgeSelector): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.loop()`,
      (mesh) => {
        const out = new Set<number>();
        for (const e of source.evaluate(mesh)) for (const x of edgeLoop(mesh, e)) out.add(x);
        return [...out].sort((a, b) => a - b);
      },
      undefined,
      [source],
    );
  },
  ring(source: EdgeSelector): EdgeSelector {
    return new Selector(
      'edge',
      `${source.description}.ring()`,
      (mesh) => {
        const out = new Set<number>();
        for (const e of source.evaluate(mesh)) for (const x of edgeRing(mesh, e).edges) out.add(x);
        return [...out].sort((a, b) => a - b);
      },
      undefined,
      [source],
    );
  },
  sharp(): EdgeSelector {
    return new Selector('edge', 'sharp()', (mesh) =>
      mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0),
    );
  },
  /** Edges marked as UV seams (`markSeam`). */
  seam(): EdgeSelector {
    return new Selector('edge', 'seam()', (mesh) =>
      mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SEAM) !== 0),
    );
  },
  /** Faces adjacent to the selected edges. */
  toFaces(source: EdgeSelector): FaceSelector {
    return new Selector(
      'face',
      `${source.description}.toFaces()`,
      (mesh) => {
        const out = new Set<number>();
        for (const e of source.evaluate(mesh)) {
          for (const h of [e * 2, e * 2 + 1]) {
            const f = mesh.hFace[h] as number;
            if (f !== NONE) out.add(f);
          }
        }
        return [...out].sort((a, b) => a - b);
      },
      undefined,
      [source],
    );
  },
};

/** The `sel` namespace authors write against. */
export const sel = {
  ...faceSel,
  edges: edgeSel,
};
