import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import type { SurfaceBlend, SurfaceCorner } from './blend';
import { atan2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  checkSurface,
  curvePoint,
  domain,
  type NurbsSurface,
  surfaceCurvature,
  surfaceDomain,
  surfacePoint,
} from './nurbs';
import { type FitSurfaceOptions, fitSurface } from './nurbs-fit';
import { type MatchLevel, matchSurfaces } from './nurbs-match';
import { type PatchSide, surfaceSplit } from './nurbs-surface';
import type { Issue } from './report';
import type { SurfacePatch } from './surface';
import {
  closestSidePoint,
  D09_CLASSES,
  type EdgeResidual,
  type FeatureLine,
  measureEdge,
  type PatchTransition,
  sideParameters,
} from './surface-quality';

/**
 * Patch layout: the plan of a surface before it is built, as
 * data. Each patch has a role, a planned degree and net, and a declaration per side:
 * shared with another patch at a required continuity, on a feature line, on a mirror
 * plane, or free (open, trimmed or hidden). `m.surface({ layout })` builds the patches
 * in role order and matches each shared side to the patch built before it;
 * `validate({ layout })` checks the plan and measures every declared side.
 */
export type PatchRole = 'primary' | 'secondary' | 'transition' | 'corner' | 'glass';

/** `'P02:u0'`: side `u0` of patch `P02`. */
export type SideRef = `${string}:${PatchSide}`;

export type LayoutSide =
  /**
   * A shared edge, declared once on either patch; a list shares one side with several
   * patches. `feature` names the feature line it lies on (a G0 crease, later blended).
   */
  | {
      readonly to: SideRef | readonly SideRef[];
      readonly continuity: MatchLevel;
      readonly feature?: string;
    }
  /** On a feature line of the layout (a crease, later blended, or a smooth crossing). */
  | { readonly feature: string }
  /** On the mirror plane `axis` = 0 (the centerline); default continuity G2. */
  | { readonly mirror: 'x' | 'y' | 'z'; readonly continuity?: MatchLevel }
  /** Nothing to match: an open, trimmed or hidden edge. */
  | { readonly free: true };

export interface LayoutPatch extends Omit<SurfacePatch, 'surface' | 'name'> {
  readonly id: string;
  readonly role: PatchRole;
  /** Planned degrees and control net (u, v); checked against the built surface. */
  readonly degree?: readonly [number, number];
  readonly net?: readonly [number, number];
  /** The panel (outer part) the patch belongs to. */
  readonly panel?: string;
  /** The patch geometry, or points to fit with the planned degree and net. */
  readonly surface?: NurbsSurface;
  readonly fit?: { readonly points: readonly (readonly Tuple3[])[] } & Omit<
    FitSurfaceOptions,
    'degree' | 'net'
  >;
  readonly sides?: Partial<Readonly<Record<PatchSide, LayoutSide>>>;
}

export interface PatchLayoutSpec {
  /** Layout name (default 'layout'), unique in the session. */
  readonly name?: string;
  readonly patches: readonly LayoutPatch[];
  /** Feature lines (`m.featureLine` names) that must lie on a patch boundary. */
  readonly featureLines?: readonly string[];
  /** Fillets between patches, applied after matching (`m.surface` blends). */
  readonly blends?: readonly SurfaceBlend[];
  /** Setback corners of those blends (`m.surface` corners); their spokes are checked at G1. */
  readonly corners?: readonly SurfaceCorner[];
}

export interface LayoutEdge {
  readonly a: string;
  readonly sideA: PatchSide;
  readonly b: string;
  readonly sideB: PatchSide;
  readonly continuity: MatchLevel;
  /** `a`'s side is shared with several patches; `b` covers part of it. */
  readonly partial: boolean;
}

/** How a fitted layout patch matches its points. */
export interface LayoutFit {
  readonly rms: number;
  readonly max: number;
  readonly converged: boolean;
  readonly maxError?: number;
}

/** What a built layout holds for its checks. */
export interface LayoutState {
  /** The matched patches (before blends), by id. */
  readonly built?: ReadonlyMap<string, NurbsSurface>;
  /** Residuals of the patches fit to points. */
  readonly fits?: ReadonlyMap<string, LayoutFit>;
  /** Quads of the setback corners by corner name, in fill order (spoke k joins quads k and k + 1). */
  readonly corners?: ReadonlyMap<string, readonly NurbsSurface[]>;
}

export interface ResolvedLayout {
  readonly name: string;
  readonly spec: PatchLayoutSpec;
  readonly edges: readonly LayoutEdge[];
}

