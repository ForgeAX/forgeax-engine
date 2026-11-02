import {
  checkSurfaceQuality,
  type Model,
  model,
  type NurbsSurface,
  nurbs,
  rig,
  sel,
  splitAlong,
  type SurfacePatch,
  type Tuple3,
} from '@forgeax/engine-modeling';
import { resolveBlends, type SurfaceBlend, type SurfaceCorner } from '../../src/blend';
import { JOINTS } from '../../src/__tests__/weld-joints';
import type { SessionFactory } from '../case/record';

/**
 * Case C-131 (W-K26): a stress case assembled from real F1 failures. A grid of welded pipe joints
 * (weld rolling-ball inputs, including the joints the kernel still refuses), a mounting kit
 * (S4 interference pairs), a split and hemmed cover panel (B15 A3 shut line) and a three-blend
 * setback corner block. x runs along the joint rows, y up.
 */
export const C131 = {
  run: 0.1,
  arm: 0.5,
  weld: 0.03,
  ringSegments: 16,
  filletSegments: 4,
  columns: 4,
  pitch: [1.3, 1.3],
  panelGap: 0.0035,
  panelThickness: 0.003,
  cornerSide: 0.12,
  cornerRadius: 0.012,
  cornerSetback: 0.006,
} as const;

/** Joint roster: four the rolling-ball strip produces, eight that are KNOWN_FAIL at rho 0.03 / ring 16. */
export const ROSTER = [
  { name: 'tee', expect: 'ball' },
  { name: 'lateral45', expect: 'ball' },
  { name: 'cross-unequal', expect: 'ball' },
  { name: 'tee-cope', expect: 'ball' },
  { name: 'tee-equal', expect: 'known-fail' },
  { name: 'cross-equal', expect: 'known-fail' },
  { name: 'y120', expect: 'known-fail' },
  { name: 'near172', expect: 'known-fail' },
  { name: '5way-planar', expect: 'known-fail' },
  { name: '6way-3d', expect: 'known-fail' },
  { name: 'thick-branch', expect: 'known-fail' },
  { name: 'thin-on-fat', expect: 'known-fail' },
] as const;

export interface JointRun {
  readonly name: string;
  readonly expect: 'ball' | 'known-fail';
  readonly model: Model;
  readonly weld: 'ball' | 'bevel' | 'refused';
  readonly reason?: string;
  readonly detail?: Record<string, unknown>;
  readonly watertight: boolean;
  readonly faces: number;
  readonly fallback: boolean;
  readonly ms: number;
}

function netOf(name: string, scale: number) {
  const { end, ...net } = JOINTS[name] as NonNullable<(typeof JOINTS)[string]>;
  const nodes = net.nodes.map((p) => [p[0] * scale, p[1] * scale, p[2] * scale] as Tuple3);
  return { ...net, nodes, ...(end ? { end } : {}) };
}

/** Welds one joint; a refusal falls back to the soft joint so the kit still assembles. */
export function weldJoint(name: string, expectation: 'ball' | 'known-fail'): JointRun {
  const { end, ...net } = netOf(name, C131.arm / 1);
  const start = Date.now();
  const welded = model();
  const report = welded.pipeNetwork({
    radius: C131.run,
    ...net,
    ringSegments: C131.ringSegments,
    weld: { radius: C131.weld, segments: C131.filletSegments, ...(end ? { end } : {}) },
  } as never);
  const ms = Date.now() - start;
  if (report.status === 'ok') {
    const info = report.diagnostics?.find((d) => d.detail?.path !== undefined)?.detail;
    return {
      name,
      expect: expectation,
      model: welded,
      weld: info?.path === 'ball' ? 'ball' : 'bevel',
      ...(info === undefined ? {} : { detail: { ...info } }),
      watertight: welded.validate({ watertight: true }).pass,
      faces: welded.inspect().faces,
      fallback: false,
      ms,
    };
  }
  const soft = model();
  soft.pipeNetwork({ radius: C131.run, ...net, ringSegments: 8 } as never);
  const error = report.error as { code?: string; detail?: Record<string, unknown> } | undefined;
  return {
    name,
    expect: expectation,
    model: soft,
    weld: 'refused',
    reason: `${error?.code ?? 'unknown'}:${String(error?.detail?.reason ?? '')}`,
    ...(error?.detail === undefined
      ? {}
      : {
          detail: {
            requested: error.detail.requested,
            clamped: error.detail.clamped,
            minWidth: error.detail.minWidth,
            tubeRadius: error.detail.tubeRadius,
          },
        }),
    watertight: soft.validate({ watertight: true }).pass,
    faces: soft.inspect().faces,
    fallback: true,
    ms,
  };
}

