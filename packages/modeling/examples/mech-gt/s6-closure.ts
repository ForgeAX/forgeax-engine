import { type Model, sel, TriangleBvh, type Tuple3 } from '@forgeax/engine-modeling';

/**
 * Case C-100 criterion 14 (code name mech-gt): car-form closure. Two gates on a car-form
 * model whose faces carry `part:<id>` tags (the finished car, or the rig posed at u = 0):
 *
 * - `closureRays`: rays from a bounding sphere may only land on exterior skin, or pass a
 *   designed opening (OPENINGS) and land on that opening's designed surfaces. A ray that
 *   reaches anything else (internals, mechanisms, hardware) or passes through the body is a
 *   failure, reported per opening and per part it reached.
 * - `seams`: every designed shut line, sampled every centimeter, has a gap of 3–4 mm between
 *   the two panels' outer edges and a flush offset of at most 1 mm.
 */

/**
 * Criterion 14 as a hard gate. While false, the car-form case reports the closure and seam
 * measures; set true once the form line's closure fix is green, and the case (CI included)
 * then fails on any failing ray or any shut line with more than SEAM.lineTolerance of its
 * stations outside the gap band or over the flush limit. `FORGEAX_CLOSURE_GATE=1` turns it
 * on for one run (to check a branch before flipping it).
 */
export const CLOSURE_GATE = false;

/** The gate verdict of one report: the failing rays and lines it would block on. */
export function closureVerdict(rays: Pick<ClosureReport, 'failures'>, lines: readonly SeamLine[]): { readonly rays: number; readonly lines: readonly string[] } {
  return {
    rays: Object.values(rays.failures).reduce((a, b) => a + b, 0),
    lines: lines.filter((l) => l.failing > SEAM.lineTolerance).map((l) => `${l.pair.join(' | ')}: ${(l.failing * 100).toFixed(0)} % of ${l.samples} stations (gap median ${(l.gap.median * 1000).toFixed(1)} mm, flush p90 ${(l.flush.p90 * 1000).toFixed(1)} mm)`),
  };
}

/** A part's role in car form. */
export type Role = 'skin' | 'cockpit' | 'internal';

/** Exterior parts: body panels with the details that ride them, wheels and lamps. */
const SKIN: readonly RegExp[] = [
  /^(hood|front-fender|door|roof|windshield|side-intake|rear-fender|engine-cover|bumper|diffuser|rear-wing|headlight)-?/,
  /^(front|rear)-wheel-[lr]$/,
];
/** The cabin seen through the glass. */
const COCKPIT: readonly RegExp[] = [/^monocoque$/];

export function roleOf(part: string): Role {
  if (SKIN.some((r) => r.test(part))) return 'skin';
  if (COCKPIT.some((r) => r.test(part))) return 'cockpit';
  return 'internal';
}

/**
 * The underbody: faces of any part that face the ground (normal within 45 degrees of -y)
 * below UNDERBODY.y are the car's exterior from below (floor, undertray, subframe bottoms).
 */
export const UNDERBODY = { y: 0.2, normalY: -Math.SQRT1_2 } as const;

/**
 * The reviewed allowlist of designed openings: the surface a ray passes (by material), and
 * the roles it may land on behind it. Glass shows the cabin (and through it, the panels'
 * inner faces and the glass on the far side); lamp lenses show their own lamp cavity.
 * Intakes, grilles, louvres and exhaust tips are solid skin surfaces in this car, and the
 * wheel arches open onto the wheels (skin), so no ray needs to pass them.
 */
export const OPENINGS = {
  glass: { materials: ['glass', 'gt-glass'], behind: ['skin', 'cockpit'] as readonly Role[], exit: true },
} as const;
type Opening = keyof typeof OPENINGS;

interface SurfaceIndex {
  readonly bvh: TriangleBvh;
  /** Per triangle: part id ('' when untagged) and material slot. */
  readonly part: readonly string[];
  readonly material: readonly string[];
  /** Per triangle: the y component of its unit normal. */
  readonly normalY: Float64Array;
  readonly box: { readonly min: Tuple3; readonly max: Tuple3 };
}