export type LayoutCode =
  | 'layout-unbuilt'
  | 'layout-fit'
  | 'layout-rows'
  | 'layout-net'
  | 'layout-degree'
  | 'layout-feature-unplaced'
  | 'layout-continuity'
  | 'layout-highlight'
  | 'layout-degenerate-corner';

export interface LayoutCheckOptions {
  /** surface-quality limits of shared edges: gap (m), kink (degrees), curvature and rate ratios. */
  readonly position?: number;
  readonly angle?: number;
  readonly curvature?: number;
  /** Curvature ratio for edges of a transition patch (default 0.05). */
  readonly transitionCurvature?: number;
  readonly rate?: number;
  /**
   * Largest distance between a side and its feature line, and between every point of a
   * listed line and the nearest side declared on it (end to end), m (default 1e-4).
   */
  readonly featureTolerance?: number;
  /** Largest distance between a fitted patch and its points, m (default its maxError, else 1e-3). */
  readonly fitTolerance?: number;
  /**
   * Highlight bands: an invisible boundary (a smooth matched edge; feature
   * lines, fillets, shut lines and trims define the bands) runs along the bands or across
   * them, never obliquely. `parallel` and `across` (degrees, default 10 and 60) bound
   * the angle between the side and the band direction (the direction of least curvature)
   * that passes; a quarter of the side in between, weighted by the curvature anisotropy, is
   * reported. Points flatter than R100 m (0.01 1/m) or with anisotropy below 0.2 are skipped.
   */
  readonly highlight?: { readonly parallel?: number; readonly across?: number };
  /** Primary corners whose sides meet within this many degrees of straight or folded (default 20). */
  readonly cornerAngle?: number;
  /** A primary side shorter than this fraction of its opposite side is a wedge (default 0.05). */
  readonly shortSide?: number;
}

const ROLES: readonly PatchRole[] = ['primary', 'secondary', 'glass', 'transition', 'corner'];
const SIDES: readonly PatchSide[] = ['u0', 'u1', 'v0', 'v1'];
const LEVELS: Readonly<Record<MatchLevel, number>> = { G0: 0, G1: 1, G2: 2, G3: 3 };
const OPPOSITE: Readonly<Record<PatchSide, PatchSide>> = { u0: 'u1', u1: 'u0', v0: 'v1', v1: 'v0' };
const DEGREES = 180 / Math.PI;

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function parseRef(ref: unknown): { id: string; side: PatchSide } | undefined {
  if (typeof ref !== 'string') return undefined;
  const at = ref.lastIndexOf(':');
  const side = ref.slice(at + 1) as PatchSide;
  return at > 0 && SIDES.includes(side) ? { id: ref.slice(0, at), side } : undefined;
}