export function jointOffset(index: number): Tuple3 {
  const column = index % C131.columns;
  const row = Math.floor(index / C131.columns);
  return [column * C131.pitch[0], -row * C131.pitch[1], 0];
}

const steps = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

/** A doubly curved 0.6 x 0.5 m crown (a test panel), y up. */
function crown(): NurbsSurface {
  const rows = steps(6).map((a) =>
    steps(6).map((b): Tuple3 => {
      const x = -0.3 + 0.6 * a + 0.08 * b;
      const z = -0.25 + 0.5 * b;
      return [x, 0.12 - 0.6 * x * x - 0.5 * z * z + 0.1 * x * z, z];
    }),
  );
  return unwrap(nurbs.grid(rows));
}

function crownSplit() {
  const s = crown();
  const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(s);
  const points = steps(200).map((k): Tuple3 => {
    const p = nurbs.surfacePoint(
      s,
      u0 + (u1 - u0) * (0.3 + 0.35 * k),
      v0 + (v1 - v0) * k,
    );
    return [p[0], p[1], p[2]];
  });
  const curve = unwrap(nurbs.approximate(points, { controlPoints: 24 }));
  return unwrap(
    splitAlong({ surface: s, flip: true }, { curve }, { gap: C131.panelGap, names: ['left', 'right'] }),
  );
}

