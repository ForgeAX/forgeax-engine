// Row 4: marched NURBS x quadric and NURBS x plane section chains, with the stitcher's end reasons drawn as colored
// markers (boundary / junction / gap-over-tol / open). Every branch comes from `intersectFaces` (the SSI marcher) and
// is joined by `joinBranches` with the marcher's stop reasons, so a branch that leaves its face reads as `boundary`.
import { loft } from '../../src/brep/loft.ts';
import { fromSsiBranch, type JoinBranch, joinBranches } from '../../src/brep/query/stitch.ts';
import { intersectFaces } from '../../src/brep/ssi/intersect-faces.ts';
import type { SsiBranch, SsiFace } from '../../src/brep/ssi/types.ts';
import { makeFrame, surfacePoint } from '../../src/brep/surfaces.ts';
import { sweep } from '../../src/brep/sweep.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape, Surface } from '../../src/brep/types.ts';
import { cos, sin } from '../../src/dmath.ts';
import { surfaceDomain } from '../../src/nurbs.ts';
import type { Image, RGB } from '../brep-kit/image.ts';
import { drawLegend, type LegendEntry } from '../brep-kit/legend.ts';
import { asPolyMesh, meshSurface } from '../brep-kit/mesh-scene.ts';
import { renderScene } from '../brep-kit/raster.ts';
import type { Scene, SceneLine, SceneMarker, SceneTri } from '../brep-kit/scene.ts';
import type { SheetCell } from '../brep-kit/sheet.ts';
import { caption, finish, must, record, savePng, saveSheet } from './common.ts';

type P3 = readonly [number, number, number];
type Nurbs = Extract<Surface, { kind: 'nurbs' }>;

const SIZE = 640;
const JOIN_EPS = 1e-5;
const GRID = 28;
const END_COLOR: Record<string, RGB> = {
  boundary: [255, 150, 0],
  junction: [255, 0, 255],
  'gap-over-tol': [255, 50, 50],
  open: [170, 175, 185],
};
const END_LEGEND: LegendEntry[] = [
  { label: 'end: boundary (left the face)', color: END_COLOR.boundary as RGB, style: 'dot' },
  { label: 'end: junction (3+ ends meet)', color: END_COLOR.junction as RGB, style: 'dot' },
  { label: 'end: gap over tol', color: END_COLOR['gap-over-tol'] as RGB, style: 'dot' },
  { label: 'end: open', color: END_COLOR.open as RGB, style: 'dot' },
];
const CHAIN_COLORS: RGB[] = [
  [60, 200, 255],
  [120, 235, 120],
  [255, 230, 90],
  [190, 150, 255],
];
const SURFACE_COLOR: RGB = [110, 128, 158];
const PLANE_COLOR: RGB = [150, 205, 255];
const CAP_COLOR: RGB = [196, 170, 120];

function tessellateNurbs(surface: Nurbs, color: RGB): SceneTri[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface.surface);
  const at = (i: number, j: number): P3 =>
    surfacePoint(surface, u0 + ((u1 - u0) * i) / GRID, v0 + ((v1 - v0) * j) / GRID);
  const tris: SceneTri[] = [];
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      tris.push({ a, b, c, color }, { a, b: c, c: d, color });
    }
  return tris;
}

/** Shaded triangles of the planar B-rep faces (end caps) of a part; the NURBS walls are drawn by `tessellateNurbs`. */
function capTris(shape: Shape): SceneTri[] {
  const mesh = must(tessellate(shape));
  const poly = asPolyMesh(mesh);
  const byLabel = new Map(shape.faces.map((f, i) => [f.label, i] as const));
  const planar = mesh.faces().map((f) => {
    const face = shape.faces[byLabel.get(mesh.labelNames[mesh.fLabel[f] as number] ?? '') ?? -1];
    return face !== undefined && shape.surfaces[face.surface]?.kind === 'plane';
  });
  return meshSurface(
    { ...poly, faces: poly.faces.filter((_, i) => planar[i] === true) },
    { color: CAP_COLOR },
  );
}