/** Check a layout's structure: ids, roles, side declarations and references. */
export function resolveLayout(spec: PatchLayoutSpec): Result<ResolvedLayout, ModelingError> {
  if (
    spec === null ||
    typeof spec !== 'object' ||
    !Array.isArray(spec.patches) ||
    spec.patches.length === 0
  )
    return err(invalid('a layout has at least one patch'));
  const ids = new Set<string>();
  for (const [index, patch] of spec.patches.entries()) {
    if (typeof patch?.id !== 'string' || patch.id.length === 0 || ids.has(patch.id))
      return err(invalid('every layout patch has a unique non-empty id', { index }));
    ids.add(patch.id);
    if (!ROLES.includes(patch.role))
      return err(
        invalid(`role is one of ${ROLES.join(', ')}`, { patch: patch.id, role: patch.role }),
      );
    for (const key of ['degree', 'net'] as const) {
      const v = patch[key];
      if (
        v !== undefined &&
        !(Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1))
      )
        return err(invalid(`${key} holds two integers >= 1`, { patch: patch.id, [key]: v }));
    }
    if (patch.surface !== undefined) {
      const c = checkSurface(patch.surface);
      if (!c.ok)
        return err({ ...c.error, detail: { ...c.error.detail, patch: patch.id } } as ModelingError);
    }
    if (patch.surface !== undefined && patch.fit !== undefined)
      return err(
        invalid('a layout patch has a surface or fit points, not both', { patch: patch.id }),
      );
  }
  const lines = new Set(spec.featureLines ?? []);
  if (
    spec.featureLines !== undefined &&
    !spec.featureLines.every((n) => typeof n === 'string' && n.length > 0)
  )
    return err(invalid('featureLines holds feature line names'));
  const edges: LayoutEdge[] = [];
  const claimed = new Map<string, string>();
  const claim = (key: string, by: string): ModelingError | undefined => {
    const previous = claimed.get(key);
    if (previous !== undefined)
      return modelingError(
        'model-invalid-argument',
        'each shared side is declared once (on either patch)',
        { side: key, declaredBy: [previous, by] },
        'remove the duplicate declaration from one of the two patches',
      );
    claimed.set(key, by);
    return undefined;
  };
  for (const patch of spec.patches) {
    for (const [side, decl] of Object.entries(patch.sides ?? {}) as [PatchSide, LayoutSide][]) {
      const here = `${patch.id}:${side}`;
      if (!SIDES.includes(side))
        return err(
          invalid("sides are keyed by 'u0', 'u1', 'v0' or 'v1'", { patch: patch.id, side }),
        );
      if (decl === null || typeof decl !== 'object')
        return err(
          invalid('a side declaration is { to }, { feature }, { mirror } or { free }', {
            side: here,
          }),
        );
      if ('to' in decl) {
        if (!(decl.continuity in LEVELS))
          return err(
            invalid("continuity is 'G0' to 'G3'", { side: here, continuity: decl.continuity }),
          );
        if (decl.feature !== undefined && !lines.has(decl.feature))
          return err(
            invalid('a feature side names a line listed in featureLines', {
              side: here,
              feature: decl.feature,
            }),
          );
        const targets = Array.isArray(decl.to) ? decl.to : [decl.to];
        if (targets.length === 0) return err(invalid('to names at least one side', { side: here }));
        const c0 = claim(here, here);
        if (c0 !== undefined) return err(c0);
        for (const target of targets) {
          const ref = parseRef(target);
          if (ref === undefined || !ids.has(ref.id) || (ref.id === patch.id && ref.side === side))
            return err(
              invalid("to names another patch side as 'id:side'", { side: here, to: target }),
            );
          const c = claim(`${ref.id}:${ref.side}`, here);
          if (c !== undefined && targets.length === 1) return err(c);
          edges.push({
            a: patch.id,
            sideA: side,
            b: ref.id,
            sideB: ref.side,
            continuity: decl.continuity,
            partial: targets.length > 1,
          });
        }
      } else if ('feature' in decl) {
        if (typeof decl.feature !== 'string' || !lines.has(decl.feature))
          return err(
            invalid('a feature side names a line listed in featureLines', {
              side: here,
              feature: decl.feature,
            }),
          );
      } else if ('mirror' in decl) {
        if (!['x', 'y', 'z'].includes(decl.mirror))
          return err(invalid("mirror is 'x', 'y' or 'z'", { side: here }));
        if (decl.continuity !== undefined && !(decl.continuity in LEVELS))
          return err(invalid("continuity is 'G0' to 'G3'", { side: here }));
      } else if (!('free' in decl && decl.free === true))
        return err(
          invalid('a side declaration is { to }, { feature }, { mirror } or { free }', {
            side: here,
          }),
        );
    }
  }
  return ok({ name: spec.name ?? 'layout', spec, edges });
}

const rank = (role: PatchRole) => ROLES.indexOf(role);

/** The feature line a side declaration lies on, if any. */
function featureOf(decl: LayoutSide | undefined): string | undefined {
  return decl !== undefined && 'feature' in decl ? decl.feature : undefined;
}

/** Patches in build order: by role, then declaration order. */
function buildOrder(spec: PatchLayoutSpec): LayoutPatch[] {
  return spec.patches
    .map((p, i) => ({ p, i }))
    .sort((x, y) => rank(x.p.role) - rank(y.p.role) || x.i - y.i)
    .map((x) => x.p);
}

function mirrored(s: NurbsSurface, axis: 'x' | 'y' | 'z'): NurbsSurface {
  const c = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  return {
    ...s,
    points: s.points.map((row) =>
      row.map(
        (p): Tuple3 => [c === 0 ? -p[0] : p[0], c === 1 ? -p[1] : p[1], c === 2 ? -p[2] : p[2]],
      ),
    ),
  };
}

/** The part of `s` along `side` between normalized positions f0 < f1 (exact, by splitting). */
function sidePiece(
  s: NurbsSurface,
  side: PatchSide,
  f0: number,
  f1: number,
): Result<NurbsSurface, ModelingError> {
  const dir = side === 'u0' || side === 'u1' ? 'v' : 'u';
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const [a, b] = dir === 'v' ? [v0, v1] : [u0, u1];
  let piece = s;
  const t1 = a + (b - a) * f1;
  if (f1 < 1 - 1e-12) {
    const r = surfaceSplit(piece, dir, t1);
    if (!r.ok) return r;
    piece = r.value[0];
  }
  const t0 = a + (b - a) * f0;
  if (f0 > 1e-12) {
    const r = surfaceSplit(piece, dir, t0);
    if (!r.ok) return r;
    piece = r.value[1];
  }
  return ok(piece);
}