const quad = (a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface => ({
  degreeU: 1,
  degreeV: 1,
  points: [
    [a, b],
    [c, d],
  ],
  knotsU: [0, 0, 1, 1],
  knotsV: [0, 0, 1, 1],
});

const L = C131.cornerSide;
const O: Tuple3 = [0, 0, 0];
export const CORNER_FACES: SurfacePatch[] = [
  { name: 'x0', surface: quad(O, [0, L, 0], [0, 0, L], [0, L, L]) },
  { name: 'y0', surface: quad(O, [0, 0, L], [L, 0, 0], [L, 0, L]) },
  { name: 'z0', surface: quad(O, [L, 0, 0], [0, L, 0], [L, L, 0]) },
];
export const CORNER_BLENDS: SurfaceBlend[] = [
  { between: ['x0', 'y0'], radius: C131.cornerRadius, continuity: 'G2', name: 'knee' },
  { between: ['y0', 'z0'], radius: C131.cornerRadius, continuity: 'G2', name: 'edge' },
  { between: ['z0', 'x0'], radius: C131.cornerRadius, continuity: 'G2', name: 'tail' },
];
export const CORNER: SurfaceCorner = {
  blends: ['knee', 'edge', 'tail'],
  setback: C131.cornerSetback,
  continuity: 'G2',
  name: 'tip',
};

/** Where each non-joint part sits in the kit. */
export const PLACE = {
  cover: [0, 0.44, 0],
  corner: [C131.pitch[0] * 3 + 0.2, 0.3, 0.1],
  strap: [-0.3, 0, 0],
  plate: [C131.pitch[0] * 2, -0.0, 0],
} as const;

/** B15 A3: the hemmed variant of the cover, attempted in its own session because a refusal poisons it. */
export function hemAttempt() {
  const m = model();
  const halves = crownSplit();
  m.surface({ patches: [halves.a, halves.b], label: 'panels', snap: 2e-5 });
  const out: Record<string, unknown> = {};
  for (const tag of ['left', 'right']) {
    const r = m.shell(sel.tag(tag), {
      thickness: C131.panelThickness,
      flange: { reach: 0.012, depth: 0.006, radius: 0.001 },
      label: `${tag}-hem`,
    });
    out[tag] = r.status === 'ok' ? 'ok' : { code: (r.error as { code?: string })?.code, detail: (r.error as { detail?: unknown })?.detail };
    if (r.status !== 'ok') break;
  }
  return out;
}

function checked(report: { status: string; error?: unknown }): void {
  if (report.status !== 'ok') throw report.error;
}

export interface Combo {
  readonly kit: Model;
  readonly joints: JointRun[];
}

/**
 * Pipeline: weld every joint (refusals fall back to soft), build the cover panel and the corner
 * block, assemble them with two brackets into the kit. The kit, cover and corner sessions are
 * recorded; the joint attempts are not, since a refused weld leaves no journal entry.
 */
export function buildCombo(session: SessionFactory = () => model()): Combo {
  const joints = ROSTER.map((r) => weldJoint(r.name, r.expect));

  const cover = session('cover');
  const halves = crownSplit();
  checked(cover.surface({ patches: [halves.a, halves.b], label: 'panels', snap: 2e-5 }));
  for (const tag of ['left', 'right']) {
    checked(cover.shell(sel.tag(tag), { thickness: C131.panelThickness, label: `${tag}-wall` }));
  }

  const corner = session('corner');
  checked(corner.surface({ patches: CORNER_FACES, blends: CORNER_BLENDS, corners: [CORNER], chord: 0.0005 }));

  const kit = session('kit');
  checked(kit.append(cover, { translate: PLACE.cover as unknown as Tuple3 }));
  checked(kit.append(corner, { translate: PLACE.corner as unknown as Tuple3, tag: 'corner' }));
  for (const [i, joint] of joints.entries()) {
    checked(kit.append(joint.model, { translate: jointOffset(i), tag: `joint-${joint.name}` }));
  }
  checked(kit.box({ size: [0.05, 0.26, 0.26], center: [...PLACE.strap] as Tuple3, label: 'strap', tag: 'strap' }));
  checked(kit.box({ size: [0.4, 0.02, 0.3], center: [PLACE.plate[0], -0.105, 0], label: 'plate', tag: 'plate' }));
  return { kit, joints };
}

export interface KitScan {
  readonly bound: Record<string, number>;
  readonly parts: string[];
  readonly report: unknown;
}

/** S4 part interference over the kit: every joint, bracket, cover half and the corner block is a part. */
export function scanKit(target: Model, joints: readonly JointRun[]) {
  const r = rig(target, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
  const parts = [
    ...joints.map((j) => `joint-${j.name}`),
    'left',
    'right',
    'corner',
    'strap',
    'plate',
  ];
  const bound: Record<string, string> = {};
  for (const part of parts) {
    bound[part] = r.bindRigid(sel.tag(part), 'root', { part }).status;
  }
  const result = r.interference(
    {},
    {
      tolerance: 0.0005,
      contacts: [{ parts: ['joint-cross-unequal', 'plate'], kind: 'seat', tolerance: 0.008 }],
    },
  );
  return { bound, parts, result };
}

/** B16: the corner's quality report (continuity, highlight lines across the patch joints). */
export function cornerQuality() {
  const resolved = resolveBlends(CORNER_FACES, CORNER_BLENDS, [CORNER]);
  if (!resolved.ok) return { ok: false as const, error: resolved.error };
  const surfaces = resolved.value.patches.map((p) => ({
    name: p.name as string,
    surface: p.surface,
    ...(p.transition === undefined ? {} : { transition: p.transition }),
  }));
  const quality = checkSurfaceQuality(
    { surfaces },
    {
      continuity: 'G2',
      samples: 32,
      highlights: { field: 'isophote', direction: [0.5, 0.6, 0.62], step: 5 },
    },
  );
  return { ok: true as const, patches: surfaces.length, reports: resolved.value.reports, quality };
}

/** B15: the cover's shut line between the two hemmed halves. */
export function coverShutLine(target: Model) {
  return target.shutLines({
    table: [{ id: 'cover-split', parts: ['left', 'right'], zone: 'A' }],
  });
}
