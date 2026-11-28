// Exact model of the plasma blaster: units are centimetres, the weapon points along +x, z is up.
// Every feature is first tried as the exact operation it calls for; a fail-close routes to a shorter
// construction (a touching solid of the assembly) and is recorded in `steps`, never hidden.
import type { Result } from '@forgeax/engine-types';
import { booleanSolids } from '../../brep/boolean.ts';
import { box, cylinder, extrude } from '../../brep/build.ts';
import { draftedPrism } from '../../brep/draft.ts';
import { filletBox } from '../../brep/fillet-box.ts';
import { filletPrism } from '../../brep/fillet-prism.ts';
import { loft } from '../../brep/loft.ts';
import { measure } from '../../brep/measure.ts';
import { applyPattern, circularPattern, linearPattern } from '../../brep/pattern.ts';
import { revolveProfile } from '../../brep/revolve-profile.ts';
import { revolveShell } from '../../brep/shell.ts';
import { sweep } from '../../brep/sweep.ts';
import { axisRotation, transformShape } from '../../brep/transform.ts';
import type { Shape } from '../../brep/types.ts';
import { validate } from '../../brep/validate.ts';
import type { P2, P3 } from '../../brep/vec.ts';
import { cos, sin } from '../../dmath.ts';
import type { ModelingError } from '../../errors.ts';

export interface Step {
  readonly part: string;
  readonly id: string;
  readonly feature: string;
  readonly tool: string;
  readonly route: 'direct' | 'fallback';
  readonly ok: boolean;
  readonly faces?: number;
  readonly volume?: number;
  readonly valid?: boolean;
  readonly failure?: { readonly code: string; readonly reason?: string };
}

/** Closed source material set: each part carries exactly one of these slots. */
export const MATERIALS = ['BodyMetal', 'DarkHardware', 'Glass', 'Accent'] as const;
export type MaterialSlot = (typeof MATERIALS)[number];

export interface Part {
  readonly name: string;
  readonly operation: string;
  readonly shape: Shape;
  readonly material: MaterialSlot;
  readonly fallback?: string;
}

/** Source material per part: housing and receiver metal, dark hardware, glass window, colored accent. */
const PART_MATERIAL: Readonly<Record<string, MaterialSlot>> = {
  'receiver-rear': 'BodyMetal',
  'receiver-front': 'BodyMetal',
  'module-window': 'Glass',
  'module-slot': 'DarkHardware',
  barrel: 'BodyMetal',
  'fin-sleeve': 'DarkHardware',
  grip: 'DarkHardware',
  'trigger-guard': 'DarkHardware',
  trigger: 'DarkHardware',
  'cell-cover': 'Accent',
  'side-panel': 'BodyMetal',
  sight: 'Accent',
};

type Build = Result<Shape, ModelingError>;