function sidePoint(s: NurbsSurface, side: PatchSide, f: number): Tuple3 {
  const [u, v] = sideParameters(s, side, f);
  return surfacePoint(s, u, v);
}

/**
 * Build the layout's patches: fit the ones given as points, then in role order hold each
 * mirror side and match each shared side to the patch built before it. Returns the
 * matched surfaces by id (patches without geometry are skipped).
 */
export function buildLayout(
  layout: ResolvedLayout,
): Result<{ surfaces: Map<string, NurbsSurface>; fits: Map<string, LayoutFit> }, ModelingError> {
  const built = new Map<string, NurbsSurface>();
  const fits = new Map<string, LayoutFit>();
  const fail = (patch: string, e: ModelingError) =>
    err({ ...e, detail: { ...e.detail, patch, layout: layout.name } } as ModelingError);
  const order = buildOrder(layout.spec);
  const position = new Map(order.map((p, i) => [p.id, i]));
  for (const patch of order) {
    let s = patch.surface;
    if (patch.fit !== undefined) {
      const { points, ...options } = patch.fit;
      const fit = fitSurface(points, {
        ...options,
        ...(patch.degree === undefined ? {} : { degree: patch.degree }),
        net: patch.net ?? 'auto',
      });
      if (!fit.ok) return fail(patch.id, fit.error);
      s = fit.value.surface;
      fits.set(patch.id, {
        rms: fit.value.rms,
        max: fit.value.max,
        converged: fit.value.converged,
        ...(options.maxError === undefined ? {} : { maxError: options.maxError }),
      });
    }
    if (s === undefined) continue;
    // What each side must keep once it is matched: its level, or its position.
    const kept = new Map<PatchSide, MatchLevel | 'none'>();
    for (const side of SIDES) {
      const decl = patch.sides?.[side];
      kept.set(side, decl === undefined || 'free' in decl ? 'none' : 'G0');
    }
    for (const side of SIDES) {
      const decl = patch.sides?.[side];
      if (decl === undefined || !('mirror' in decl)) continue;
      const level = decl.continuity ?? 'G2';
      const m = matchSurfaces(s, side, mirrored(s, decl.mirror), side, {
        level,
        modify: 'both',
        opposite: kept.get(OPPOSITE[side]) ?? 'G0',
      });
      if (!m.ok) return fail(patch.id, m.error);
      s = m.value.a;
      kept.set(side, level);
    }
    const mine = layout.edges.filter((e) => {
      const other = e.a === patch.id ? e.b : e.b === patch.id ? e.a : undefined;
      return (
        other !== undefined &&
        built.has(other) &&
        (position.get(other) as number) < (position.get(patch.id) as number)
      );
    });
    mine.sort((x, y) => LEVELS[x.continuity] - LEVELS[y.continuity]);
    for (const e of mine) {
      const here =
        e.a === patch.id
          ? { side: e.sideA, other: e.b, otherSide: e.sideB }
          : { side: e.sideB, other: e.a, otherSide: e.sideA };
      let master = built.get(here.other) as NurbsSurface;
      if (e.partial && e.b === patch.id) {
        // The master side covers several patches: match against the part beside this one.
        const ends = [0, 1].map(
          (f) =>
            closestSidePoint(master, here.otherSide, sidePoint(s as NurbsSurface, here.side, f)).f,
        );
        const [f0, f1] = [minOf(ends), maxOf(ends)];
        const piece = sidePiece(master, here.otherSide, f0, f1);
        if (!piece.ok) return fail(patch.id, piece.error);
        master = piece.value;
      } else if (e.partial)
        return fail(
          patch.id,
          modelingError(
            'model-precondition',
            'a side shared with several patches belongs to the patch built first',
            { side: `${patch.id}:${here.side}` },
            'give the shared patch a higher role, or declare it earlier',
          ),
        );
      // When both neighbouring sides are fixed, fit the reparametrization at the edge's ends
      // so their curves stay exact (the corners where this edge meets them).
      const adjacent = (
        here.side === 'u0' || here.side === 'u1' ? ['v0', 'v1'] : ['u0', 'u1']
      ) as PatchSide[];
      const fixedEnds = adjacent.every((a) => (kept.get(a) ?? 'none') !== 'none');
      const m = matchSurfaces(s, here.side, master, here.otherSide, {
        level: e.continuity,
        opposite: kept.get(OPPOSITE[here.side]) ?? 'G0',
        scale: fixedEnds ? 'ends' : 'fit',
      });
      if (!m.ok) return fail(patch.id, m.error);
      s = m.value.a;
      kept.set(here.side, e.continuity);
    }
    built.set(patch.id, s);
  }
  return ok({ surfaces: built, fits });
}

