import { ok, type Result } from '@forgeax/engine-types';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { cylinder, extrude, revolve } from '../../src/brep/build.ts';
import { loft } from '../../src/brep/loft.ts';
import { measure } from '../../src/brep/measure.ts';
import { applyPattern, circularPattern } from '../../src/brep/pattern.ts';
import { sweep } from '../../src/brep/sweep.ts';
import { transformShape } from '../../src/brep/transform.ts';
import type { Shape } from '../../src/brep/types.ts';
import { validate } from '../../src/brep/validate.ts';
import type { P2, P3 } from '../../src/brep/vec.ts';
import type { ModelingError } from '../../src/errors.ts';
import { must } from '../brep-heal/damage.ts';

export type PartName = 'gearbox-cover' | 'pump-manifold';

/** One feature step: what was asked of which tool, and what came back. */
export interface StepRecord {
  readonly part: PartName;
  readonly id: string;
  readonly feature: string;
  readonly tool: string;
  /** `direct` is the intended construction; `fallback` is the shorter route taken after a fail-close. */
  readonly route: 'direct' | 'fallback';
  readonly ok: boolean;
  readonly faces?: number;
  readonly volume?: number;
  readonly valid?: boolean;
  readonly failure?: {
    readonly code: string;
    readonly expected: string;
    readonly detail: Readonly<Record<string, unknown>>;
  };
  /** Gap id (see gaps.ts) that explains a fail-close. */
  readonly gap?: string;
}

/** A feature in the rendered assembly: its step id, label and the solid it contributes. */
export interface PartFeature {
  readonly id: string;
  readonly label: string;
  readonly shape: Shape;
}

export interface StressPart {
  readonly name: PartName;
  readonly steps: readonly StepRecord[];
  readonly features: readonly PartFeature[];
}

type Build = Result<Shape, ModelingError>;

const IDENTITY: [P3, P3, P3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const Z_AXIS = { origin: [0, 0, 0] as P3, direction: [0, 0, 1] as P3 };
/** (x, y, z) -> (x, -z, y): a profile drawn in xy stands up in xz, its depth running along -y. */
const STAND_UP: [P3, P3, P3] = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];
/** (x, y, z) -> (z, y, -x): turns a z axis part so it points along +x. */
const POINT_X: [P3, P3, P3] = [
  [0, 0, 1],
  [0, 1, 0],
  [-1, 0, 0],
];

export function move(shape: Shape, t: P3, rot: [P3, P3, P3] = IDENTITY): Shape {
  return must(transformShape(shape, { rot, t }));
}

