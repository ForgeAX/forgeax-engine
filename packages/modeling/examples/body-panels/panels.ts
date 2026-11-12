import {
  type Model,
  model,
  type NurbsCurve,
  type NurbsSurface,
  nurbs,
  type Point2,
  proceduralMaterials,
  region2d,
  type Region2,
  type StandardMaterialOptions,
  type SurfacePatch,
  sel,
  type TextureSink,
  textRegion,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { OUTLINES, SPLITS, WHEELS } from './draft-body.ts';

/**
 * Case C-106 (C-100 S3/S6 part, code name mech-gt): the hood and both front fenders as
 * NURBS panels fit to the S2 body contours (meters, Y up, nose +Z, x > 0 left):
 * - the hood centerline follows the S2 side profile, the fender outer line its plan
 *   outline; sections are interpolated, lofted across stations and tessellated;
 * - each panel is one `surface` call whose patches join watertight (hood halves at the
 *   centerline, fender front and rear at the cowl section); the panels keep a 4 mm shut
 *   line between them;
 * - the fenders are trimmed for the wheel arches by side-view circles, the hood for two
 *   vents (offset slots in its domain), and a carbon strip, a badge text and a decal
 *   area are imprinted as their own material slots;
 * - `shell` gives every panel a 4 mm wall, so validation sees closed parts.
 */

const { side: SIDE, plan: PLAN } = OUTLINES;

/** Largest `v` where the closed outline crosses the vertical line `u`. */
function topAt(outline: readonly Point2[], u: number): number {
  let best = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] as Point2;
    const b = outline[(i + 1) % outline.length] as Point2;
    if ((a[0] - u) * (b[0] - u) > 0 || a[0] === b[0]) continue;
    const t = (u - a[0]) / (b[0] - a[0]);
    best = Math.max(best, a[1] + t * (b[1] - a[1]));
  }
  return best;
}

/** S2 silhouette height on the centerline (side view u = -z). */
export const profileY = (z: number) => topAt(SIDE, -z);
/** S2 plan half-width (top view u = x, v = -z). */
export const planHalf = (z: number) => {
  let best = 0;
  for (let i = 0; i < PLAN.length; i++) {
    const a = PLAN[i] as Point2;
    const b = PLAN[(i + 1) % PLAN.length] as Point2;
    if ((a[1] + z) * (b[1] + z) > 0 || a[1] === b[1]) continue;
    const t = (-z - a[1]) / (b[1] - a[1]);
    best = Math.max(best, a[0] + t * (b[0] - a[0]));
  }
  return best;
};

export const PANELS = {
  front: SPLITS.bumper,
  cowl: SPLITS.cowl,
  rear: SPLITS.doorFront,
  /** Hood crown drop from the centerline to the hood edge. */
  crown: 0.045,
  /** Hood edge half-width cap. */
  hoodHalf: 0.6,
  shut: 0.004,
  wall: 0.003,
  archGap: 0.035,
} as const;

const FRONT_WHEEL = WHEELS.find((w) => w.name === 'fl') as (typeof WHEELS)[number];

/** Front stations of the hood and fender front patches, front to rear. */
const STATIONS = Array.from({ length: 7 }, (_, k) => PANELS.front + ((PANELS.cowl - PANELS.front) * k) / 6);
/** Stations of the fender rear patch, from the cowl to the door line. */
const REAR_STATIONS = [PANELS.cowl, (PANELS.cowl + PANELS.rear) / 2, PANELS.rear];
const across = (zs: readonly number[]) => zs.map((z) => (zs[0] as number - z) / ((zs[0] as number) - (zs[zs.length - 1] as number)));
/** Shared section parameters: every section interpolates with the same knots. */
const SECTION_PARAMS = [0, 0.16, 0.33, 0.5, 0.66, 0.83, 1];

const hoodHalf = (z: number) => Math.min(PANELS.hoodHalf, planHalf(z) - 0.3);
const centerY = (z: number) => profileY(Math.max(z, PANELS.cowl));
const edgeY = (z: number) => centerY(z) - PANELS.crown;
/** Fender crest rise over the hood edge, highest over the front wheel. */
const rise = (z: number) => {
  const d = Math.min(1, Math.abs(z - FRONT_WHEEL.z) / 0.9);
  return 0.05 + 0.1 * (0.5 + 0.5 * Math.cos(Math.PI * d));
};

function curve(points: readonly Tuple3[], parameters?: readonly number[]): NurbsCurve {
  const c = nurbs.interpolate(points, parameters === undefined ? {} : { parameters });
  if (!c.ok) throw c.error;
  return c.value;
}