/** The patch list `m.surface` tessellates for a built layout. */
export function layoutPatches(
  layout: ResolvedLayout,
  built: ReadonlyMap<string, NurbsSurface>,
): SurfacePatch[] {
  return layout.spec.patches.flatMap((patch) => {
    const surface = built.get(patch.id);
    if (surface === undefined) return [];
    const {
      id,
      role,
      degree: _d,
      net: _n,
      panel: _p,
      fit: _f,
      sides: _s,
      surface: _g,
      ...rest
    } = patch;
    const corner = layout.spec.corners?.find(
      (c) => id === (c.name ?? 'corner') || id.startsWith(`${c.name ?? 'corner'}-`),
    );
    const transition: PatchTransition | undefined =
      role === 'transition'
        ? {
            kind: 'blend',
            continuity: layout.spec.blends?.find((b) => b.name === id)?.continuity ?? 'G1',
          }
        : role === 'corner'
          ? { kind: 'corner', continuity: corner?.continuity ?? 'G1' }
          : undefined;
    return [{ ...rest, name: id, surface, ...(transition === undefined ? {} : { transition }) }];
  });
}

/** Control rows a side declaration needs in the direction across it. */
function need(layout: ResolvedLayout, patch: LayoutPatch, side: PatchSide): number {
  const decl = patch.sides?.[side];
  const shared = layout.edges.filter(
    (e) => (e.a === patch.id && e.sideA === side) || (e.b === patch.id && e.sideB === side),
  );
  if (shared.length > 0) return 1 + maxOf(shared.map((e) => LEVELS[e.continuity]));
  if (decl === undefined || 'free' in decl) return 1;
  if ('feature' in decl) return 2;
  if ('mirror' in decl) return 1 + LEVELS[decl.continuity ?? 'G2'];
  return 1;
}

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Tuple3) => Math.sqrt(dot(a, a));
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const angle = (a: Tuple3, b: Tuple3) => atan2(norm(cross(a, b)), dot(a, b)) * DEGREES;

function achieved(
  r: EdgeResidual,
  limits: { position: number; angle: number; curvature: number; rate: number },
): MatchLevel | 'none' {
  if (r.gap > limits.position) return 'none';
  if (r.angle > limits.angle) return 'G0';
  if (r.curvatureRatio > limits.curvature) return 'G1';
  if (r.rateRatio > limits.rate) return 'G2';
  return 'G3';
}

/** Distance from `p` to a polyline. */
function polylineGap(poly: readonly Tuple3[], p: Tuple3): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1] as Tuple3;
    const ab = sub(poly[i] as Tuple3, a);
    const l2 = dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
    best = Math.min(best, norm(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])));
  }
  return best;
}

/**
 * The worst quarter of a side for highlight crossing: the mean, over 4 consecutive samples
 * of 16, of anisotropy where the side runs at an angle to the band direction strictly
 * between `parallel` and `across` degrees (0 elsewhere and at flat points).
 */
function highlightScore(
  s: NurbsSurface,
  side: PatchSide,
  parallel: number,
  across: number,
): number {
  const values: number[] = [];
  for (let k = 0; k < 16; k++) {
    const [u, v] = sideParameters(s, side, (k + 0.5) / 16);
    const c = surfaceCurvature(s, u, v);
    values.push(0);
    if (c === undefined) continue;
    const along = side === 'u0' || side === 'u1' ? c.sv : c.su;
    // The bands run along the direction of least curvature.
    const strong = Math.abs(c.k1) >= Math.abs(c.k2) ? c.k1 : c.k2;
    const weak = Math.abs(c.k1) >= Math.abs(c.k2) ? c.k2 : c.k1;
    if (!(Math.abs(strong) > 0.01)) continue;
    const [E, F, G] = c.first;
    const [L, M, N] = c.second;
    const r1: [number, number] = [-(M - weak * F), L - weak * E];
    const r2: [number, number] = [-(N - weak * G), M - weak * F];
    const [a, b] = r1[0] * r1[0] + r1[1] * r1[1] >= r2[0] * r2[0] + r2[1] * r2[1] ? r1 : r2;
    const band: Tuple3 = [
      c.su[0] * a + c.sv[0] * b,
      c.su[1] * a + c.sv[1] * b,
      c.su[2] * a + c.sv[2] * b,
    ];
    if (!(norm(band) > 0)) continue;
    const theta = Math.min(angle(along, band), 180 - angle(along, band));
    const anisotropy = (Math.abs(strong) - Math.abs(weak)) / (Math.abs(strong) + Math.abs(weak));
    // Below 0.2 there is no band direction to speak of.
    values[k] = anisotropy >= 0.2 && theta > parallel && theta < across ? anisotropy : 0;
  }
  let worst = 0;
  for (let k = 0; k + 4 <= values.length; k++)
    worst = Math.max(worst, values.slice(k, k + 4).reduce((x, y) => x + y, 0) / 4);
  return worst;
}