function sphereWire(radius: number): SceneLine[] {
  const lines: SceneLine[] = [];
  const color: RGB = [70, 84, 112];
  const STEPS = 48;
  for (let m = 0; m < 12; m++) {
    const lon = (Math.PI * 2 * m) / 12;
    const pts: P3[] = [];
    for (let k = 0; k <= STEPS; k++) {
      const lat = -Math.PI / 2 + (Math.PI * k) / STEPS;
      pts.push([radius * cos(lat) * cos(lon), radius * cos(lat) * sin(lon), radius * sin(lat)]);
    }
    lines.push({ points: pts, color, width: 1 });
  }
  for (const lat of [-1.05, -0.52, 0, 0.52, 1.05]) {
    const pts: P3[] = [];
    for (let k = 0; k <= STEPS; k++) {
      const lon = (Math.PI * 2 * k) / STEPS;
      pts.push([radius * cos(lat) * cos(lon), radius * cos(lat) * sin(lon), radius * sin(lat)]);
    }
    lines.push({ points: pts, color, width: 1 });
  }
  return lines;
}

/** Dashed square outline of a cutting plane, `half` units to each side of `origin` in the plane's own axes. */
function planeOutline(origin: P3, normal: P3, half: number): SceneLine {
  const f = makeFrame(origin, normal);
  const corner = (sx: number, sy: number): P3 => [
    origin[0] + half * (sx * f.x[0] + sy * f.y[0]),
    origin[1] + half * (sx * f.x[1] + sy * f.y[1]),
    origin[2] + half * (sx * f.x[2] + sy * f.y[2]),
  ];
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), corner(-1, -1)];
  return { points: pts, color: PLANE_COLOR, width: 2, dash: [8, 5], xray: true };
}

function countBy(items: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of items) out[k] = (out[k] ?? 0) + 1;
  return out;
}

interface FaceRun {
  readonly face: number;
  readonly status: string;
  readonly branches: number;
  readonly issues: Readonly<Record<string, number>>;
  readonly maxBound: number;
}

interface Section {
  readonly branches: readonly SsiBranch[];
  readonly faces: readonly FaceRun[];
  readonly chains: ReturnType<typeof joinBranches>;
  readonly partial: boolean;
}

/** Marches every NURBS face of the part against one side surface and joins the branches. */
function section(
  faces: readonly { id: number; surface: Nurbs }[],
  side: SsiFace,
  eps: number,
): Section {
  const branches: SsiBranch[] = [];
  const runs: FaceRun[] = [];
  let partial = false;
  for (const f of faces) {
    const r = must(intersectFaces({ surface: f.surface }, side, {}));
    if (r.status !== 'ok') partial = true;
    runs.push({
      face: f.id,
      status: r.status,
      branches: r.branches.length,
      issues: countBy(r.issues.map((i) => i.reason)),
      maxBound: r.branches.reduce((m, b) => Math.max(m, b.bound), 0),
    });
    branches.push(...r.branches);
  }
  return { branches, faces: runs, chains: joinBranches(branches.map(fromSsiBranch), eps), partial };
}

function branchScene(s: Section): Scene {
  const lines: SceneLine[] = [];
  const markers: SceneMarker[] = [];
  s.chains.forEach((chain, ci) => {
    const color = CHAIN_COLORS[ci % CHAIN_COLORS.length] as RGB;
    for (const bi of chain.branches) {
      const b = s.branches[bi] as SsiBranch;
      const pts = b.closed ? [...b.points, b.points[0] as P3] : b.points;
      lines.push({ points: pts, color: [20, 24, 30], width: 6, bias: 3 });
      lines.push({ points: pts, color, width: 3.5, bias: 4 });
    }
    for (const e of chain.ends)
      markers.push({ p: e.point, color: END_COLOR[e.reason] as RGB, radius: 7, ring: false });
  });
  return { tris: [], lines, markers };
}

function chainRow(s: Section): Record<string, unknown>[] {
  return s.chains.map((c) => ({
    branches: c.branches.length,
    closed: c.closed,
    ends: c.ends.map((e) => ({ reason: e.reason, gap: e.gap })),
  }));
}

/** iso and top images of a section scene; every image carries the end-marker legend and its numbers. */
function views(scene: Scene, title: string, line2: string): Record<'iso' | 'top', Image> {
  const out = {} as Record<'iso' | 'top', Image>;
  for (const view of ['iso', 'top'] as const) {
    const image = renderScene(scene, view, { size: SIZE });
    caption(image, [`${title} ${view}`, line2]);
    drawLegend(image, 8, image.height - 76, 'section ends', END_LEGEND, 1);
    out[view] = image;
  }
  return out;
}

const cells: SheetCell[] = [];
function emit(
  id: string,
  scene: Scene,
  title: string,
  line2: string,
  data: Record<string, unknown>,
): void {
  const v = views(scene, title, line2);
  savePng(`ssi/${id}-iso.png`, v.iso);
  savePng(`ssi/${id}-top.png`, v.top);
  record({ row: 'ssi', id, title, ...data });
  cells.push({ image: v.iso, caption: `${id}: ${line2}` });
}

