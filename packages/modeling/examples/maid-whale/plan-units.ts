import { type FaceSelector, type FlowGuide, type Model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import PLAN from './facet-plan.json' with { type: 'json' };
import { surfaceArea } from './lowpoly.ts';

/**
 * C-200 G6 plan units (facet-plan.json `parts[].units[]`) resolved on a model: each unit's `faces`
 * (`createdBy:<label glob>` or `tag:<tag glob>|<tag glob>`) as a face selector, and its density
 * per the plan's `densityRule`: triangles per square meter within 0.8-1.6 of an equilateral
 * tiling of its `edge`, or, for a unit built as facets, each of its labels' triangle counts inside
 * `facetsPerUnit`. A `pending` unit (not built yet) passes only while it matches no faces; a unit
 * with a `densityGap` records a measured miss and its reason; a `smooth` unit is measured by neither.
 */
export interface PlanUnit {
  /**
   * Per-unit mesh-quality limit overrides with their reason (`limitsReason`): a declared loop grid splits
   * planned quads along one diagonal, which is aspect 2.0 by construction.
   */
  readonly limits?: { readonly aspectP50?: number };
  readonly limitsReason?: string;
  readonly part: string;
  readonly name: string;
  readonly faces: string;
  readonly edge?: number;
  readonly count?: number;
  readonly facetsPerUnit?: readonly [number, number];
  /** Faces the unit's selector leaves out (a plan selector, as `faces`). */
  readonly except?: string;
  /** A subdivision-surface unit (the reason): quads, so no density band and no triangle tiling. */
  readonly smooth?: string;
  /** A unit the model does not build yet (the reason): it must match no faces. */
  readonly pending?: string;
  /** A unit measured outside its band (the numbers and the reason): it must stay outside, until fixed. */
  readonly densityGap?: string;
  /** A unit failing the mesh-quality tiling gate (the numbers and the reason, "open until <unit> rebuilt"). */
  readonly tilingOpen?: string;
  /** A built unit failing the flow gate (the numbers and the reason, "open until <unit> rebuilt"). */
  readonly flowOpen?: string;
}

export const PLAN_UNITS: readonly PlanUnit[] = (PLAN.parts as readonly { name: string; units?: readonly Omit<PlanUnit, 'part'>[] }[]).flatMap((p) => (p.units ?? []).map((u) => ({ ...u, part: p.name })));

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** The faces of a plan selector (`createdBy:` matches label names, `tag:` tag names; `*` globs, `|` alternatives). */
export function planFaces(m: Model, spec: string): FaceSelector {
  const colon = spec.indexOf(':');
  const [kind, patterns] = [spec.slice(0, colon), spec.slice(colon + 1).split('|').map(glob)];
  const info = m.inspect();
  const names = kind === 'tag' ? info.tags : info.labels.map((l) => l.label);
  const matched = names.filter((n) => patterns.some((p) => p.test(n)));
  return matched.reduce((s, n) => s.or(kind === 'tag' ? sel.tag(n) : sel.createdBy(n)), sel.tag('__none__'));
}

export interface UnitDensity {
  readonly unit: PlanUnit;
  readonly triangles: number;
  readonly perM2: number;
  /** The derived band (non-built units) or the facetsPerUnit range (built units). */
  readonly band: readonly [number, number];
  /** Built units: each label's triangle count. */
  readonly perLabel?: Readonly<Record<string, number>>;
  readonly ok: boolean;
}

/** Each plan unit's density against the plan's densityRule. */
export function planDensities(m: Model): UnitDensity[] {
  const mesh = m.editMesh;
  return PLAN_UNITS.filter((u) => u.smooth === undefined).map((unit) => {
    const selector = unit.except === undefined ? planFaces(m, unit.faces) : planFaces(m, unit.faces).minus(planFaces(m, unit.except));
    const faces = selector.evaluate(mesh);
    const triangles = faces.reduce((n, f) => n + mesh.faceVertices(f).length - 2, 0);
    const area = surfaceArea(m, selector);
    const perM2 = area > 0 ? triangles / area : 0;
    if (unit.pending !== undefined) return { unit, triangles, perM2, band: [0, 0], ok: triangles === 0 };
    if (unit.facetsPerUnit !== undefined) {
      const perLabel: Record<string, number> = {};
      for (const f of faces) {
        const l = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
        perLabel[l] = (perLabel[l] ?? 0) + 1;
      }
      const [lo, hi] = unit.facetsPerUnit;
      const ok = faces.length > 0 && Object.values(perLabel).every((n) => n >= lo && n <= hi);
      return { unit, triangles, perM2, band: unit.facetsPerUnit, perLabel, ok };
    }
    const e = unit.edge as number;
    const target = 4 / (Math.sqrt(3) * e * e);
    const band = [0.8 * target, 1.6 * target] as const;
    return { unit, triangles, perM2, band, ok: triangles > 0 && perM2 >= band[0] && perM2 <= band[1] };
  });
}

export interface UnitTiling {
  readonly unit: PlanUnit;
  readonly triangles: number;
  /** The mesh-quality limits (MESH_QUALITY_LIMITS) the unit exceeds; empty when it passes. */
  readonly failed: readonly string[];
}

/** Each plan unit's mesh-quality tiling (meshQuality over its faces minus `exclude`, the plan's spikes). */
export function planTiling(m: Model, exclude: FaceSelector): UnitTiling[] {
  return PLAN_UNITS.filter((u) => u.pending === undefined && u.smooth === undefined).map((unit) => {
    const selector = (unit.except === undefined ? planFaces(m, unit.faces) : planFaces(m, unit.faces).minus(planFaces(m, unit.except))).minus(exclude);
    const q = m.meshQuality(selector, unit.limits);
    return q.ok ? { unit, triangles: q.value.triangles, failed: q.value.failed } : { unit, triangles: 0, failed: [q.error.code] };
  });
}

/** A plan flow (facet-plan.json units[].flow) as written in the plan. */
export interface PlanFlow {
  readonly kind: 'radial' | 'path' | 'around' | 'axis';
  /** A point, or one point per tag (`{ "<tag>": [x, y, z] }`, each guiding its tag's faces). */
  readonly from?: readonly number[] | string | Readonly<Record<string, readonly number[]>>;
  readonly label?: string;
  readonly axis?: readonly number[] | string;
  readonly center?: readonly number[];
  readonly dir?: readonly number[];
}

/**
 * Builders' path curves for `path` flows, by the plan flow's `label`: each entry a curve and the
 * faces it guides (the builder that lays the unit along the path exports them).
 */
export type PathCurves = Readonly<Record<string, (m: Model) => readonly { readonly faces: FaceSelector; readonly curve: readonly Tuple3[] }[]>>;

export interface UnitFlowScope {
  readonly guides: readonly FlowGuide[];
  /** The unit's faces the measure covers (radial flows leave out the disk about their point). */
  readonly faces: FaceSelector;
  /** Share of the unit's triangles inside the excluded disk. */
  readonly excluded: number;
}

const isPoint = (v: unknown): v is readonly [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');

/**
 * The one place plan flows turn into kernel flow guides (meshQuality's `flow`, later remesh's
 * direction): radial -> { from }, around -> { around: { axis, center } }, axis -> { along },
 * path -> { curve } per builder curve (`curves`). A radial flow leaves out the disk of radius
 * edge 8 / (2 pi) about its point, where meridians converge (the plan handles that by
 * construction: whorl, column halving). A flow the plan states in words (`"band axis"`,
 * `"shoulder points"`) or a path without a builder curve is not measurable: undefined.
 */
export function planFlowScope(m: Model, unit: PlanUnit & { readonly flow?: PlanFlow }, curves: PathCurves = {}): UnitFlowScope | undefined {
  const flow = unit.flow;
  if (flow === undefined) return undefined;
  const faces = unit.except === undefined ? planFaces(m, unit.faces) : planFaces(m, unit.faces).minus(planFaces(m, unit.except));
  switch (flow.kind) {
    case 'radial': {
      // One point, or one per tag (each guiding its tag's faces, with its own disk).
      const points: [FaceSelector, Tuple3][] = isPoint(flow.from)
        ? [[faces, flow.from as Tuple3]]
        : typeof flow.from === 'object' && flow.from !== null && !Array.isArray(flow.from)
          ? Object.entries(flow.from as Record<string, readonly number[]>).filter(([, p]) => isPoint(p)).map(([tag, p]) => [faces.and(sel.tag(tag)), p as Tuple3])
          : [];
      if (points.length === 0) return undefined;
      const r = ((unit.edge ?? 0) * 8) / (2 * Math.PI);
      const mesh = m.editMesh;
      const guides: FlowGuide[] = [];
      let scope: FaceSelector | undefined;
      let [inside, all] = [0, 0];
      for (const [part, from] of points) {
        const centroidIn = (f: number) => {
          const p = mesh.faceVertices(f).map((v) => mesh.position(v));
          const c = [0, 1, 2].map((k) => p.reduce((s, q) => s + (q[k] as number), 0) / p.length);
          return Math.hypot((c[0] as number) - from[0], (c[1] as number) - from[1], (c[2] as number) - from[2]) < r;
        };
        const ids = part.evaluate(mesh);
        all += ids.length;
        inside += ids.filter(centroidIn).length;
        // The disk: the mesh's faces whose centroids lie within r (the nearest that many to the point).
        const disk = r > 0 ? mesh.faces().filter(centroidIn).length : 0;
        const scoped = disk > 0 ? part.minus(sel.near(from, disk)) : part;
        guides.push({ faces: scoped, flow: { from } });
        scope = scope === undefined ? scoped : scope.or(scoped);
      }
      return { guides, faces: scope as FaceSelector, excluded: all > 0 ? inside / all : 0 };
    }
    case 'around':
      return isPoint(flow.axis) && isPoint(flow.center) ? { guides: [{ faces, flow: { around: { axis: flow.axis as Tuple3, center: flow.center as Tuple3 } } }], faces, excluded: 0 } : undefined;
    case 'axis':
      return isPoint(flow.dir) ? { guides: [{ faces, flow: { along: flow.dir as Tuple3 } }], faces, excluded: 0 } : undefined;
    case 'path': {
      const make = flow.label === undefined ? undefined : curves[flow.label];
      if (make === undefined) return undefined;
      return { guides: make(m).map(({ faces: f, curve }) => ({ faces: f.and(faces), flow: { curve } })), faces, excluded: 0 };
    }
  }
}

export interface UnitFlow {
  readonly unit: PlanUnit;
  readonly p75: number;
  readonly skipped: number;
  readonly excluded: number;
  readonly failed: readonly string[];
}

/** A unit's flow measure (meshQuality's flow option; plan gate flowP75 <= 20, flowSkipped <= 0.4). */
export function planUnitFlow(m: Model, unit: PlanUnit & { readonly flow?: PlanFlow }, curves: PathCurves = {}, exclude?: FaceSelector): UnitFlow | undefined {
  const scope = planFlowScope(m, unit, curves);
  if (scope === undefined) return undefined;
  const faces = exclude === undefined ? scope.faces : scope.faces.minus(exclude);
  const q = m.meshQuality(faces, undefined, { flow: scope.guides });
  if (!q.ok || q.value.flow === undefined) return { unit, p75: Number.NaN, skipped: Number.NaN, excluded: scope.excluded, failed: [q.ok ? 'flow' : q.error.code] };
  return { unit, p75: q.value.flow.p75, skipped: q.value.flow.skipped, excluded: scope.excluded, failed: q.value.failed.filter((f) => f === 'flowP75' || f === 'flowSkipped') };
}