/**
 * Check a layout: the plan (rows each side needs, primary nets, matched degrees, placed
 * feature lines) and, for built patches, every declared side as measured: shared and
 * mirror sides against their continuity (surface-quality limits), feature sides on
 * their line, sides that cross a highlight band obliquely, and degenerate primary corners.
 */
export function checkLayout(
  layout: ResolvedLayout,
  lines: readonly FeatureLine[],
  options: LayoutCheckOptions = {},
  state: LayoutState = {},
): Issue<LayoutCode>[] {
  const built = state.built;
  const d09 = D09_CLASSES.primary;
  const limits = {
    position: options.position ?? d09.position,
    angle: options.angle ?? d09.angle,
    curvature: options.curvature ?? d09.curvatureRatio,
    rate: options.rate ?? d09.rateRatio,
  };
  const transition = options.transitionCurvature ?? D09_CLASSES.blend.curvatureRatio;
  const featureTolerance = options.featureTolerance ?? 1e-4;
  const parallel = options.highlight?.parallel ?? 10;
  const across = options.highlight?.across ?? 60;
  const cornerAngle = options.cornerAngle ?? 20;
  const shortSide = options.shortSide ?? 0.05;
  const issues: Issue<LayoutCode>[] = [];
  const byId = new Map(layout.spec.patches.map((p) => [p.id, p]));
  const netOf = (p: LayoutPatch): readonly [number, number] | undefined => {
    const s = built?.get(p.id) ?? p.surface;
    return s !== undefined ? [s.points.length, (s.points[0] as readonly Tuple3[]).length] : p.net;
  };
  const degreeOf = (p: LayoutPatch): readonly [number, number] | undefined => {
    const s = built?.get(p.id) ?? p.surface;
    return s !== undefined ? [s.degreeU, s.degreeV] : p.degree;
  };
  for (const patch of layout.spec.patches) {
    const net = netOf(patch);
    if (net === undefined) continue;
    for (const [d, lo, hi] of [
      [0, 'u0', 'u1'],
      [1, 'v0', 'v1'],
    ] as const) {
      const required = need(layout, patch, lo) + need(layout, patch, hi);
      if ((net[d] as number) < required)
        issues.push({
          code: 'layout-rows',

          severity: 'warn',
          detail: {
            subject: patch.id,
            direction: d === 0 ? 'u' : 'v',
            rows: net[d],
            required,
            hint: 'add spans or raise the degree across the matched sides',
          },
        });
    }
    if (patch.role === 'primary' && net.some((n) => n > 8))
      issues.push({
        code: 'layout-net',

        severity: 'warn',
        detail: {
          subject: patch.id,
          net,
          limit: 8,
          rule: 'a primary has at most 8 control points per direction',
        },
      });
    const s = built?.get(patch.id) ?? patch.surface;
    if (
      s !== undefined &&
      patch.net !== undefined &&
      (patch.net[0] !== net[0] || patch.net[1] !== net[1])
    )
      issues.push({
        code: 'layout-net',
        severity: 'warn',
        detail: { subject: patch.id, net, planned: patch.net },
      });
  }
  for (const e of layout.edges) {
    const a = byId.get(e.a) as LayoutPatch;
    const b = byId.get(e.b) as LayoutPatch;
    const da = degreeOf(a);
    const db = degreeOf(b);
    if (da === undefined || db === undefined) continue;
    const along = (d: readonly [number, number], side: PatchSide) =>
      side === 'u0' || side === 'u1' ? d[1] : d[0];
    if (along(da, e.sideA) !== along(db, e.sideB))
      issues.push({
        code: 'layout-degree',

        severity: 'warn',
        detail: {
          subject: `${e.a}:${e.sideA}|${e.b}:${e.sideB}`,
          degrees: [along(da, e.sideA), along(db, e.sideB)],
          rule: 'matched sides have the same degree along the edge',
        },
      });
  }
  const placed = new Set<string>();
  for (const patch of layout.spec.patches)
    for (const decl of Object.values(patch.sides ?? {}))
      if (featureOf(decl) !== undefined) placed.add(featureOf(decl) as string);
  for (const name of layout.spec.featureLines ?? [])
    if (!placed.has(name))
      issues.push({
        code: 'layout-feature-unplaced',

        severity: 'warn',
        detail: { subject: name, reason: 'no patch side lies on the line' },
      });
  if (built === undefined) {
    issues.push({
      code: 'layout-unbuilt',

      severity: 'warn',
      detail: {
        subject: layout.name,
        reason: 'the layout is not built: only its plan was checked',
        hint: 'build it with m.surface({ layout })',
      },
    });
    return issues;
  }
  for (const patch of layout.spec.patches)
    if (!built.has(patch.id) && patch.role !== 'corner')
      issues.push({
        code: 'layout-unbuilt',

        severity: 'warn',
        detail: {
          subject: patch.id,
          reason: 'the patch has no surface or fit points: its sides were not measured',
        },
      });
  // A2: every listed feature line lies on declared sides end to end.
  for (const name of layout.spec.featureLines ?? []) {
    const line = lines.find((l) => l.name === name);
    if (line === undefined) continue;
    const sides: Tuple3[][] = [];
    for (const patch of layout.spec.patches) {
      const s = built.get(patch.id);
      if (s === undefined) continue;
      for (const side of SIDES)
        if (featureOf(patch.sides?.[side]) === name)
          sides.push(Array.from({ length: 65 }, (_, k) => sidePoint(s, side, k / 64)));
    }
    if (sides.length === 0) continue;
    const [t0, t1] = domain(line.curve);
    let worst = 0;
    let at: Tuple3 = [0, 0, 0];
    for (let k = 0; k <= 64; k++) {
      const p = curvePoint(line.curve, t0 + ((t1 - t0) * k) / 64);
      const d = minOf(sides.map((poly) => polylineGap(poly, p)));
      if (d > worst) {
        worst = d;
        at = p;
      }
    }
    if (worst > featureTolerance)
      issues.push({
        code: 'layout-feature-unplaced',

        severity: 'warn',
        detail: {
          subject: name,
          reason: 'part of the line lies on no declared side',
          distance: worst,
          point: at,
          tolerance: featureTolerance,
        },
      });
  }
  // A1: a fitted patch against its points.
  for (const [id, fit] of state.fits ?? []) {
    const tolerance = options.fitTolerance ?? fit.maxError ?? 1e-3;
    if (!fit.converged || fit.max > tolerance)
      issues.push({
        code: 'layout-fit',

        severity: 'warn',
        detail: {
          subject: id,
          max: fit.max,
          rms: fit.rms,
          converged: fit.converged,
          tolerance,
          hint: 'the fit leaves its points: lower the fairing, add spans, or loosen the fixed boundaries',
        },
      });
  }

  // Blends trim the patches beside a crease and never move them: every edge is measured as built.
  for (const e of layout.edges) {
    const A = built.get(e.a);
    const B = built.get(e.b);
    if (A === undefined || B === undefined) continue;
    // The smaller side is measured against the larger one, so a shared side's part matches.
    const [x, sx, y, sy] = e.partial ? [B, e.sideB, A, e.sideA] : [A, e.sideA, B, e.sideB];
    const r = measureEdge(x, sx, y, sy);
    if (!r.ok) continue;
    const roles = [byId.get(e.a)?.role, byId.get(e.b)?.role];
    const l = {
      ...limits,
      curvature: roles.includes('transition') ? transition : limits.curvature,
    };
    const got = achieved(r.value, l);
    if ((got === 'none' ? -1 : LEVELS[got]) < LEVELS[e.continuity])
      issues.push({
        code: 'layout-continuity',

        severity: 'warn',
        detail: {
          subject: `${e.a}:${e.sideA}|${e.b}:${e.sideB}`,
          required: e.continuity,
          achieved: got,
          residual: r.value,
          limits: l,
        },
      });
  }
  // Corner spokes are G1 by design: required G1, never more.
  for (const [name, quads] of state.corners ?? new Map<string, readonly NurbsSurface[]>())
    for (const [k, q] of quads.entries()) {
      const next = quads[(k + 1) % quads.length] as NurbsSurface;
      const r = measureEdge(q, 'u0', next, 'v0');
      if (!r.ok) continue;
      const got = achieved(r.value, { ...limits, curvature: transition });
      if ((got === 'none' ? -1 : LEVELS[got]) < LEVELS.G1)
        issues.push({
          code: 'layout-continuity',
          severity: 'warn',
          detail: {
            subject: `${name}-${k}:u0|${name}-${(k + 1) % quads.length}:v0`,
            required: 'G1',
            achieved: got,
            residual: r.value,
          },
        });
    }
  for (const patch of layout.spec.patches) {
    const s = built.get(patch.id);
    if (s === undefined) continue;
    for (const side of SIDES) {
      const decl = patch.sides?.[side];
      if (decl !== undefined && 'mirror' in decl) {
        const level = decl.continuity ?? 'G2';
        const r = measureEdge(s, side, mirrored(s, decl.mirror), side);
        if (r.ok) {
          const got = achieved(r.value, limits);
          if ((got === 'none' ? -1 : LEVELS[got]) < LEVELS[level])
            issues.push({
              code: 'layout-continuity',

              severity: 'warn',
              detail: {
                subject: `${patch.id}:${side}`,
                required: level,
                achieved: got,
                mirror: decl.mirror,
                residual: r.value,
              },
            });
        }
      }
      const featureName = featureOf(decl);
      if (featureName !== undefined) {
        const line = lines.find((l) => l.name === featureName);
        if (line !== undefined) {
          const [t0, t1] = domain(line.curve);
          const poly = Array.from({ length: 513 }, (_, k) =>
            curvePoint(line.curve, t0 + ((t1 - t0) * k) / 512),
          );
          let worst = 0;
          for (let k = 0; k <= 16; k++)
            worst = Math.max(worst, polylineGap(poly, sidePoint(s, side, k / 16)));
          if (worst > featureTolerance)
            issues.push({
              code: 'layout-feature-unplaced',

              severity: 'warn',
              detail: {
                subject: featureName,
                reason: 'the declared side is off the line',
                side: `${patch.id}:${side}`,
                distance: worst,
                tolerance: featureTolerance,
              },
            });
        }
      }
      // Only invisible boundaries (smooth matched edges): feature lines, fillets, shut lines
      // and trims define the bands themselves.
      const invisible = layout.edges.some(
        (e) =>
          LEVELS[e.continuity] >= 1 &&
          ((e.a === patch.id && e.sideA === side) || (e.b === patch.id && e.sideB === side)),
      );
      if (invisible && featureName === undefined && patch.role !== 'transition') {
        const score = highlightScore(s, side, parallel, across);
        if (score > 0.5)
          issues.push({
            code: 'layout-highlight',

            severity: 'warn',
            detail: {
              subject: `${patch.id}:${side}`,
              score,
              band: [parallel, across],
              hint: 'run the boundary along the highlight band or across it, not diagonally',
            },
          });
      }
    }
    if (patch.role === 'primary') {
      // A side much shorter than its opposite side makes a wedge (a near-triangular primary).
      const sideLength = (side: PatchSide) => {
        let l = 0;
        let q = sidePoint(s, side, 0);
        for (let k = 1; k <= 32; k++) {
          const r = sidePoint(s, side, k / 32);
          l += norm(sub(r, q));
          q = r;
        }
        return l;
      };
      for (const [x, y] of [
        ['u0', 'u1'],
        ['u1', 'u0'],
        ['v0', 'v1'],
        ['v1', 'v0'],
      ] as const) {
        const lx = sideLength(x);
        const ly = sideLength(y);
        if (lx < shortSide * ly)
          issues.push({
            code: 'layout-degenerate-corner',

            severity: 'warn',
            detail: {
              subject: patch.id,
              side: x,
              length: lx,
              opposite: ly,
              ratio: lx / ly,
              limit: shortSide,
              hint: 'a primary is four-sided with sides of comparable length: extend and trim, or split into quads',
            },
          });
      }
      const [[u0, u1], [v0, v1]] = surfaceDomain(s);
      const size = Math.max(maxOf(s.points.flat().map((p) => norm(p))), 1);
      for (const [u, v] of [
        [u0, v0],
        [u1, v0],
        [u0, v1],
        [u1, v1],
      ] as const) {
        const c = surfaceCurvature(s, u, v);
        const at = surfacePoint(s, u, v);
        const tiny = (w: Tuple3) => norm(w) <= 1e-9 * size;
        const su = c?.su;
        const sv = c?.sv;
        const bad =
          su === undefined ||
          sv === undefined ||
          tiny(su) ||
          tiny(sv) ||
          angle(su, sv) < cornerAngle ||
          angle(su, sv) > 180 - cornerAngle;
        if (bad)
          issues.push({
            code: 'layout-degenerate-corner',

            severity: 'warn',
            detail: {
              subject: patch.id,
              corner: [u, v],
              point: at,
              ...(su !== undefined && sv !== undefined ? { angle: angle(su, sv) } : {}),
              hint: 'collapsed or folded corners pinch the highlight: extend and trim, or split into quads',
            },
          });
      }
    }
  }
  return issues;
}
