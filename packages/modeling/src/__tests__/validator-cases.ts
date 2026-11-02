import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { MeshAsset } from '@forgeax/engine-types';
import type { DesignedContact } from '../interference';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import type { ValidateOptions } from '../validate';
import { installed } from './fixtures/frozen-builds';

/** Defect classes of the design 15 regression set. */
export type DefectClass = 'flip' | 'self-intersection' | 'thin-wall' | 'uv-overlap' | 't-junction';

export interface ValidatorCase {
  readonly name: string;
  /** Planted defect, or undefined for a legal counterexample that must stay clean. */
  readonly defect?: DefectClass;
  readonly build: () => Model;
  readonly options?: ValidateOptions;
}

/** A frozen final state (gzipped FXEM under `fixtures/`), installed exactly as encoded. */
const frozen = (file: string): Model =>
  installed(
    new Uint8Array(gunzipSync(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)))),
    file,
  ) as unknown as Model;

/** The 16 designed joints of the frozen C-104 suspension corner. */
const SUSPENSION_JOINTS: readonly DesignedContact[] = [
  { parts: ['lower-arm', 'lower-bush'], tolerance: 0.02 },
  { parts: ['lower-arm', 'lower-bushes'], tolerance: 0.02 },
  { parts: ['lower-arm', 'lower-brace'], tolerance: 0.018 },
  { parts: ['upper-arm', 'upper-bush'], tolerance: 0.015 },
  { parts: ['upper-arm', 'upper-bushes'], tolerance: 0.015 },
  { parts: ['boot', 'tie-rod'], tolerance: 0.001 },
  { parts: ['adjuster', 'tie-rod'], tolerance: 0.007 },
  { parts: ['damper-rod', 'perches'], tolerance: 0.006 },
  { parts: ['damper-rod', 'top-mount'], tolerance: 0.013 },
  { parts: ['damper', 'perch'], tolerance: 0.023 },
  { parts: ['steer-arm', 'tie-ball'], tolerance: 0.007 },
  { parts: ['steer-arm', 'upright'], tolerance: 0.025 },
  { parts: ['lower-ball', 'upright'], tolerance: 0.002 },
  { parts: ['hub', 'upright'], tolerance: 0.003 },
  { parts: ['hub', 'stud'], tolerance: 0.003 },
  { parts: ['hub', 'studs'], tolerance: 0.003 },
];

const exported = (m: Model): MeshAsset => {
  m.uv.project({ mode: 'box', scale: 1 });
  const out = m.toMesh({ normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
};

const box = (size: [number, number, number], center: [number, number, number] = [0, 0, 0]) => {
  const m = model();
  m.box({ size, center });
  return m;
};

const append = (...parts: Model[]) => {
  const m = model();
  for (const part of parts) m.append(part);
  return m;
};

/** A box MeshAsset with triangle `t` wound backwards, lifted back (lift detaches it). */
function flippedTriangle(): Model {
  const mesh = exported(box([1, 1, 1]));
  const indices = Uint32Array.from(mesh.indices as ArrayLike<number>);
  const t = 3;
  [indices[t * 3 + 1], indices[t * 3 + 2]] = [
    indices[t * 3 + 2] as number,
    indices[t * 3 + 1] as number,
  ];
  const m = model();
  m.lift({ ...mesh, indices } as MeshAsset);
  return m;
}

function shelled(wall: number): Model {
  const inner = box([1 - 2 * wall, 1 - 2 * wall, 1 - 2 * wall]);
  inner.flip(sel.all());
  return append(box([1, 1, 1]), inner);
}

function cornerPiercing(): Model {
  const m = model();
  m.polygon({
    points: [
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
    ],
  });
  m.polygon({
    points: [
      [0, 0, 0],
      [0.5, 0.5, -1],
      [0.5, 0.5, 1],
    ],
  });
  m.weld({ distance: 1e-9 });
  return m;
}

function tJunction(welded: boolean): Model {
  const m = model();
  m.polygon({
    points: welded
      ? [
          [0, 0, 0],
          [2, 0, 0],
          [2, 1, 0],
          [1, 1, 0],
          [0, 1, 0],
        ]
      : [
          [0, 0, 0],
          [2, 0, 0],
          [2, 1, 0],
          [0, 1, 0],
        ],
  });
  m.polygon({
    points: [
      [0, 1, 0],
      [1, 1, 0],
      [1, 2, 0],
      [0, 2, 0],
    ],
  });
  m.polygon({
    points: [
      [1, 1, 0],
      [2, 1, 0],
      [2, 2, 0],
      [1, 2, 0],
    ],
  });
  m.weld({ distance: 1e-9 });
  return m;
}

/**
 * Two-sided sheet: a flipped copy behind the front. Welded, only a single quad is
 * manifold (interior edges of a welded grid would carry four faces).
 */
function doubleSided(segments: number, welded: boolean): Model {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: segments, heightSegments: segments, tag: 'front' });
  m.duplicate(sel.tag('front'), { label: 'back' });
  m.flip(sel.createdBy('back', 'copy'));
  if (welded) m.weld({ distance: 1e-9 });
  return m;
}