function indexOf(m: Model): SurfaceIndex {
  const mesh = m.editMesh;
  const tags = mesh.tagNames.filter((t) => t.startsWith('part:')).map((t) => [t.slice(5), mesh.tagIndex(t, false)] as const);
  const positions: number[] = [];
  const indices: number[] = [];
  const part: string[] = [];
  const material: string[] = [];
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const f of mesh.faces()) {
    const id = tags.find(([, k]) => mesh.hasTag(f, k))?.[0] ?? '';
    const slot = mesh.materialNames[mesh.fMaterial[f] as number] as string;
    const vs = mesh.faceVertices(f);
    const base = positions.length / 3;
    for (const v of vs) {
      const p = mesh.position(v);
      positions.push(p[0], p[1], p[2]);
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c] as number, p[c] as number);
        max[c] = Math.max(max[c] as number, p[c] as number);
      }
    }
    for (let k = 1; k + 1 < vs.length; k++) {
      indices.push(base, base + k, base + k + 1);
      part.push(id);
      material.push(slot);
    }
  }
  const normalY = new Float64Array(indices.length / 3);
  for (let t = 0; t < normalY.length; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => (indices[t * 3 + k] as number) * 3);
    const e = (i: number, j: number, k: number) => (positions[(i as number) + k] as number) - (positions[(j as number) + k] as number);
    const u = [0, 1, 2].map((k) => e(b as number, a as number, k));
    const v = [0, 1, 2].map((k) => e(c as number, a as number, k));
    const n = [(u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number), (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number), (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number)];
    normalY[t] = (n[1] as number) / (Math.hypot(...n) || 1);
  }
  return { bvh: new TriangleBvh(positions, indices), part, material, normalY, box: { min, max } };
}

/** Deterministic low-discrepancy value in [0, 1) (radical inverse in `base`). */
function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let n = i + 1; n > 0; n = Math.floor(n / base)) {
    f /= base;
    r += f * (n % base);
  }
  return r;
}

export interface ClosureFailure {
  /** Where the ray entered: an opening, or `body` (a shut line, a gap or a hole in the skin). */
  readonly via: Opening | 'body';
  /** What it reached: a part id, or `background` when it passed through the body. */
  readonly reached: string;
  readonly at: Tuple3;
  /** The ray direction (a close-up looks along it). */
  readonly dir: Tuple3;
  /** Where the ray passed closest to the skin before it got in, and that skin part (the leak). */
  readonly entry: { readonly at: Tuple3; readonly part: string; readonly distance: number };
}

export interface ClosureReport {
  readonly rays: number;
  /** Rays that met the car. */
  readonly hits: number;
  readonly skin: number;
  /** Rays through each opening that landed on its designed surfaces. */
  readonly openings: Readonly<Record<string, number>>;
  /** Failures counted by `via / reached`. */
  readonly failures: Readonly<Record<string, number>>;
  /** Body leaks counted by the skin part they passed (the seam or hole to close). */
  readonly leaks: Readonly<Record<string, number>>;
  /** Up to 50 failing rays, for locating them. */
  readonly samples: readonly ClosureFailure[];
}

const openingOf = (material: string): Opening | undefined => (Object.keys(OPENINGS) as Opening[]).find((o) => (OPENINGS[o].materials as readonly string[]).includes(material));

/**
 * Cast `rays` rays from a sphere around the car toward low-discrepancy points of its box and
 * classify what each one shows (see the module comment).
 */