const ID: [P3, P3, P3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const X: P3 = [1, 0, 0];

export function need(rec: Recorder, shape: Shape | undefined): Shape {
  if (shape === undefined) throw new Error(`build failed: ${JSON.stringify(rec.steps.at(-1))}`);
  return shape;
}

export function place(shape: Shape, t: P3, rot: [P3, P3, P3] = ID): Shape {
  const r = transformShape(shape, { rot, t });
  if (!r.ok)
    throw new Error(`place: ${r.error.code} ${JSON.stringify(r.error.detail).slice(0, 200)}`);
  return r.value;
}

function must(r: Build): Shape {
  if (!r.ok) throw new Error(`${r.error.code}: ${JSON.stringify(r.error.detail).slice(0, 300)}`);
  return r.value;
}

/** Rotation that maps local +z onto world +x (local x -> world -z... see use sites). */
const Z_TO_X: [P3, P3, P3] = [
  [0, 0, 1],
  [0, 1, 0],
  [-1, 0, 0],
];

export class Recorder {
  readonly steps: Step[] = [];
  readonly part: string;
  constructor(part: string) {
    this.part = part;
  }

  run(
    id: string,
    feature: string,
    tool: string,
    route: 'direct' | 'fallback',
    build: () => Build,
  ): Shape | undefined {
    let r: Build;
    try {
      r = build();
    } catch (e) {
      this.steps.push({
        part: this.part,
        id,
        feature,
        tool,
        route,
        ok: false,
        failure: { code: `threw ${String(e).slice(0, 80)}` },
      });
      return undefined;
    }
    if (r.ok) {
      const m = measure(r.value);
      this.steps.push({
        part: this.part,
        id,
        feature,
        tool,
        route,
        ok: true,
        faces: r.value.faces.length,
        ...(m.ok ? { volume: m.value.volume } : {}),
        valid: validate(r.value).ok,
      });
      return r.value;
    }
    const d = (r.error.detail ?? {}) as { reason?: string };
    this.steps.push({
      part: this.part,
      id,
      feature,
      tool,
      route,
      ok: false,
      failure: { code: r.error.code, ...(d.reason === undefined ? {} : { reason: d.reason }) },
    });
    return undefined;
  }
}

/** Rounded rectangle, `n` segments per corner; width along the profile x, height along y. */
export function roundedRect(w: number, h: number, r: number, n = 5): P2[] {
  const pts: P2[] = [];
  const c: P2[] = [
    [w / 2 - r, h / 2 - r],
    [-(w / 2 - r), h / 2 - r],
    [-(w / 2 - r), -(h / 2 - r)],
    [w / 2 - r, -(h / 2 - r)],
  ];
  const a0 = [0, Math.PI / 2, Math.PI, 1.5 * Math.PI];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i <= n; i++) {
      const a = (a0[k] as number) + ((Math.PI / 2) * i) / n;
      pts.push([(c[k] as P2)[0] + r * cos(a), (c[k] as P2)[1] + r * sin(a)]);
    }
  }
  return pts;
}

/** Loft section frame: profile x -> world y, profile y -> world z, loft direction along +x. */
const secFrame = (x: number, y = 0, z = 0) => ({
  o: [x, y, z] as P3,
  x: [0, 1, 0] as P3,
  y: [0, 0, 1] as P3,
  z: X,
});

export interface Blaster {
  readonly parts: readonly Part[];
  readonly steps: readonly Step[];
}