function summarize(s: Section): string {
  const ends = s.chains.flatMap((c) => c.ends.map((e) => e.reason));
  const count = (k: string) => ends.filter((e) => e === k).length;
  return `${s.branches.length} branches, ${s.chains.length} chains (${s.chains.filter((c) => c.closed).length} closed), ends boundary ${count('boundary')} junction ${count('junction')} gap ${count('gap-over-tol')}${s.partial ? ', PARTIAL' : ''}`;
}

// ---- NURBS patch x unit sphere -------------------------------------------------------------------------------------
const sphere: SsiFace = {
  surface: { kind: 'sphere', frame: makeFrame([0, 0, 0], [0, 0, 1]), radius: 1 },
};
const patches: { id: string; label: string; corners: [number, number, number][][] }[] = [
  {
    id: 'patch-sphere-flat',
    label: 'unit patch z=0',
    corners: [
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [1, 1, 0],
      ],
    ],
  },
  {
    id: 'patch-sphere-twisted',
    label: 'twisted bilinear patch 1.2 x 1.2',
    corners: [
      [
        [0, 0, -0.4],
        [0, 1.2, 0.4],
      ],
      [
        [1.2, 0, 0.4],
        [1.2, 1.2, -0.4],
      ],
    ],
  },
];
for (const p of patches) {
  const surface: Nurbs = {
    kind: 'nurbs',
    surface: {
      degreeU: 1,
      degreeV: 1,
      points: p.corners,
      knotsU: [0, 0, 1, 1],
      knotsV: [0, 0, 1, 1],
    },
  };
  const s = section([{ id: 0, surface }], sphere, JOIN_EPS);
  const scene: Scene = {
    tris: tessellateNurbs(surface, SURFACE_COLOR),
    lines: sphereWire(1),
    markers: [],
  };
  const b = branchScene(s);
  emit(
    p.id,
    { tris: scene.tris, lines: [...scene.lines, ...b.lines], markers: b.markers },
    `${p.label} x unit sphere (wire)`,
    summarize(s),
    { part: p.label, side: 'sphere r1', faces: s.faces, chains: chainRow(s), partial: s.partial },
  );
}

// ---- sweep stub and loft flange x planes ---------------------------------------------------------------------------
const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;
const stub = must(
  sweep({
    profile: sq(0.25),
    path: {
      kind: 'circle',
      frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      radius: 4,
    },
    xHint: [0, 0, 1],
    stations: 17,
    range: [0, Math.PI / 2],
  }),
);
const flange = must(
  loft({
    sections: [
      { profile: sq(0.4), frame: makeFrame([0, 0, 0], [0, 0, 1]) },
      { profile: sq(0.4), frame: makeFrame([0, 0, 2], [0, 0, 1]) },
    ],
    mode: 'smooth',
  }),
);

function nurbsFaces(shape: Shape): { id: number; surface: Nurbs }[] {
  const out: { id: number; surface: Nurbs }[] = [];
  shape.faces.forEach((f, id) => {
    const s = shape.surfaces[f.surface];
    if (s !== undefined && s.kind === 'nurbs') out.push({ id, surface: s });
  });
  return out;
}