export function closureRays(m: Model, rays = 20000): ClosureReport {
  const index = indexOf(m);
  const isSkin = (t: number) => roleOf(index.part[t] as string) === 'skin';
  /** Walk back from `at` along -d: the point closest to the skin, where the ray got in. */
  const entryOf = (at: Tuple3, d: Tuple3) => {
    let best = { at, part: '', distance: Infinity };
    for (let s = 0.002; s < 2 * radius; s += 0.003) {
      const q = at.map((v, c) => v - (d[c] as number) * s) as Tuple3;
      const near = index.bvh.nearest(q, isSkin);
      if (near === undefined) break;
      const dist = Math.sqrt(near.distanceSquared);
      if (dist < best.distance) best = { at: q, part: index.part[near.triangle] as string, distance: dist };
    }
    return best;
  };
  const { min, max } = index.box;
  const center = [0, 1, 2].map((c) => ((min[c] as number) + (max[c] as number)) / 2) as Tuple3;
  const radius = Math.hypot(...[0, 1, 2].map((c) => (max[c] as number) - (min[c] as number))) * 0.75;
  const openings: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const leaks: Record<string, number> = {};
  const samples: ClosureFailure[] = [];
  let hits = 0;
  let skin = 0;
  const fail = (via: Opening | 'body', reached: string, at: Tuple3, d: Tuple3) => {
    const key = `${via} / ${reached}`;
    failures[key] = (failures[key] ?? 0) + 1;
    const entry = entryOf(at, d);
    if (via === 'body') leaks[entry.part] = (leaks[entry.part] ?? 0) + 1;
    if (samples.length < 50) samples.push({ via, reached, at, dir: d, entry });
  };
  for (let i = 0; i < rays; i++) {
    // Origin: a Fibonacci point on the sphere; target: a Halton point in the box.
    // The car stands on the ground (y = 0): origins span the part of the sphere above it.
    const lowest = Math.max(-1, -center[1] / radius);
    const y = 1 - ((1 - lowest) * (i + 0.5)) / rays;
    const ring = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const o: Tuple3 = [center[0] + radius * ring * Math.cos(phi), center[1] + radius * y, center[2] + radius * ring * Math.sin(phi)];
    const target = [halton(i, 2), halton(i, 3), halton(i, 5)].map((h, c) => (min[c] as number) + h * ((max[c] as number) - (min[c] as number)));
    const d0 = target.map((t, c) => t - (o[c] as number));
    const l = Math.hypot(...d0);
    const d = d0.map((v) => v / l) as Tuple3;
    let from = o;
    let via: Opening | undefined;
    let passed = 0;
    for (let step = 0; step < 16; step++) {
      const hit = index.bvh.raycast(from, d, 4 * radius);
      if (hit === undefined) {
        if (step === 0) break;
        // Out the far side: only an opening that lets a ray leave (glass) may show the background.
        if (via === undefined || !OPENINGS[via].exit || passed < 2) fail(via ?? 'body', 'background', from, d);
        else openings[via] = (openings[via] ?? 0) + 1;
        break;
      }
      if (step === 0) hits++;
      const at = from.map((v, c) => v + (d[c] as number) * hit.t) as Tuple3;
      const part = index.part[hit.triangle] as string;
      const opening = openingOf(index.material[hit.triangle] as string);
      if (opening !== undefined) {
        // Pass the opening's surface and keep going.
        via ??= opening;
        passed++;
        from = at.map((v, c) => v + (d[c] as number) * 1e-5) as Tuple3;
        continue;
      }
      const below = (index.normalY[hit.triangle] as number) <= UNDERBODY.normalY && (at[1] as number) < UNDERBODY.y;
      const role = below ? 'skin' : roleOf(part);
      if (via === undefined) {
        if (role === 'skin') skin++;
        else fail('body', part || '(untagged)', at, d);
      } else if ((OPENINGS[via].behind as readonly Role[]).includes(role)) openings[via] = (openings[via] ?? 0) + 1;
      else fail(via, part || '(untagged)', at, d);
      break;
    }
  }
  return { rays, hits, skin, openings, failures, leaks, samples };
}

// ---- seams -----------------------------------------------------------------------------

/** Designed shut line: gap between the two panels' outer edges and their flush offset (meters). */
/** Gap band and flush limit (meters); a line passes with at most `lineTolerance` of its stations outside them (line ends, where three panels meet). */
export const SEAM = { gap: [0.003, 0.004], flush: 0.001, step: 0.01, reach: 0.012, lineTolerance: 0.1 } as const;

export interface SeamLine {
  /** The two parts, sorted. */
  readonly pair: readonly [string, string];
  /** Stations sampled (every SEAM.step along both panels' edges). */
  readonly samples: number;
  /** Gap percentiles (p10, median, p90) and spread p90 - p10: line ends, where three panels meet, make the extremes noisy. */
  readonly gap: { readonly p10: number; readonly median: number; readonly p90: number; readonly spread: number };
  readonly flush: { readonly median: number; readonly p90: number };
  /** Share of stations outside the gap band or over the flush limit. */
  readonly failing: number;
  /** The worst station: largest deviation from the gap band or flush limit. */
  readonly worst: { readonly at: Tuple3; readonly normal: Tuple3; readonly gap: number; readonly flush: number; readonly score: number };
}