function mirroredHalf(): Model {
  const m = model();
  m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 12 });
  m.planeCut({ point: [0, 0, 0], normal: [1, 0, 0], keep: 'positive' });
  m.mirror({ axis: 'x' });
  return m;
}

function wedge(): Model {
  const m = model();
  const half = Math.tan((2.5 * Math.PI) / 180);
  m.extrudePolygon({
    points: [
      [0, 0],
      [1, -half],
      [1, half],
    ],
    depth: 0.2,
  });
  return m;
}

function projected(m: Model, mode: 'box' | 'planar'): Model {
  m.uv.project(mode === 'box' ? { mode, scale: 1 } : { mode, axis: 'z', scale: 1 });
  return m;
}

/** A tube through a rubber sleeve, tagged `tube` and `bushing` (C-104 style assembly). */
function bushingFit(tubeRadius: number, solid = false, bracket = false): Model {
  const m = model();
  m.cylinder({
    radiusTop: tubeRadius,
    radiusBottom: tubeRadius,
    height: 0.2,
    radialSegments: 12,
    tag: 'tube',
  });
  if (solid)
    m.cylinder({
      radiusTop: 0.02,
      radiusBottom: 0.02,
      height: 0.05,
      radialSegments: 16,
      tag: 'bushing',
    });
  else {
    m.revolve({
      points: [
        [0.01, -0.025],
        [0.02, -0.025],
        [0.02, 0.025],
        [0.01, 0.025],
        [0.01, -0.025],
      ],
      segments: 16,
      tag: 'bushing',
    });
  }
  if (bracket) m.box({ size: [0.03, 0.03, 0.03], center: [0, 0.07, 0], tag: 'bracket' });
  return m;
}

const FIT: ValidateOptions = { contacts: [{ parts: ['tube', 'bushing'] }] };

/** A plate split by a box cutter (B3 audit N4): the piece and the plate with its hole. */
function splitPlate(): Model {
  const m = model();
  m.box({ size: [0.28, 0.012, 0.2], center: [0, 0.006, 0], label: 'plate' });
  const cutter = model();
  cutter.box({ size: [0.056, 0.036, 0.02], center: [0.0725, 0.006, 0.06] });
  m.splitBy(cutter, { label: 'cover' });
  return m;
}

/**
 * Design 15 validator regression set: planted defects and legal counterexamples
 * that a careless detector confuses with them. Every case runs with a 5 mm
 * thickness limit; UV cases also ask for unique UVs.
 */