function loft(sections: readonly NurbsCurve[], zs: readonly number[]): NurbsSurface {
  const s = nurbs.loft(sections, { parameters: across(zs) });
  if (!s.ok) throw s.error;
  return s.value;
}

/** Hood half section: centerline to edge on the side `sign` (+1 left), x increasing. */
function hoodSection(z: number, sign: 1 | -1): NurbsCurve {
  const half = hoodHalf(z) - PANELS.shut;
  const points = [0, 0.25, 0.5, 0.75, 1].map((f): Tuple3 => [sign * half * f, centerY(z) - PANELS.crown * f * f, z]);
  return curve(sign > 0 ? points : points.reverse(), [0, 0.25, 0.5, 0.75, 1]);
}

/** Fender section from the hood edge over the crest and down the flank to the sill. */
function fenderSection(z: number, sign: 1 | -1): NurbsCurve {
  const inner = hoodHalf(Math.max(z, PANELS.cowl));
  const outer = planHalf(z);
  const y = edgeY(Math.max(z, PANELS.cowl));
  const r = rise(z);
  const shoulder = y + 0.8 * r;
  const sill = 0.3;
  const raw: [number, number][] = [
    [inner, y],
    [inner + 0.45 * (outer - inner), y + r],
    [outer - 0.05, y + 0.95 * r],
    [outer - 0.005, shoulder],
    [outer, shoulder - 0.4 * (shoulder - sill)],
    [outer - 0.01, shoulder - 0.78 * (shoulder - sill)],
    [outer - 0.035, sill],
  ];
  return curve(
    raw.map(([x, yy]): Tuple3 => [sign * x, yy, z]),
    SECTION_PARAMS,
  );
}