const FWD: [P3, P3, P3] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 1, 0],
]; // local (x, y, z) -> world (z, x, y): a prism extruded along local z runs along world +x
const SIDE: [P3, P3, P3] = [
  [1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
]; // local z -> world +y, local y -> world -z: a plate profile drawn in (x, -z)

export function buildBlaster(): Blaster {
  const parts: Part[] = [];
  const steps: Step[] = [];
  const add = (
    rec: Recorder,
    name: string,
    operation: string,
    shape: Shape | undefined,
    fallback?: string,
  ) => {
    steps.push(...rec.steps);
    if (shape !== undefined) {
      const material = PART_MATERIAL[name];
      if (material === undefined) throw new Error(`no source material for part ${name}`);
      parts.push({
        name,
        operation,
        shape,
        material,
        ...(fallback === undefined ? {} : { fallback }),
      });
    }
  };

  // --- receiver: NURBS rear and front lofts around an analytic ejection module -----------------
  {
    const rec = new Recorder('receiver');
    const secs = (a: [number, number, number, number?][]) =>
      a.map(([x, w, h, z]) => ({
        profile: roundedRect(w, h, w > 8 ? 3 : w > 6 ? 2.2 : 1.8, 8),
        frame: secFrame(x, 0, z ?? 0),
      }));
    const whole = rec.run(
      'R1',
      'single smooth loft, 4 sections, then slot/window by box difference',
      'loft + booleanSolids/difference (probe)',
      'direct',
      () => {
        const l = loft({
          mode: 'smooth',
          sections: secs([
            [0, 6, 6.5],
            [7, 9, 10],
            [16, 9, 10],
            [23, 7, 7.5],
          ]),
        });
        if (!l.ok) return l;
        return booleanSolids(
          l.value,
          place(must(box({ size: [4, 3, 14] })), [11.5, 0, 0]),
          'difference',
        );
      },
    );
    void whole;
    const rear = rec.run(
      'R1a',
      'rear receiver: smooth loft, 3 sections (NURBS rail)',
      'loft/smooth',
      'fallback',
      () =>
        loft({
          mode: 'smooth',
          sections: secs([
            [0, 6, 6.5],
            [3.5, 8, 8.8],
            [7, 9, 10],
          ]),
        }),
    );
    const front = rec.run(
      'R1b',
      'front receiver: smooth loft, 3 sections (NURBS rail)',
      'loft/smooth',
      'fallback',
      () =>
        loft({
          mode: 'smooth',
          sections: secs([
            [16, 9, 10],
            [19.5, 7.6, 8.2, 0.5],
            [23, 5.4, 5.6, 1.2],
          ]),
        }),
    );
    add(
      rec,
      'receiver-rear',
      'loft smooth, 3 sections',
      rear,
      'receiver is 3 touching solids: single-loft slot/window refused (brep-ssi-unsupported)',
    );
    const rec2 = new Recorder('receiver-front');
    add(rec2, 'receiver-front', 'loft smooth, 3 sections', front);
  }

  // --- ejection module: two analytic prism segments (one holed-face operation per solid) -------
  {
    const seg = (id: string, x0: number, depth: number, label: string) => {
      const rec = new Recorder(label);
      const prism = rec.run(
        `${id}1`,
        `${label}: rounded-rect prism x ${x0}..${x0 + depth}`,
        'extrude',
        'direct',
        () => extrude({ profile: roundedRect(9, 10, 3), depth }),
      );
      return { rec, prism: prism === undefined ? undefined : place(prism, [x0, 0, 0], FWD) };
    };
    const probe = new Recorder('module-single');
    probe.run(
      'M0',
      'single module prism: window then through-slot (two holed-face booleans)',
      'extrude + booleanSolids/difference x2 (probe)',
      'direct',
      () => {
        const m = extrude({ profile: roundedRect(9, 10, 3), depth: 9 });
        if (!m.ok) return m;
        const w = booleanSolids(
          place(m.value, [7, 0, 0], FWD),
          place(must(box({ size: [3, 2, 2.6] })), [9.25, 4.5, 0]),
          'difference',
        );
        if (!w.ok) return w;
        return booleanSolids(
          w.value,
          place(must(box({ size: [2.5, 2.6, 14] })), [13.75, 0, 0]),
          'difference',
        );
      },
    );
    steps.push(...probe.steps);
    const a = seg('M', 7, 4.5, 'module-window');
    const groove = (x: number) => place(must(box({ size: [0.2, 12, 0.6] })), [x, 0, 5]);
    const aLined =
      a.prism === undefined
        ? undefined
        : a.rec.run(
            'M2',
            'panel-line shut line across the top (box difference)',
            'booleanSolids/difference',
            'direct',
            () => booleanSolids(a.prism as Shape, groove(7.6), 'difference'),
          );
    const aWin =
      aLined === undefined
        ? undefined
        : a.rec.run(
            'M3',
            'recessed side window 3 x 2.6, 1 deep (box difference)',
            'booleanSolids/difference',
            'direct',
            () =>
              booleanSolids(
                aLined,
                place(must(box({ size: [3, 2, 2.6] })), [9.25, 4.5, 0]),
                'difference',
              ),
          );
    add(a.rec, 'module-window', 'extrude + shut line + recessed window', aWin ?? aLined ?? a.prism);
    const b = seg('N', 11.5, 4.5, 'module-slot');
    const bLined =
      b.prism === undefined
        ? undefined
        : b.rec.run(
            'N2',
            'panel-line shut line across the top (box difference)',
            'booleanSolids/difference',
            'direct',
            () => booleanSolids(b.prism as Shape, groove(15.8), 'difference'),
          );
    const bSlot =
      bLined === undefined
        ? undefined
        : b.rec.run(
            'N3',
            'through-slot 2.5 x 2.6 across the module (box difference)',
            'booleanSolids/difference',
            'direct',
            () =>
              booleanSolids(
                bLined,
                place(must(box({ size: [2.5, 2.6, 14] })), [13.75, 0, 0]),
                'difference',
              ),
          );
    add(
      b.rec,
      'module-slot',
      'extrude + shut line + through-slot',
      bSlot ?? bLined ?? b.prism,
      'ejection module split in two prisms: a second holed-face boolean on one solid refused (planar-cross-face-holes)',
    );
  }

  // --- barrel: revolved profile with a toroidal muzzle ring ------------------------------------
  {
    const rec = new Recorder('barrel');
    const barrel = rec.run(
      'B1',
      'revolved barrel: tube, chamfered muzzle ring with rounded lip (torus arc), recessed bore',
      'revolveProfile (line + arc)',
      'direct',
      () =>
        revolveProfile({
          start: [0, 0],
          segments: [
            { kind: 'line', to: [1.5, 0] },
            { kind: 'line', to: [1.5, 12] },
            { kind: 'line', to: [2.2, 12] },
            { kind: 'line', to: [2.5, 12.3] },
            { kind: 'line', to: [2.5, 13.6] },
            { kind: 'arc', to: [2.1, 14], center: [2.1, 13.6], ccw: true },
            { kind: 'line', to: [1.0, 14] },
            { kind: 'line', to: [1.0, 13.4] },
            { kind: 'line', to: [0, 13.4] },
          ],
          frame: { o: [23, 0, 1.5], x: [0, 0, -1], y: [0, 1, 0], z: [1, 0, 0] },
        }),
    );
    add(rec, 'barrel', 'revolveProfile line+arc', barrel);
  }

  // --- cooling fins: linear pattern union on the shroud, then bore ------------------------------
  {
    const rec = new Recorder('fin-sleeve');
    const core = place(must(cylinder({ radius: 2.3, height: 9 })), [31.5, 0, 1.5], Z_TO_X);
    const disc = place(must(cylinder({ radius: 3.2, height: 0.3 })), [27.5, 0, 1.5], Z_TO_X);
    const discs = linearPattern(disc, { direction: X, spacing: 1.2, count: 6 });
    const round = discs.ok
      ? rec.run(
          'F0',
          'six round cooling discs unioned on the coaxial shroud core',
          'applyPattern/union (probe)',
          'direct',
          () => applyPattern(core, discs.value, 'union'),
        )
      : undefined;
    const plate = place(
      must(extrude({ profile: roundedRect(6.2, 6.2, 2.4, 6), depth: 0.3 })),
      [27.35, 0, 1.5],
      FWD,
    );
    const tools = linearPattern(plate, { direction: X, spacing: 1.2, count: 6 });
    const finned =
      round ??
      (tools.ok
        ? rec.run(
            'F1',
            'six rounded-square cooling fins unioned on the shroud core',
            'applyPattern/union',
            'fallback',
            () => applyPattern(core, tools.value, 'union'),
          )
        : undefined);
    const bore =
      finned === undefined
        ? undefined
        : rec.run(
            'F2',
            'bore r1.5 through the finned sleeve',
            'booleanSolids/difference',
            'direct',
            () =>
              booleanSolids(
                finned,
                place(must(cylinder({ radius: 1.5, height: 14 })), [31.5, 0, 1.5], Z_TO_X),
                'difference',
              ),
          );
    add(
      rec,
      'fin-sleeve',
      'cylinder + linearPattern union + bore difference',
      bore ?? finned,
      bore === undefined
        ? 'bore difference refused; solid sleeve overlaps the barrel tube'
        : undefined,
    );
  }

  // --- grip: sweep of a rounded profile on a canted arc ------------------------------------------
  {
    const rec = new Recorder('grip');
    const grip = rec.run(
      'G1',
      'grip: rounded profile swept along a canted arc',
      'sweep (circle path)',
      'direct',
      () =>
        sweep({
          profile: roundedRect(3.6, 5.0, 1.4, 8),
          path: {
            kind: 'circle',
            frame: { o: [-8, 0, -4.7], x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] },
            radius: 14,
          },
          range: [0, 0.8],
          stations: 33,
          xHint: [1, 0, 0],
        }),
    );
    add(rec, 'grip', 'sweep along arc', grip);
  }

  // --- trigger guard + trigger -----------------------------------------------------------------
  {
    const rec = new Recorder('trigger-guard');
    const guard = rec.run(
      'T1',
      'trigger guard: rounded profile swept on a half circle',
      'sweep (circle path)',
      'direct',
      () =>
        sweep({
          profile: roundedRect(1.0, 0.8, 0.3, 3),
          path: {
            kind: 'circle',
            frame: { o: [12.5, 0, -4.8], x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] },
            radius: 3,
          },
          range: [0, Math.PI],
          stations: 17,
        }),
    );
    add(rec, 'trigger-guard', 'sweep half circle', guard);
    const rec2 = new Recorder('trigger');
    const trig = rec2.run(
      'T2',
      'trigger blade: vertex-rounded prism',
      'filletPrism',
      'direct',
      () =>
        filletPrism({
          profile: [
            [12.0, 4.6],
            [13.3, 4.6],
            [12.9, 7.2],
            [12.3, 7.2],
          ],
          height: 0.7,
          radii: [0.2, 0.2, 0.25, 0.25],
        }),
    );
    add(
      rec2,
      'trigger',
      'filletPrism',
      trig === undefined ? undefined : place(trig, [0, -0.35, 0], SIDE),
    );
  }

  // --- energy-cell cover: shelled dome ---------------------------------------------------------
  {
    const rec = new Recorder('cell-cover');
    const dome = rec.run(
      'C1',
      'energy-cell cover: hollow revolved dome, wall 0.25',
      'revolveShell',
      'direct',
      () =>
        revolveShell({
          profile: [
            [0, 0.2],
            [1.4, 0.2],
            [2.4, 1.0],
            [2.9, 2.2],
          ],
          thickness: 0.25,
        }),
    );
    add(
      rec,
      'cell-cover',
      'revolveShell (flat crown disc + two frusta)',
      dome === undefined
        ? undefined
        : place(
            dome,
            [4.5, 0, 7.2],
            [
              [1, 0, 0],
              [0, -1, 0],
              [0, 0, -1],
            ],
          ),
      'profile starts with a flat disc: a cone starting at the axis apex is refused by the quad mesher (degenerate-side)',
    );
  }

  // --- side panel: vertex-rounded plate with a bolt circle -------------------------------------
  {
    const rec = new Recorder('side-panel');
    const plate = rec.run(
      'P1',
      'side plate 9 x 5, rounded corners r1',
      'filletPrism',
      'direct',
      () =>
        filletPrism({
          profile: [
            [-4.5, -2.5],
            [4.5, -2.5],
            [4.5, 2.5],
            [-4.5, 2.5],
          ],
          height: 0.4,
          radii: [1, 1, 1, 1],
        }),
    );
    const bolts = circularPattern(
      place(must(cylinder({ radius: 0.3, height: 2 })), [1.8, 0, 0.2]),
      { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: 6 },
    );
    const drilled =
      plate === undefined || !bolts.ok
        ? undefined
        : rec.run(
            'P2',
            'bolt circle: 6 bores r0.3 on r1.8',
            'applyPattern/difference',
            'direct',
            () => applyPattern(plate, bolts.value, 'difference'),
          );
    add(
      rec,
      'side-panel',
      'filletPrism + circularPattern bores',
      drilled === undefined ? undefined : place(drilled, [12, 4.5, -0.8], SIDE),
    );
  }

  // --- rear sight --------------------------------------------------------------------------------
  {
    const rec = new Recorder('sight');
    const sight = rec.run('S1', 'rear sight: drafted prism', 'draftedPrism', 'direct', () =>
      draftedPrism({
        profile: [
          [-1.5, -0.8],
          [1.5, -0.8],
          [1.5, 0.8],
          [-1.5, 0.8],
        ],
        height: 1.2,
        angle: 0.25,
      }),
    );
    add(
      rec,
      'sight',
      'draftedPrism',
      sight === undefined ? undefined : place(sight, [8, 0, 5], ID),
    );
  }

  void [filletBox, axisRotation];
  return { parts, steps };
}