export const VALIDATOR_CASES: readonly ValidatorCase[] = [
  { name: 'flipped triangle in a lifted box', defect: 'flip', build: flippedTriangle },
  {
    name: 'inverted part beside a box',
    defect: 'flip',
    build: () => {
      const part = box([0.5, 0.5, 0.5], [2, 0, 0]);
      part.flip(sel.all());
      return append(box([1, 1, 1]), part);
    },
  },
  {
    name: 'interpenetrating boxes',
    defect: 'self-intersection',
    build: () => append(box([1, 1, 1]), box([1, 1, 1], [0.5, 0.25, 0.25])),
  },
  {
    name: 'triangles piercing at a shared corner',
    defect: 'self-intersection',
    build: cornerPiercing,
  },
  {
    name: 'coincident duplicate box',
    defect: 'self-intersection',
    build: () => append(box([1, 1, 1]), box([1, 1, 1])),
  },
  {
    name: 'box sunk half its height through an ulp-smaller footprint',
    defect: 'self-intersection',
    build: () => append(box([1, 1, 1]), box([1 - 2e-9, 1, 1 - 2e-9], [0, 0.5, 0])),
  },
  {
    name: 'float-sized boxes overlapping half their height',
    defect: 'self-intersection',
    build: () => append(box([0.1, 0.1, 0.1]), box([0.3 - 0.2, 0.1, 0.3 - 0.2], [0, 0.05, 0])),
  },
  {
    name: 'unit cubes offset (0.5, 0.5, 0.5)',
    defect: 'self-intersection',
    build: () => append(box([1, 1, 1]), box([1, 1, 1], [0.5, 0.5, 0.5])),
  },
  {
    name: 'unit cubes offset (0.25, 0.25, 0.25), lifted from an export',
    defect: 'self-intersection',
    build: () => {
      const m = model();
      m.lift(exported(append(box([1, 1, 1]), box([1, 1, 1], [0.25, 0.25, 0.25]))));
      return m;
    },
  },
  {
    name: 'cover piece pushed 5 mm sideways into its plate (audit N4)',
    defect: 'self-intersection',
    build: () => {
      const m = splitPlate();
      m.translate(sel.createdBy('cover', 'piece'), [0.005, 0, 0]);
      return m;
    },
  },
  {
    name: 'coplanar sheets of separate parts overlapping 1 mm (audit N4)',
    defect: 'self-intersection',
    build: () => {
      const m = model();
      m.plane({ width: 0.2, height: 0.2 });
      m.plane({ width: 0.2, height: 0.2, center: [0.199, 0.05, 0] });
      return m;
    },
  },
  {
    name: 'duplicate box 1e-7 off, near-coplanar over whole faces (audit N4)',
    defect: 'self-intersection',
    build: () => append(box([1, 1, 1]), box([1, 1, 1], [1e-7, -1e-7, 1e-7])),
  },
  {
    name: 'tube through a bushing of the same nominal radius, fit not declared (fits)',
    defect: 'self-intersection',
    build: () => bushingFit(0.01),
  },
  {
    name: 'declared fit, but the bushing is solid: 10 mm deep (fits)',
    defect: 'self-intersection',
    build: () => bushingFit(0.01, true),
    options: FIT,
  },
  {
    name: '0.2 mm press fit declared with a 0.1 mm tolerance (fits)',
    defect: 'self-intersection',
    build: () => bushingFit(0.0102),
    options: { contacts: [{ parts: ['tube', 'bushing'], tolerance: 1e-4 }] },
  },
  {
    name: 'declared fit beside a bracket the tube pierces (fits)',
    defect: 'self-intersection',
    build: () => bushingFit(0.01, false, true),
    options: FIT,
  },
  { name: '2 mm shell wall', defect: 'thin-wall', build: () => shelled(0.002) },
  {
    name: 'box projection on a lightmapped box',
    defect: 'uv-overlap',
    build: () => projected(box([1, 1, 1]), 'box'),
    options: { uniqueUv: true },
  },
  { name: 'unwelded edge vertex', defect: 't-junction', build: () => tJunction(false) },
  {
    name: 'stem standing on a base one ulp low (found by C-002)',
    build: () => {
      const stem = model();
      stem.cylinder({
        radiusTop: 0.008,
        radiusBottom: 0.008,
        height: 0.214,
        radialSegments: 12,
        heightSegments: 3,
        center: [0, 0.036 + 0.107, 0],
      });
      const base = model();
      base.cylinder({
        radiusTop: 0.1,
        radiusBottom: 0.1,
        height: 0.036,
        radialSegments: 32,
        center: [0, 0.018, 0],
      });
      return append(base, stem);
    },
  },
  {
    name: 'box resting 1e-9 low and overhanging the edge (review K2)',
    build: () => append(box([2, 1, 2]), box([0.5, 0.5, 0.5], [0.9, 0.75 - 1e-9, -0.2])),
  },
  {
    name: 'boxes side by side overlapping half the tolerance (review K2)',
    build: () => append(box([1, 1, 1]), box([1, 1, 1], [1 - 5e-6, 0.2, 0.3])),
  },
  {
    name: 'stem one ulp low on the base rim (review K2)',
    build: () => {
      const stem = model();
      stem.cylinder({
        radiusTop: 0.008,
        radiusBottom: 0.008,
        height: 0.214,
        radialSegments: 12,
        heightSegments: 3,
        center: [0.1, 0.036 + 0.107, 0],
      });
      const base = model();
      base.cylinder({
        radiusTop: 0.1,
        radiusBottom: 0.1,
        height: 0.036,
        radialSegments: 32,
        center: [0, 0.018, 0],
      });
      return append(base, stem);
    },
  },
  {
    name: 'box resting 1e-9 low, wall check on (review K3)',
    build: () => append(box([2, 1, 2]), box([0.5, 0.5, 0.5], [0.3, 0.75 - 1e-9, -0.2])),
  },
  {
    name: 'double-sided sheet of two unwelded pieces (review K4)',
    build: () => {
      const piece = (x: number) => {
        const m = model();
        m.plane({ width: 1, height: 1, center: [x, 0, 0], tag: 'front' });
        m.duplicate(sel.tag('front'), { label: 'back' });
        m.flip(sel.createdBy('back', 'copy'));
        return m;
      };
      return append(piece(0), piece(1));
    },
  },
  { name: 'plate and its splitBy piece, vertices an ulp apart (audit N4)', build: splitPlate },
  {
    name: 'splitBy cover lifted 4 mm, walls flush with the hole an ulp out of plane (audit N4)',
    build: () => {
      const m = splitPlate();
      m.translate(sel.createdBy('cover', 'piece'), [0, 0.004, 0]);
      return m;
    },
  },
  {
    name: 'C-011 panel at its declared minimum width (audit N4)',
    build: () => frozen('panel-narrow.fxem.gz'),
  },
  {
    name: 'tube through a bushing of the same nominal radius, fit declared (fits)',
    build: () => bushingFit(0.01),
    options: FIT,
  },
  {
    name: '0.2 mm press fit declared with the default 1 mm tolerance (fits)',
    build: () => bushingFit(0.0102),
    options: FIT,
  },
  {
    name: 'declared fit with clearance: a thinner tube never touches (fits)',
    build: () => bushingFit(0.009),
    options: FIT,
  },
  {
    name: 'C-104 suspension corner as an assembly with its 16 declared joints (fits)',
    build: () => frozen('suspension.fxem.gz'),
    options: { contacts: SUSPENSION_JOINTS },
  },
  { name: 'double-sided quad, welded', build: () => doubleSided(1, true) },
  { name: 'double-sided grid, coincident sides', build: () => doubleSided(3, false) },
  {
    name: 'small box resting flush on a large one',
    build: () => append(box([2, 1, 2]), box([0.5, 0.5, 0.5], [0.3, 0.75, -0.2])),
  },
  {
    name: 'boxes touching along an edge (knife edge)',
    build: () => append(box([1, 1, 1]), box([1, 1, 1], [1, 1, 0])),
  },
  { name: '5 degree blade (knife edge)', build: wedge },
  { name: '100 mm walls around a cavity', build: () => shelled(0.1) },
  { name: 'mirrored half welded at the seam', build: mirroredHalf },
  {
    name: 'open plane with collinear boundary vertices',
    build: () => {
      const m = model();
      m.plane({ width: 2, height: 1, widthSegments: 4, heightSegments: 2 });
      return m;
    },
  },
  { name: 'welded edge vertex', build: () => tJunction(true) },
  {
    name: 'planar projection of one sheet',
    build: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 3, heightSegments: 3 });
      return projected(m, 'planar');
    },
    options: { uniqueUv: true },
  },
];