interface PlaneCase {
  readonly id: string;
  readonly part: 'stub' | 'flange';
  readonly shape: Shape;
  readonly origin: P3;
  readonly normal: P3;
  readonly note: string;
  readonly half: number;
}
const planeCases: PlaneCase[] = [
  {
    id: 'stub-plane-diagonal',
    part: 'stub',
    shape: stub,
    origin: [2.83, 2.83, 0],
    normal: [-Math.SQRT1_2, Math.SQRT1_2, 0],
    note: 'mid-plane across the bend',
    half: 1.4,
  },
  {
    id: 'stub-plane-oblique',
    part: 'stub',
    shape: stub,
    origin: [2.83, 2.83, 0.05],
    normal: [0.3, 0.2, 0.9],
    note: 'oblique plane, open chain',
    half: 1.4,
  },
  {
    id: 'stub-plane-tangent',
    part: 'stub',
    shape: stub,
    origin: [2.83, 2.83, 0.25],
    normal: [0, 0, 1],
    note: 'plane tangent to the top face (partial expected)',
    half: 3.3,
  },
  {
    id: 'flange-plane-mid',
    part: 'flange',
    shape: flange,
    origin: [0, 0, 1],
    normal: [0.3, 0.1, 1],
    note: 'tilted mid-height plane, closed loop',
    half: 0.9,
  },
  {
    id: 'flange-plane-open',
    part: 'flange',
    shape: flange,
    origin: [0.4, 0, 1],
    normal: [1, 0, 0.3],
    note: 'plane along a wall, open chain',
    half: 1.3,
  },
  {
    id: 'flange-plane-corner',
    part: 'flange',
    shape: flange,
    origin: [0.4, 0.4, 1],
    normal: [1, -1, 0.2],
    note: 'plane through a corner edge, two open chains',
    half: 1.2,
  },
];
for (const c of planeCases) {
  const faces = nurbsFaces(c.shape);
  const plane: SsiFace = {
    surface: { kind: 'plane', frame: makeFrame(c.origin, c.normal) },
    bounds: [
      [-12, 12],
      [-12, 12],
    ],
  };
  const s = section(faces, plane, JOIN_EPS);
  const tris = [
    ...faces.flatMap((f) => tessellateNurbs(f.surface, SURFACE_COLOR)),
    ...capTris(c.shape),
  ];
  const b = branchScene(s);
  emit(
    c.id,
    {
      tris,
      lines: [...b.lines, planeOutline(c.origin, c.normal, c.half)],
      markers: b.markers,
    },
    `${c.part} x plane: ${c.note}`,
    summarize(s),
    {
      part: c.part,
      plane: { origin: c.origin, normal: c.normal },
      faces: s.faces,
      chains: chainRow(s),
      partial: s.partial,
      note: 'NURBS walls (blue-grey) and planar end caps (tan) drawn',
    },
  );
}

// ---- end-marker key: junction and gap-over-tol are not produced by the real parts above, so they are shown on a
// synthetic branch set through the same joinBranches call.
const keyBranches: JoinBranch[] = [
  {
    closed: false,
    ends: [
      [0, 0, 0],
      [2, 0, 0],
    ],
    stops: ['boundary', 'near-tangent'],
  },
  {
    closed: false,
    ends: [
      [2, 0, 0],
      [3, 1, 0],
    ],
    stops: ['near-tangent', 'boundary'],
  },
  {
    closed: false,
    ends: [
      [2, 0, 0],
      [3, -1, 0],
    ],
    stops: ['near-tangent', 'boundary'],
  },
  {
    closed: false,
    ends: [
      [0, -3, 0],
      [1, -3, 0],
    ],
    stops: ['boundary', 'step-limit'],
  },
  {
    closed: false,
    ends: [
      [1.001, -3, 0],
      [2, -3, 0],
    ],
    stops: ['step-limit', 'boundary'],
  },
];
const keyChains = joinBranches(keyBranches, JOIN_EPS);
const keyLines: SceneLine[] = [];
const keyMarkers: SceneMarker[] = [];
keyChains.forEach((c, ci) => {
  for (const bi of c.branches) {
    const b = keyBranches[bi] as JoinBranch;
    keyLines.push({
      points: [...b.ends],
      color: CHAIN_COLORS[ci % CHAIN_COLORS.length] as RGB,
      width: 3.5,
    });
  }
  for (const e of c.ends)
    keyMarkers.push({ p: e.point, color: END_COLOR[e.reason] as RGB, radius: 7 });
});
const keyImage = renderScene({ tris: [], lines: keyLines, markers: keyMarkers }, 'top', {
  size: SIZE,
});
caption(keyImage, [
  'SYNTHETIC end-marker key (not a part section)',
  `3 branches meet at one point: junction; 1.001 vs 1.000 break with eps ${JOIN_EPS}: gap over tol`,
]);
drawLegend(keyImage, 8, keyImage.height - 76, 'section ends', END_LEGEND, 1);
savePng('ssi/end-marker-key.png', keyImage);
record({
  row: 'ssi-key',
  id: 'end-marker-key',
  synthetic: true,
  eps: JOIN_EPS,
  chains: keyChains.map((c) => ({
    branches: c.branches.length,
    closed: c.closed,
    ends: c.ends.map((e) => ({ reason: e.reason, gap: e.gap })),
  })),
});
cells.push({
  image: keyImage,
  caption: 'end-marker key (synthetic): junction and gap-over-tol',
});

saveSheet('sheets/ssi-sections.png', cells, {
  columns: 3,
  cell: 460,
  title: 'row 4: NURBS x quadric / plane sections, end reasons colored',
});
finish('rows-ssi');