function circle(cx: number, cy: number, r: number, n = 72): Point2[] {
  return Array.from({ length: n }, (_, k): Point2 => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
}

/** Text placed on a fender side: meters on the panel to its normalized domain, read from outside. */
function sideText(
  text: string,
  sign: 1 | -1,
  at: Point2,
  height: number,
  lengths: Point2,
): Region2 {
  const t = textRegion(text, { height, weight: 0.16, align: 'center' });
  if (!t.ok) throw t.error;
  const centered = region2d.transform(t.value.region, { translate: [0, -height / 2] });
  return region2d.transform(centered, {
    scale: [sign / lengths[1], 1 / lengths[0]],
    rotate: 90,
    translate: at,
  });
}

/** Mean section length and station span of a fender patch, in meters. */
function fenderLengths(z0: number, z1: number, sign: 1 | -1): Point2 {
  const sec = fenderSection((z0 + z1) / 2, sign);
  let length = 0;
  let prev = nurbs.point(sec, 0);
  for (let k = 1; k <= 64; k++) {
    const p = nurbs.point(sec, k / 64);
    length += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
  }
  return [length, Math.abs(z1 - z0)];
}

export const SURFACE_TOLERANCE = { chord: 0.0015, angle: 12 } as const;

export function hoodPatches(): SurfacePatch[] {
  const left = loft(STATIONS.map((z) => hoodSection(z, 1)), STATIONS);
  const right = loft(STATIONS.map((z) => hoodSection(z, -1)), STATIONS);
  const slot = (s0: number, s1: number, t: number) => {
    const line: Point2[][] = [[[s0, t], [s1, t]]];
    const r = region2d.stroke(line, 0.022, { cap: 'round' });
    if (!r.ok) throw r.error;
    return r.value.region;
  };
  const vents = (mirror: boolean): Region2 => {
    const m = (s: number) => (mirror ? 1 - s : s);
    return [...slot(m(0.42), m(0.78), 0.74), ...slot(m(0.42), m(0.78), 0.84)];
  };
  const strip = (mirror: boolean): Region2 => [
    {
      outer: mirror
        ? [
            [0.84, 0.04],
            [1, 0.04],
            [1, 0.97],
            [0.84, 0.97],
          ]
        : [
            [0, 0.04],
            [0.16, 0.04],
            [0.16, 0.97],
            [0, 0.97],
          ],
    },
  ];
  return [
    {
      surface: left,
      name: 'hood-l',
      trims: [{ uv: vents(false) }],
      imprints: [{ region: { uv: strip(false) }, role: 'carbon', tag: 'carbon', material: 'carbon' }],
    },
    {
      surface: right,
      name: 'hood-r',
      trims: [{ uv: vents(true) }],
      imprints: [{ region: { uv: strip(true) }, role: 'carbon', tag: 'carbon', material: 'carbon' }],
    },
  ];
}

export function fenderPatches(sign: 1 | -1, archGap: number = PANELS.archGap): SurfacePatch[] {
  const side = sign > 0 ? 'l' : 'r';
  const front = loft(STATIONS.map((z) => fenderSection(z, sign)), STATIONS);
  const rear = loft(REAR_STATIONS.map((z) => fenderSection(z, sign)), REAR_STATIONS);
  const view = sign > 0 ? 'right' : 'left';
  const u = (z: number) => (sign > 0 ? -z : z);
  const arch = circle(u(FRONT_WHEEL.z), FRONT_WHEEL.d / 2, FRONT_WHEEL.d / 2 + archGap);
  const frontLengths = fenderLengths(PANELS.front, PANELS.cowl, sign);
  return [
    {
      surface: front,
      name: `fender-${side}-front`,
      trims: [{ view, region: arch }],
      imprints: [
        {
          region: { uv: sideText('GT', sign, [0.66, 0.13], 0.1, frontLengths) },
          role: 'badge',
          tag: 'badge',
          material: 'badge',
        },
      ],
      flip: sign < 0,
    },
    { surface: rear, name: `fender-${side}-rear`, flip: sign < 0 },
  ];
}

export function buildPanels(session: SessionFactory = () => model()): Model {
  const m = session('panels');
  m.surface({ patches: hoodPatches(), ...SURFACE_TOLERANCE, label: 'hood', material: 'paint' });
  m.surface({ patches: fenderPatches(1), ...SURFACE_TOLERANCE, label: 'fender-l', material: 'paint' });
  m.surface({ patches: fenderPatches(-1), ...SURFACE_TOLERANCE, label: 'fender-r', material: 'paint' });
  m.assign(sel.tag('fender-l-rear'), 'number-l');
  m.assign(sel.tag('fender-r-rear'), 'number-r');
  m.checkpoint('surfaces');
  m.shell(sel.all(), { thickness: PANELS.wall, label: 'wall' });
  m.assign(sel.createdBy('wall', 'rim').or(sel.createdBy('wall', 'inner')), 'underside');
  m.uv.project({ mode: 'box', scale: 1, faces: sel.createdBy('wall', 'rim') });
  m.uv.project({ mode: 'box', scale: 1, faces: sel.createdBy('wall', 'rim'), channel: 'uv1' });
  return m;
}

/** Number decal sheet over the fender rear decal area (its normalized domain). */
function numberSheet(sign: 1 | -1, paint: readonly [number, number, number]) {
  const lengths = fenderLengths(PANELS.cowl, PANELS.rear, sign);
  const number = sideText('06', sign, [0.6, 0.5], 0.16, lengths);
  const roundel = region2d.transform(circle(0, 0, 0.15, 96), {
    scale: [sign / lengths[1], 1 / lengths[0]],
    rotate: 90,
    translate: [0.6, 0.5],
  });
  const stripe: Region2 = [
    {
      outer: [
        [0.3, 0],
        [0.34, 0],
        [0.34, 1],
        [0.3, 1],
      ],
    },
  ];
  return {
    width: 512,
    height: 512,
    background: [paint[0], paint[1], paint[2], 1] as const,
    layers: [
      { region: stripe, color: [0.9, 0.9, 0.88, 1] as const },
      { region: roundel, color: [0.92, 0.92, 0.9, 1] as const },
      { region: number, color: [0.02, 0.02, 0.02, 1] as const },
    ],
  };
}

/** Linear paint color (a deep red). */
export const PAINT: readonly [number, number, number] = [0.32, 0.012, 0.016];

/**
 * The procedural materials of the panel set, by material slot. `mips: false` drops the
 * packed mip chains (the case renders on lavapipe, which samples the coarsest level
 * along triangle edges; finding on lavapipe).
 */
export function panelMaterials(
  options: { readonly mips?: boolean } = {},
): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const placement = options.mips === false ? { mips: false } : {};
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
    if (!r.ok) throw r.error;
    return r.value;
  };
  const paint = (texture: TextureSink) =>
    unwrap(proceduralMaterials.carPaint({ color: PAINT, texture, placement }));
  const number = (sign: 1 | -1) => (texture: TextureSink) =>
    unwrap(
      proceduralMaterials.decal(paint(texture), {
        texture,
        key: `number-${sign > 0 ? 'l' : 'r'}`,
        ...numberSheet(sign, PAINT),
        ...(options.mips === false ? { mips: false } : {}),
      }),
    );
  return {
    paint,
    carbon: (texture) => unwrap(proceduralMaterials.carbonFiber({ texture, placement })),
    badge: () => unwrap(proceduralMaterials.metal({ finish: 'chrome' })),
    'number-l': number(1),
    'number-r': number(-1),
    underside: () => ({ baseColor: [0.03, 0.03, 0.035, 1], metallic: 0, roughness: 0.8 }),
  };
}