/** Regular polygon with `n` vertices, radius `r`, as a circle stand-in for loft/sweep profiles. */
export function polygon(r: number, n = 24): P2[] {
  return Array.from(
    { length: n },
    (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as P2,
  );
}

/** A z axis cylinder spanning z0..z1, centred on (x, y); the seam is left at phase 0. */
export function pin(r: number, z0: number, z1: number, x = 0, y = 0): Shape {
  return move(must(cylinder({ radius: r, height: z1 - z0 })), [x, y, (z0 + z1) / 2]);
}

class Recorder {
  readonly steps: StepRecord[] = [];
  readonly part: PartName;
  constructor(part: PartName) {
    this.part = part;
  }

  /** Runs one build; records it; returns the shape on success. */
  run(
    id: string,
    feature: string,
    tool: string,
    route: 'direct' | 'fallback',
    build: () => Build,
    gap?: string,
  ): Shape | undefined {
    const r = build();
    if (r.ok) {
      this.steps.push({
        part: this.part,
        id,
        feature,
        tool,
        route,
        ok: true,
        faces: r.value.faces.length,
        volume: must(measure(r.value)).volume,
        valid: validate(r.value).ok,
      });
      return r.value;
    }
    this.steps.push({
      part: this.part,
      id,
      feature,
      tool,
      route,
      ok: false,
      failure: {
        code: r.error.code,
        expected: r.error.expected,
        detail: (r.error.detail ?? {}) as Record<string, unknown>,
      },
      ...(gap === undefined ? {} : { gap }),
    });
    return undefined;
  }
}

const hollowArc = (
  ro: number,
  ri: number,
  frame: { o: P3; x: P3; y: P3; z: P3 },
  radius: number,
): Build =>
  sweep({
    profile: polygon(ro),
    holes: [polygon(ri).reverse()],
    path: { kind: 'circle', frame, radius },
    range: [0, Math.PI / 2],
    stations: 12,
  });

/**
 * Gearbox cover: round plate, bolt circle, central boss with bore, raised rim, four ribs, swept
 * oil pipe stub. Every step is first tried as the boolean the feature calls for; a fail-close
 * routes to a shorter construction (a separate solid of the assembly) so the part still builds.
 */
export function gearboxCover(): StressPart {
  const rec = new Recorder('gearbox-cover');
  const features: PartFeature[] = [];

  const plate = rec.run('A1', 'plate r60 x 8', 'cylinder', 'direct', () =>
    cylinder({ radius: 60, height: 8 }),
  ) as Shape;
  const bolts = must(circularPattern(pin(4, -10, 10, 55), { axis: Z_AXIS, count: 8 }));
  const bolted =
    rec.run('A2', 'bolt circle, 8 bores r4 on r55', 'applyPattern/difference', 'direct', () =>
      applyPattern(plate, bolts),
    ) ?? plate;
  const bossed =
    rec.run('A3', 'central boss r16 up to z20', 'booleanSolids/union', 'direct', () =>
      booleanSolids(bolted, pin(16, -6, 20), 'union'),
    ) ?? bolted;
  const direct = rec.run(
    'A4',
    'bore r7 through plate and boss',
    'booleanSolids/difference',
    'direct',
    () => booleanSolids(bossed, pin(7, -10, 30), 'difference'),
    'G1',
  );
  const drilled =
    direct === undefined
      ? rec.run(
          'A4b',
          'bore r7 through the bolted plate, before any boss',
          'booleanSolids/difference',
          'fallback',
          () => booleanSolids(bolted, pin(7, -10, 10), 'difference'),
        )
      : undefined;
  const body = direct ?? drilled ?? bossed;
  const stack =
    direct === undefined
      ? rec.run(
          'A4c',
          'boss as a stand-alone revolved sleeve r7..16, z4..26',
          'revolve',
          'fallback',
          () =>
            revolve({
              profile: [
                [7, 4],
                [16, 4],
                [16, 26],
                [7, 26],
                [7, 4],
              ],
            }),
        )
      : undefined;
  features.push({ id: 'A1-A4', label: 'plate, bolt circle, bore', shape: body });
  if (stack !== undefined) features.push({ id: 'A4c', label: 'boss sleeve', shape: stack });

  const ring = move(
    must(
      revolve({
        profile: [
          [42, 0],
          [50, 0],
          [50, 10],
          [42, 10],
          [42, 0],
        ],
      }),
    ),
    [0, 0, 4],
  );
  const rimDirect = rec.run(
    'A5',
    'raised rim ring r42..50, z2..14 overlapping the plate top',
    'booleanSolids/union',
    'direct',
    () => booleanSolids(body, move(ring, [0, 0, -2]), 'union'),
    'G3',
  );
  features.push({ id: 'A5', label: 'raised rim', shape: rimDirect ?? ring });
  if (rimDirect === undefined)
    rec.run('A5b', 'raised rim as a stacked revolve solid', 'revolve', 'fallback', () =>
      revolve({
        profile: [
          [42, 0],
          [50, 0],
          [50, 10],
          [42, 10],
          [42, 0],
        ],
      }),
    );

  const rib = move(
    must(
      extrude({
        profile: [
          [0, 0],
          [26, 0],
          [0, 14],
        ],
        depth: 4,
      }),
    ),
    [18, 2, 4],
    STAND_UP,
  );
  const ribDirect = rec.run(
    'A6',
    'rib: gusset plate unioned on the cover',
    'booleanSolids/union',
    'direct',
    () => booleanSolids(body, rib, 'union'),
    'G2',
  );
  const ribs = must(circularPattern(rib, { axis: Z_AXIS, count: 4 }));
  if (ribDirect === undefined)
    rec.run(
      'A6b',
      '4 ribs as stand-alone extruded gussets',
      'extrude + circularPattern',
      'fallback',
      () =>
        extrude({
          profile: [
            [0, 0],
            [26, 0],
            [0, 14],
          ],
          depth: 4,
        }),
    );
  features.push(...ribs.map((s, i) => ({ id: 'A6', label: i === 0 ? '4 ribs' : '', shape: s })));

  const a = Math.PI / 8;
  const [ca, sa] = [Math.cos(a), Math.sin(a)];
  const stubFrame = {
    o: [50 * ca, 50 * sa, 28] as P3,
    x: [0, 0, -1] as P3,
    y: [ca, sa, 0] as P3,
    z: [sa, -ca, 0] as P3,
  };
  const stub = must(hollowArc(6, 3.5, stubFrame, 19));
  const stubDirect = rec.run(
    'A7',
    'oil pipe stub unioned on the cover',
    'booleanSolids/union',
    'direct',
    () => booleanSolids(body, stub, 'union'),
    'G4',
  );
  rec.run('A7b', 'oil pipe stub: hollow quarter-arc sweep, stand-alone', 'sweep', 'fallback', () =>
    hollowArc(6, 3.5, stubFrame, 19),
  );
  features.push({ id: 'A7', label: 'oil pipe stub', shape: stubDirect ?? stub });
  return { name: 'gearbox-cover', steps: rec.steps, features };
}

const frameAt = (z: number) => ({
  o: [0, 0, z] as P3,
  x: [1, 0, 0] as P3,
  y: [0, 1, 0] as P3,
  z: [0, 0, 1] as P3,
});

/**
 * Pump manifold: inlet flange with bolt circle, bore and two port bosses, a square-to-round lofted
 * transition, a swept elbow pipe and an outlet flange with its own bolt circle. Same protocol as
 * the cover: boolean first, shorter construction on a fail-close.
 */
export function pumpManifold(): StressPart {
  const rec = new Recorder('pump-manifold');
  const features: PartFeature[] = [];

  const flange = rec.run('B1', 'inlet flange r50 x 10 (z-10..0)', 'cylinder', 'direct', () =>
    cylinder({ radius: 50, height: 10 }),
  ) as Shape;
  const inlet = move(flange, [0, 0, -5]);
  const bolts = must(circularPattern(pin(3.5, -20, 10, 42), { axis: Z_AXIS, count: 6 }));
  const bolted =
    rec.run('B2', 'bolt circle, 6 bores r3.5 on r42', 'applyPattern/difference', 'direct', () =>
      applyPattern(inlet, bolts),
    ) ?? inlet;
  const bored =
    rec.run('B3', 'flow bore r26 through the flange', 'booleanSolids/difference', 'direct', () =>
      booleanSolids(bolted, pin(26, -20, 10), 'difference'),
    ) ?? bolted;
  const bossTools = must(circularPattern(pin(5, -22, -4, 0, 34), { axis: Z_AXIS, count: 2 }));
  const bossed = rec.run(
    'B4',
    'two port bosses r5 under the flange',
    'applyPattern/union',
    'direct',
    () => applyPattern(bored, bossTools, 'union'),
    'G5',
  );
  const flange1 = bossed ?? bored;
  features.push({ id: 'B1-B3', label: 'inlet flange, bolt circle, bore', shape: flange1 });
  if (bossed === undefined) {
    rec.run(
      'B4b',
      'port bosses as stand-alone cylinders',
      'cylinder + circularPattern',
      'fallback',
      () => cylinder({ radius: 5, height: 18 }),
    );
    features.push(
      ...bossTools.map((s, i) => ({ id: 'B4', label: i === 0 ? 'port bosses' : '', shape: s })),
    );
  }

  const squareRing = [
    [-35, -35],
    [35, -35],
    [35, 35],
    [-35, 35],
  ] as P2[];
  const transition = rec.run(
    'B5',
    'lofted transition: square 70 / bore r26 to round r22 / bore r16',
    'loft (ruled, hollow)',
    'direct',
    () =>
      loft({
        mode: 'ruled',
        samples: 32,
        sections: [
          { profile: squareRing, holes: [polygon(26, 32).reverse()], frame: frameAt(0) },
          { profile: polygon(22, 32), holes: [polygon(16, 32).reverse()], frame: frameAt(40) },
        ],
      }),
  );
  const joined = rec.run(
    'B6',
    'inlet flange unioned onto the transition',
    'booleanSolids/union',
    'direct',
    () => booleanSolids(transition as Shape, move(flange1, [0, 0, 0]), 'union'),
    'G6',
  );
  if (joined === undefined)
    rec.run(
      'B6b',
      'flange and transition kept as touching solids of the assembly',
      'assembly',
      'fallback',
      () => ok(transition as Shape),
    );
  features.push({ id: 'B5', label: 'lofted transition', shape: transition as Shape });

  const elbowFrame = {
    o: [30, 0, 40] as P3,
    x: [-1, 0, 0] as P3,
    y: [0, 0, 1] as P3,
    z: [0, 1, 0] as P3,
  };
  const elbow = rec.run(
    'B7',
    'swept pipe: hollow quarter arc r30, tube r22 / bore r16',
    'sweep (circle path)',
    'direct',
    () => hollowArc(22, 16, elbowFrame, 30),
  ) as Shape;
  const elbowJoined = rec.run(
    'B8',
    'elbow pipe unioned onto the transition',
    'booleanSolids/union',
    'direct',
    () => booleanSolids(transition as Shape, elbow, 'union'),
    'G6',
  );
  if (elbowJoined === undefined)
    rec.run(
      'B8b',
      'elbow pipe kept as a touching solid of the assembly',
      'assembly',
      'fallback',
      () => ok(elbow as Shape),
    );
  features.push({ id: 'B7', label: 'swept elbow pipe', shape: elbowJoined ?? elbow });

  const outletBase = rec.run('B9', 'outlet flange r36 x 8', 'cylinder', 'direct', () =>
    cylinder({ radius: 36, height: 8 }),
  ) as Shape;
  const outBolts = must(circularPattern(pin(3, -20, 20, 29), { axis: Z_AXIS, count: 8 }));
  const outBolted =
    rec.run(
      'B10',
      'outlet bolt circle, 8 bores r3 on r29',
      'applyPattern/difference',
      'direct',
      () => applyPattern(outletBase, outBolts),
    ) ?? outletBase;
  const outBored =
    rec.run('B11', 'outlet bore r16', 'booleanSolids/difference', 'direct', () =>
      booleanSolids(outBolted, pin(16, -20, 20), 'difference'),
    ) ?? outBolted;
  features.push({
    id: 'B9-B11',
    label: 'outlet flange',
    shape: move(outBored, [34, 0, 70], POINT_X),
  });
  return { name: 'pump-manifold', steps: rec.steps, features };
}