const CLASS_OF: Readonly<Record<string, DefectClass>> = {
  'face-flipped': 'flip',
  'mesh-inverted': 'flip',
  'self-intersection': 'self-intersection',
  'thin-wall': 'thin-wall',
  'uv-overlap': 'uv-overlap',
  't-junction': 't-junction',
};

export interface CaseResult {
  readonly name: string;
  readonly expected: DefectClass | null;
  readonly detected: readonly DefectClass[];
}

export interface RegressionReport {
  readonly cases: readonly CaseResult[];
  readonly perClass: Readonly<
    Record<DefectClass, { tp: number; fp: number; fn: number; precision: number; recall: number }>
  >;
  readonly precision: number;
  readonly recall: number;
}

/** Run the set; a detection is a warning or error mapped to a defect class. */
export function runValidatorRegression(
  validate: (m: Model, options: ValidateOptions) => readonly { code: string; severity: string }[],
): RegressionReport {
  const cases = VALIDATOR_CASES.map((c) => {
    const issues = validate(c.build(), { minThickness: 0.005, ...c.options });
    const detected = [
      ...new Set(
        issues
          .filter((i) => i.severity !== 'info' && CLASS_OF[i.code] !== undefined)
          .map((i) => CLASS_OF[i.code] as DefectClass),
      ),
    ].sort();
    return { name: c.name, expected: c.defect ?? null, detected };
  });
  const classes: DefectClass[] = [
    'flip',
    'self-intersection',
    'thin-wall',
    'uv-overlap',
    't-junction',
  ];
  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  const perClass = Object.fromEntries(
    classes.map((k) => {
      const tp = cases.filter((c) => c.expected === k && c.detected.includes(k)).length;
      const fn = cases.filter((c) => c.expected === k && !c.detected.includes(k)).length;
      const fp = cases.filter((c) => c.expected !== k && c.detected.includes(k)).length;
      return [k, { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) }];
    }),
  ) as RegressionReport['perClass'];
  const sum = (key: 'tp' | 'fp' | 'fn') => classes.reduce((n, k) => n + perClass[k][key], 0);
  return {
    cases,
    perClass,
    precision: ratio(sum('tp'), sum('tp') + sum('fp')),
    recall: ratio(sum('tp'), sum('tp') + sum('fn')),
  };
}
