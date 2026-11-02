import { type ArapOptions, type BendOptions, type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { MECH } from '../mech-gt/proportions.ts';

/**
 * Case C-016 (C-100 part, code name mech-gt): the left forearm guard of the mech, fitted
 * to a posed arm by ARAP. A tapered C-shaped shell (open on the body side) carries a
 * raised plate. Its elbow cuff follows the upper arm and its wrist cuff follows the hand:
 * two ARAP handles turn them rigidly about the elbow-l and wrist-l pivots while a band
 * over the forearm bone stays pinned, and the transitions bend as rigidly as possible.
 * smooth.implicit then fairs the wrist panel that carries the plate. A second session fits the same blank with the
 * plain bend deformer for comparison.
 * Built in the forearm frame (elbow-l pivot at the origin, wrist-l on -y), then placed on
 * the mech's elbow. Straight-line code: tools map every journal entry back to its source line.
 */
export interface ForearmParameters {
  /** Elbow flex the elbow cuff follows (degrees about x). */
  readonly elbow: number;
  /** Wrist flex the wrist cuff follows (degrees about x). */
  readonly wrist: number;
  /** Wall thickness of the guard (meters). */
  readonly wall: number;
}

export const FOREARM_DEFAULTS: ForearmParameters = { elbow: 30, wrist: 35, wall: 0.016 };

function joint(name: string): readonly [number, number, number] {
  const p = MECH.joints.find((j) => j.name === name)?.position ?? [0, 0, 0];
  return [p[0] as number, p[1] as number, p[2] as number];
}

export const ELBOW = joint('elbow-l');
/** The wrist-l pivot in the forearm frame: one forearm length below the elbow. */
export const WRIST_Y = -Math.round(Math.hypot(...joint('wrist-l').map((c, k) => c - (ELBOW[k] as number))) * 1000) / 1000;

/** Rows of the guard: the elbow cuff above the elbow pivot, the wrist cuff below the wrist pivot, the pinned band over the bone. */
export const ZONES = {
  elbowCuff: [-0.005, 1] as const,
  wristCuff: [-2, WRIST_Y] as const,
  pinned: [-0.43, -0.35] as const,
  /** The wrist panel between the pinned band and the wrist cuff, carrying the plate. */
  wristPanel: [WRIST_Y - 0.02, -0.41] as const,
};

const inRows = (y: readonly [number, number]) => sel.inBox([-1, y[0], -1], [1, y[1], 1]);

/** The ARAP fit: cuffs turn rigidly about the joint pivots, the bone band stays, the rest bends. */
export function arapFit(p: ForearmParameters): ArapOptions {
  return {
    handles: [
      { selector: inRows(ZONES.elbowCuff), rotate: { axis: [1, 0, 0], angle: p.elbow, origin: [0, 0, 0] } },
      { selector: inRows(ZONES.wristCuff), rotate: { axis: [1, 0, 0], angle: -p.wrist, origin: [0, WRIST_Y, 0] } },
    ],
    pin: inRows(ZONES.pinned),
    iterations: 30,
  };
}

/**
 * The bend fit over the same transitions: bend has one fixed side (below its range) and
 * no pivot, so the wrist end is bent in a frame turned 180 degrees about z.
 */
export function bendFit(p: ForearmParameters): { readonly elbow: BendOptions; readonly wrist: BendOptions } {
  return {
    elbow: { axis: 'y', toward: '+z', angle: p.elbow, range: [ZONES.pinned[1], ZONES.elbowCuff[0]] },
    wrist: { axis: 'y', toward: '+z', angle: p.wrist, range: [-ZONES.pinned[0], -ZONES.wristCuff[1]] },
  };
}

export function buildForearm(
  p: ForearmParameters = FOREARM_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  // Blank: a tapered tube from above the elbow to past the wrist, opened on the body side and shelled.
  const m = session('forearm');
  m.cylinder({ radiusTop: 0.15, radiusBottom: 0.115, height: 1.02, radialSegments: 20, heightSegments: 17, center: [0, -0.39, 0], label: 'guard', tag: 'forearm' });
  m.shell(sel.tag('forearm'), { thickness: p.wall, open: sel.createdBy('guard', 'top').or(sel.createdBy('guard', 'bottom')).or(sel.createdBy('guard', 'side').and(sel.facing('-x', 50))), label: 'wall' });

  // Raised plate over the wrist half of the outer face, its outline sharp.
  m.inset(sel.createdBy('guard', 'side').and(sel.facing('+x', 60)).and(inRows([-0.67, -0.43])), { thickness: 0.012, region: 'merged', label: 'panel' });
  m.extrude(sel.createdBy('panel', 'inner'), { distance: 0.01, region: 'merged', label: 'plate' });
  m.markSharp(sel.createdBy('plate', 'top').boundary().or(sel.createdBy('plate').boundary()));

  // Comparison session: the same blank, fitted with the plain bend deformer.
  const bent = session('bent');
  bent.append(m);

  // Fit the posed arm (arapFit): elbow and wrist cuffs are the two handles.
  m.arap(sel.all(), arapFit(p));
  // Fair the wrist panel ARAP bent; band, cuff and the plate's sharp outline stay put.
  m.smooth.implicit(inRows(ZONES.wristPanel), { lambda: 0.1, iterations: 2, pin: ['sharp', inRows(ZONES.pinned), inRows(ZONES.wristCuff)], preserveVolume: true });
  m.assign(sel.tag('forearm'), 'paint');
  m.assign(sel.createdBy('plate'), 'trim');
  m.uv.project({ mode: 'box', scale: 0.25 });
  m.translate(sel.all(), [...ELBOW]);

  // Plain bend (bendFit): bend the elbow end, flip, bend the wrist end, flip back.
  bent.bend(sel.all(), bendFit(p).elbow);
  bent.rotate(sel.all(), 'z', 180, [0, 0, 0]);
  bent.bend(sel.all(), bendFit(p).wrist);
  bent.rotate(sel.all(), 'z', 180, [0, 0, 0]);
  bent.assign(sel.tag('forearm'), 'paint');
  bent.assign(sel.createdBy('plate'), 'trim');
  bent.uv.project({ mode: 'box', scale: 0.25 });
  bent.translate(sel.all(), [...ELBOW]);
  return m;
}

/** How one fit treats the blank: edge length change and how far each cuff lands from the posed joint. */
export interface FitMetrics {
  /** Largest and mean relative edge length change over every mesh edge. */
  readonly maxEdgeStrain: number;
  readonly meanEdgeStrain: number;
  /** Largest distance of a cuff vertex from its rigid rotation about the joint pivot (meters). */
  readonly elbowCuffError: number;
  readonly wristCuffError: number;
}

/**
 * Apply both fits to copies of the blank (an FXEM snapshot of the guard before fitting)
 * and measure them on the same vertex ids.
 */
export function compareFits(blank: Uint8Array, p: ForearmParameters = FOREARM_DEFAULTS): Record<'arap' | 'bend', FitMetrics> {
  const measure = (fit: (copy: Model) => void): FitMetrics => {
    const copy = model();
    copy.append(blank);
    const mesh = copy.editMesh;
    const rest = new Map(mesh.vertices().map((v) => [v, mesh.position(v)] as const));
    fit(copy);
    if (copy.poisoned !== undefined) throw copy.poisoned;
    const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((c, k) => c - (b[k] as number)));
    let max = 0;
    let sum = 0;
    for (const e of mesh.edges()) {
      const [a, b] = mesh.edgeVertices(e);
      const l0 = distance(rest.get(a) as number[], rest.get(b) as number[]);
      const strain = Math.abs(distance(mesh.position(a), mesh.position(b)) - l0) / l0;
      max = Math.max(max, strain);
      sum += strain;
    }
    const turned = (q: readonly number[], pivot: number, degrees: number) => {
      const t = (degrees * Math.PI) / 180;
      const y = (q[1] as number) - pivot;
      const z = q[2] as number;
      return [q[0] as number, pivot + y * Math.cos(t) - z * Math.sin(t), y * Math.sin(t) + z * Math.cos(t)];
    };
    let elbow = 0;
    let wrist = 0;
    for (const [v, q] of rest) {
      if (q[1] >= ZONES.elbowCuff[0]) elbow = Math.max(elbow, distance(mesh.position(v), turned(q, 0, p.elbow)));
      if (q[1] <= ZONES.wristCuff[1]) wrist = Math.max(wrist, distance(mesh.position(v), turned(q, WRIST_Y, -p.wrist)));
    }
    return { maxEdgeStrain: max, meanEdgeStrain: sum / mesh.edges().length, elbowCuffError: elbow, wristCuffError: wrist };
  };
  return {
    arap: measure((copy) => copy.arap(sel.all(), arapFit(p))),
    bend: measure((copy) => {
      copy.bend(sel.all(), bendFit(p).elbow);
      copy.rotate(sel.all(), 'z', 180, [0, 0, 0]);
      copy.bend(sel.all(), bendFit(p).wrist);
      copy.rotate(sel.all(), 'z', 180, [0, 0, 0]);
    }),
  };
}