interface EdgeSample {
  readonly part: string;
  readonly p: Tuple3;
  readonly n: Tuple3;
}

/**
 * Measure every shut line of a car-form model built from closed shelled panels (outer skin,
 * `wall` rim and inner faces, as the S6 groups build them): each panel's outer edge (where its
 * outer skin or edge chamfer meets the shell rim) is sampled every centimeter; a station whose
 * closest point on another part's outer edge lies within SEAM.reach forms the line between
 * the two parts. The gap is that offset across the line (the components along the line and
 * along the skin normal removed); flush is a straight-edge gauge: each skin fitted 2–8 mm
 * back from its edge and extrapolated to the line centre (creases crossing the line don't
 * count as steps).
 */
export function seams(m: Model): readonly SeamLine[] {
  const mesh = m.editMesh;
  const tags = mesh.tagNames.filter((t) => t.startsWith('part:')).map((t) => [t.slice(5), mesh.tagIndex(t, false)] as const);
  const partOf = (f: number) => tags.find(([, k]) => mesh.hasTag(f, k))?.[0] ?? '';
  const resolve = (s: ReturnType<typeof sel.createdBy>) => {
    const r = s.resolve(mesh);
    return new Set(r.ok ? r.value : []);
  };
  const rim = resolve(sel.createdBy('wall', 'rim'));
  const inner = resolve(sel.createdBy('wall', 'inner'));
  const rounds = new Set<number>();
  for (const { label } of m.inspect().labels) if (label.startsWith('round-')) for (const f of resolve(sel.createdBy(label))) rounds.add(f);
  const normalOf = (f: number): Tuple3 => {
    const vs = mesh.faceVertices(f).map((v) => mesh.position(v));
    const n: Tuple3 = [0, 0, 0];
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i] as Tuple3;
      const b = vs[(i + 1) % vs.length] as Tuple3;
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  // Seal flanges under the shut lines belong to their panel but lie below its skin.
  const seals = new Set<number>();
  if (mesh.tagNames.includes('seal')) for (const f of resolve(sel.tag('seal') as unknown as ReturnType<typeof sel.createdBy>)) seals.add(f);
  // The outer skins (no rim, inner wall, edge chamfer or seal flange), for the flush gauge.
  const positions: number[] = [];
  const indices: number[] = [];
  const triPart: string[] = [];
  for (const f of mesh.faces()) {
    if (rim.has(f) || inner.has(f) || rounds.has(f) || seals.has(f)) continue;
    const part = partOf(f);
    if (part === '') continue;
    const vs = mesh.faceVertices(f);
    const base = positions.length / 3;
    for (const v of vs) positions.push(...mesh.position(v));
    for (let k = 1; k + 1 < vs.length; k++) {
      indices.push(base, base + k, base + k + 1);
      triPart.push(part);
    }
  }
  const skin = new TriangleBvh(positions, indices);
  const onSkin = (x: Tuple3, part: string): Tuple3 | undefined => {
    const hit = skin.nearest(x, (t) => triPart[t] === part);
    if (hit === undefined || hit.distanceSquared > 0.004 * 0.004) return undefined;
    const [a, b, c] = [0, 1, 2].map((k) => (indices[hit.triangle * 3 + k] as number) * 3);
    return [0, 1, 2].map((d) => (positions[(a as number) + d] as number) * (1 - hit.u - hit.v) + (positions[(b as number) + d] as number) * hit.u + (positions[(c as number) + d] as number) * hit.v) as Tuple3;
  };
  /**
   * The skin point of `part` under `x` in the section plane: a ray along -n from 5 mm above
   * `x`. A nearest-point projection slides along a steep crease out of the section and reads
   * the crease as a step.
   */
  const inSection = (x: Tuple3, n: Tuple3, part: string): Tuple3 | undefined => {
    const o: Tuple3 = [x[0] + n[0] * 0.005, x[1] + n[1] * 0.005, x[2] + n[2] * 0.005];
    const hit = skin.raycast(o, [-n[0], -n[1], -n[2]], 0.01, false, (t) => triPart[t] === part);
    if (hit === undefined) return onSkin(x, part);
    return [o[0] - n[0] * hit.t, o[1] - n[1] * hit.t, o[2] - n[2] * hit.t];
  };
  // Outer edges: one side an outer face (skin or chamfer), the other a rim face.
  const segments: { readonly part: string; readonly a: Tuple3; readonly b: Tuple3 }[] = [];
  const samples: (EdgeSample & { readonly t: Tuple3 })[] = [];
  for (const e of mesh.edges()) {
    const fa = mesh.hFace[e * 2] as number;
    const fb = mesh.hFace[e * 2 + 1] as number;
    if (fa < 0 || fb < 0) continue;
    const outer = rim.has(fa) && !rim.has(fb) && !inner.has(fb) ? fb : rim.has(fb) && !rim.has(fa) && !inner.has(fa) ? fa : -1;
    if (outer < 0) continue;
    const part = partOf(outer);
    if (part === '') continue;
    const [va, vb] = mesh.edgeVertices(e);
    const a = mesh.position(va) as Tuple3;
    const b = mesh.position(vb) as Tuple3;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 1e-6) continue;
    segments.push({ part, a, b });
    // The skin normal: the outer face's normal without its component along the rim's (an
    // edge chamfer leans halfway between the two; the skin itself is square to the rim).
    const c = normalOf(outer);
    const rn = normalOf(outer === fa ? fb : fa);
    const k = c[0] * rn[0] + c[1] * rn[1] + c[2] * rn[2];
    const s0: Tuple3 = [c[0] - k * rn[0], c[1] - k * rn[1], c[2] - k * rn[2]];
    const sl = Math.hypot(...s0) || 1;
    const n: Tuple3 = [s0[0] / sl, s0[1] / sl, s0[2] / sl];
    const t: Tuple3 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
    for (let k = 0, steps = Math.max(1, Math.round(len / SEAM.step)); k < steps; k++) {
      const u = (k + 0.5) / steps;
      samples.push({ part, p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], n, t });
    }
  }
  // Segments hashed into every cell their padded box overlaps.
  const cell = SEAM.reach;
  const grid = new Map<string, number[]>();
  for (const [i, sg] of segments.entries()) {
    const lo = [0, 1, 2].map((c) => Math.floor((Math.min(sg.a[c] as number, sg.b[c] as number) - cell) / cell));
    const hi = [0, 1, 2].map((c) => Math.floor((Math.max(sg.a[c] as number, sg.b[c] as number) + cell) / cell));
    for (let x = lo[0] as number; x <= (hi[0] as number); x++)
      for (let y = lo[1] as number; y <= (hi[1] as number); y++)
        for (let z = lo[2] as number; z <= (hi[2] as number); z++) {
          const k = `${x},${y},${z}`;
          const list = grid.get(k);
          if (list === undefined) grid.set(k, [i]);
          else list.push(i);
        }
  }
  const closest = (p: Tuple3, a: Tuple3, b: Tuple3): Tuple3 => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = (ab[0] as number) ** 2 + (ab[1] as number) ** 2 + (ab[2] as number) ** 2;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * (ab[0] as number) + (p[1] - a[1]) * (ab[1] as number) + (p[2] - a[2]) * (ab[2] as number)) / l2));
    return [a[0] + (ab[0] as number) * u, a[1] + (ab[1] as number) * u, a[2] + (ab[2] as number) * u];
  };
  const dot = (a: readonly number[], b: readonly number[]) => (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
  /**
   * Straight-edge flush gauge: in the section across the line, each skin is fitted (least
   * squares) through points 2–8 mm back from its edge and extrapolated to the line centre;
   * flush is the height difference there. Null when a skin can't be sampled.
   */
  const gauge = (s: EdgeSample, other: string, q: Tuple3, across: Tuple3): number | undefined => {
    const center = dot([q[0] - s.p[0], q[1] - s.p[1], q[2] - s.p[2]], across) / 2;
    const fit = (part: string, from: Tuple3, sign: 1 | -1): number | undefined => {
      const us: number[] = [];
      const hs: number[] = [];
      for (const back of [0.002, 0.004, 0.006, 0.008]) {
        const x = inSection([from[0] + sign * across[0] * back, from[1] + sign * across[1] * back, from[2] + sign * across[2] * back], s.n, part);
        if (x === undefined) continue;
        const d = [x[0] - s.p[0], x[1] - s.p[1], x[2] - s.p[2]];
        us.push(dot(d, across));
        hs.push(dot(d, s.n));
      }
      if (us.length < 2) return undefined;
      const mu = us.reduce((a, b) => a + b, 0) / us.length;
      const mh = hs.reduce((a, b) => a + b, 0) / hs.length;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < us.length; i++) {
        sxy += ((us[i] as number) - mu) * ((hs[i] as number) - mh);
        sxx += ((us[i] as number) - mu) ** 2;
      }
      const slope = sxx > 1e-12 ? sxy / sxx : 0;
      return mh + slope * (center - mu);
    };
    const ha = fit(s.part, s.p, -1);
    const hb = fit(other, q, 1);
    return ha === undefined || hb === undefined ? undefined : Math.abs(ha - hb);
  };
  const lines = new Map<string, { pair: [string, string]; gaps: number[]; flush: number[]; worst: SeamLine['worst'] }>();
  for (const s of samples) {
    let best: { q: Tuple3; part: string } | undefined;
    let bestD: number = SEAM.reach;
    for (const i of grid.get([0, 1, 2].map((c) => Math.floor((s.p[c] as number) / cell)).join(',')) ?? []) {
      const sg = segments[i] as (typeof segments)[number];
      if (sg.part === s.part) continue;
      const q = closest(s.p, sg.a, sg.b);
      const d = Math.hypot(q[0] - s.p[0], q[1] - s.p[1], q[2] - s.p[2]);
      if (d < bestD) [best, bestD] = [{ q, part: sg.part }, d];
    }
    if (best === undefined) continue;
    const d: Tuple3 = [best.q[0] - s.p[0], best.q[1] - s.p[1], best.q[2] - s.p[2]];
    // Gap: across the line, in the skin's tangent plane (neither along the line nor the normal).
    const dn = dot(d, s.n);
    const dt = dot(d, s.t);
    const g: Tuple3 = [d[0] - dn * s.n[0] - dt * s.t[0], d[1] - dn * s.n[1] - dt * s.t[1], d[2] - dn * s.n[2] - dt * s.t[2]];
    const gap = Math.hypot(...g);
    const across: Tuple3 = gap > 1e-9 ? [g[0] / gap, g[1] / gap, g[2] / gap] : s.n;
    const flush = gauge(s, best.part, best.q, across) ?? Math.abs(dn);
    const pair = [s.part, best.part].sort() as [string, string];
    const k = pair.join(' | ');
    const score = Math.max(SEAM.gap[0] - gap, gap - SEAM.gap[1], flush - SEAM.flush, 0);
    const line = lines.get(k) ?? { pair, gaps: [], flush: [], worst: { at: s.p, normal: s.n, gap, flush, score: -1 } };
    line.gaps.push(gap);
    line.flush.push(flush);
    if (score > line.worst.score) line.worst = { at: s.p, normal: s.n, gap, flush, score };
    lines.set(k, line);
  }
  return [...lines.values()]
    .filter((l) => l.gaps.length >= 3)
    .map((l): SeamLine => {
      const pct = (v: number[], q: number) => {
        const s = [...v].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
      };
      const [g10, g90] = [pct(l.gaps, 0.1), pct(l.gaps, 0.9)];
      const failing = l.gaps.filter((g, i) => g < SEAM.gap[0] || g > SEAM.gap[1] || (l.flush[i] as number) > SEAM.flush).length / l.gaps.length;
      return { pair: l.pair, samples: l.gaps.length, gap: { p10: g10, median: pct(l.gaps, 0.5), p90: g90, spread: g90 - g10 }, flush: { median: pct(l.flush, 0.5), p90: pct(l.flush, 0.9) }, failing, worst: l.worst };
    })
    .sort((a, b) => b.failing - a.failing || b.gap.spread - a.gap.spread);
}
