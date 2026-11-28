import type { MeshAsset } from '@forgeax/engine-types';
import { bakeMaps } from '../../bake';
import { box as brepBox } from '../../brep/build';
import { measureContinuity } from '../../brep/continuity';
import { type Shape, validate as validateBrep } from '../../brep/index';
import { measure } from '../../brep/measure';
import type { Drawing, DrawingItem } from '../../drawing';
import { checkEdgeFlow } from '../../edge-flow';
import type { Tuple3 } from '../../geom';
import { debugValidate } from '../../invariants';
import { lodTopologyReport } from '../../lod-topology';
import { meshQuality } from '../../mesh-quality';
import { type Model, model } from '../../model';
import { type NurbsSurface, nurbs } from '../../nurbs';
import { sel } from '../../selectors';
import { type ValidateOptions, type ValidationReport, validateMesh } from '../../validate';
import type { FalsifierRow, PendingCheck, Verdict } from './registry';

const fail = (code: string): Verdict => ({ pass: false, codes: [code] });

const closedBox = (): Model => {
  const m = model();
  m.box({ size: [1, 1, 1] });
  return m;
};

const issueCodes = (report: { readonly issues: readonly { readonly code: string }[] }) =>
  report.issues.map((i) => i.code);

const checkCodes = (
  report: { readonly issues: readonly { readonly code: string; readonly detail: object }[] },
  code: string,
) =>
  report.issues
    .filter((i) => i.code === code)
    .map((i) => (i.detail as { check?: string }).check ?? code);

/* ---- validateMesh, Model.validate, Model.validateChecks ---- */

function flippedBox(): Model {
  const m = closedBox();
  m.flip(sel.all());
  return m;
}

function openPlane(): Model {
  const m = model();
  m.plane({ width: 1, height: 1 });
  return m;
}

/* ---- bake cage clip: a 3 cm stamp under a cage that starts above or below its top ---- */

/** The flat 1 m plate z = 0 with uv0 over [0, 1]: the base the cage-clip bake projects onto. */
function bakePlate(): Model {
  const m = model();
  const mesh = m.editMesh;
  const f = mesh.addFace([
    mesh.addVertex(-0.5, -0.5, 0),
    mesh.addVertex(0.5, -0.5, 0),
    mesh.addVertex(0.5, 0.5, 0),
    mesh.addVertex(-0.5, 0.5, 0),
  ]);
  if (!f.ok) throw f.error;
  for (const h of mesh.faceHalves(f.value)) {
    const [x, y] = mesh.position(mesh.hVert[h] as number) as [number, number, number];
    mesh.setCorner('uv0', h, [x + 0.5, y + 0.5]);
  }
  return m;
}

/** A 45 degree frustum stamp, 0.06 m square at its top and 0.03 m high, on a 64 x 64 grid. */
function stampDetail(): Model {
  const n = 64;
  const m = model();
  const mesh = m.editMesh;
  const ids: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const x = -0.5 + i / n;
      const y = -0.5 + j / n;
      const z = Math.max(0, Math.min(0.03, 0.06 - Math.max(Math.abs(x), Math.abs(y))));
      ids.push(mesh.addVertex(x, y, z));
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = ids[j * (n + 1) + i] as number;
      const b = ids[j * (n + 1) + i + 1] as number;
      const c = ids[(j + 1) * (n + 1) + i + 1] as number;
      const d = ids[(j + 1) * (n + 1) + i] as number;
      mesh.addFace([a, b, c]);
      mesh.addFace([a, c, d]);
    }
  return m;
}

/** The bake outcome of the stamp under a cage at `offset` (maxRay 0.1 m, 32 texels). */
function stampBake(offset: number) {
  const r = bakeMaps({
    base: bakePlate(),
    detail: stampDetail(),
    maps: ['normal', 'height'],
    resolution: 32,
    filter: 'none',
    detailNormals: { mode: 'flat' },
    cage: { offset, maxRay: 0.1 },
  });
  if (!r.ok) throw r.error;
  return r.value;
}

type ChecksHost = { validateChecks(options: ValidateOptions): ValidationReport };

/* ---- meshQuality triangle grids ---- */

function grid(width: number, height: number, segments: [number, number]): Model {
  const m = model();
  m.plane({ width, height, widthSegments: segments[0], heightSegments: segments[1] });
  m.triangulate(sel.all());
  return m;
}

const qualityVerdict = (
  r: ReturnType<typeof meshQuality> | ReturnType<Model['meshQuality']>,
): Verdict => {
  if (!r.ok) return fail(r.error.code);
  return { pass: r.value.failed.length === 0, codes: [...r.value.failed] };
};

/* ---- lodTopologyReport ---- */

function meshOf(positions: readonly number[], triangles: readonly number[]): MeshAsset {
  const position = new Float32Array(positions);
  const indices = new Uint32Array(triangles);
  return {
    kind: 'mesh',
    vertices: position,
    indices,
    attributes: { position },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: position.length / 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  } as unknown as MeshAsset;
}

// 3x3 grid on the xz plane, vertex (i, j) = j * 3 + i.
const GRID = Array.from({ length: 9 }, (_, v) => [v % 3, 0, Math.floor(v / 3)]).flat();
const GRID_TRIS = [0, 4, 1, 0, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 8, 4, 8, 5];

/* ---- Model.validateShellClearance: the nose builder of shell-relief ---- */

const SHELL_T = 0.003;
const SHELL_STEP = 0.01;
const SHELL_K = 0.315;

function quad(a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [a, b],
      [c, d],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** The F1 D05 nose shut in miniature, as shell-relief.unit.test.ts builds it, with both parts. */
function nose(gap: number): Model {
  const m = model();
  for (const side of [1, -1]) {
    const name = side > 0 ? 'centre' : 'corner';
    const at = (x: number, y: number, z: number): Tuple3 => [
      x,
      SHELL_K * Math.abs(x) + y,
      -SHELL_K * Math.abs(x) - z,
    ];
    const patches: { name: string; surface: NurbsSurface }[] = [];
    for (let i = 0; i < 6; i++) {
      const [x0, x1] = [i, i + 1].map((j) => side * (gap / 2 + j * SHELL_STEP)) as [number, number];
      const [near, far] = side > 0 ? [x0, x1] : [x1, x0];
      for (let j = 0; j < 4; j++) {
        const [a, b] = [j * SHELL_STEP, (j + 1) * SHELL_STEP];
        patches.push({
          name: `${name}-top-${i}-${j}`,
          surface: quad(at(near, a, 0), at(near, b, 0), at(far, a, 0), at(far, b, 0)),
        });
        patches.push({
          name: `${name}-front-${i}-${j}`,
          surface: quad(at(near, 0, b), at(near, 0, a), at(far, 0, b), at(far, 0, a)),
        });
      }
    }
    if (m.surface({ patches, label: name }).status !== 'ok') throw new Error('nose surface');
  }
  return m;
}

const SHELL_BOTH = sel.createdBy('centre').or(sel.createdBy('corner'));

/* ---- Model.validateDrawings: one silhouette sheet on a unit box ---- */

const square = (h: number): [number, number][] => [
  [-h, -h],
  [h, -h],
  [h, h],
  [-h, h],
];

function silhouetteSheet(h: number): Drawing {
  const item: DrawingItem = {
    id: 'outline',
    view: 'front',
    role: 'silhouette',
    kind: 'curve',
    closed: true,
    curve: { kind: 'polyline', points: square(h) },
    tolerance: 0.005,
  };
  return { name: 'box sheet', views: [{ id: 'front', ortho: 'front' }], items: [item] };
}

function boxWithSheet(h: number): Model {
  const m = model();
  m.box({ size: [1, 1, 1] });
  if (m.drawing(silhouetteSheet(h)).status !== 'ok') throw new Error('drawing');
  return m;
}

/* ---- brep helpers ---- */

function unitBrepBox(): Shape {
  const b = brepBox({ size: [1, 1, 1] });
  if (!b.ok) throw b.error;
  return b.value;
}

/* ---- rows ---- */

export const MESH_ROWS: readonly FalsifierRow[] = [
  {
    check: 'validateMesh',
    pass: () => {
      const r = validateMesh(closedBox().editMesh, 1e-5);
      return { pass: r.pass, codes: issueCodes(r) };
    },
    fail: () => {
      const r = validateMesh(flippedBox().editMesh, 1e-5);
      return { pass: r.pass, codes: issueCodes(r) };
    },
    expect: 'mesh-inverted',
  },
  {
    check: 'debugValidate',
    pass: () => ({
      pass: debugValidate(closedBox().editMesh).length === 0,
      codes: debugValidate(closedBox().editMesh).map((v) => v.code),
    }),
    fail: () => {
      const m = closedBox();
      const mesh = m.editMesh;
      const f = mesh.faces()[0] as number;
      const h = mesh.fHalf[f] as number;
      mesh.hPrev[mesh.hNext[h] as number] = mesh.hNext[h] as number;
      const violations = debugValidate(mesh).map((v) => v.code);
      return { pass: violations.length === 0, codes: violations };
    },
    expect: 'face-loop',
  },
  {
    check: 'Model.validate',
    pass: () => {
      const r = closedBox().validate({ watertight: true });
      return { pass: r.pass, codes: issueCodes(r) };
    },
    fail: () => {
      const r = openPlane().validate({ watertight: true });
      return { pass: r.pass, codes: issueCodes(r) };
    },
    expect: 'mesh-open',
  },
  {
    check: 'Model.validate',
    variant: 'bake-cage-clip',
    pass: () => {
      const r = bakePlate().validate({ bake: { outcome: stampBake(0.05) } });
      return { pass: r.pass, codes: issueCodes(r) };
    },
    fail: () => {
      const r = bakePlate().validate({ bake: { outcome: stampBake(0.01) } });
      return { pass: r.pass, codes: issueCodes(r) };
    },
    expect: 'bake',
  },
  {
    check: 'brep.validate',
    pass: () => {
      const r = validateBrep(unitBrepBox());
      return { pass: r.ok, codes: r.issues.map((i) => i.code) };
    },
    fail: () => {
      const s = JSON.parse(JSON.stringify(unitBrepBox())) as Shape & {
        faces: { reversed: boolean }[];
      };
      for (const f of s.faces) f.reversed = !f.reversed;
      const r = validateBrep(s);
      return { pass: r.ok, codes: r.issues.map((i) => i.code) };
    },
    expect: 'brep-orientation',
  },
  {
    check: 'Model.meshQuality',
    pass: () => qualityVerdict(grid(1, 1, [10, 10]).meshQuality()),
    fail: () => qualityVerdict(grid(10, 1, [10, 10]).meshQuality()),
    expect: 'aspectP50',
  },
  {
    check: 'meshQuality',
    pass: () => {
      const m = grid(1, 1, [10, 10]);
      return qualityVerdict(meshQuality(m.editMesh, m.editMesh.faces()));
    },
    fail: () => {
      const m = grid(10, 1, [10, 10]);
      return qualityVerdict(meshQuality(m.editMesh, m.editMesh.faces()));
    },
    expect: 'aspectP50',
  },
  {
    check: 'lodTopologyReport',
    pass: () => {
      const m = closedBox();
      m.uv.project({ mode: 'box', scale: 1 });
      const out = m.toMesh({ normals: { mode: 'flat' } });
      if (!out.ok) throw out.error;
      const rows = lodTopologyReport([out.value.mesh]);
      const bad = rows.flatMap((r) => [
        ...(r.nonManifoldEdges > 0 ? ['non-manifold-edge'] : []),
        ...(r.boundarySetEqualsLod0 ? [] : ['boundary-set-differs']),
      ]);
      return { pass: bad.length === 0, codes: bad };
    },
    fail: () => {
      const lod0 = meshOf(GRID, GRID_TRIS);
      const lod1 = meshOf(GRID, GRID_TRIS.slice(0, -3));
      const rows = lodTopologyReport([lod0, lod1]);
      const bad = rows.flatMap((r) => [
        ...(r.nonManifoldEdges > 0 ? ['non-manifold-edge'] : []),
        ...(r.boundarySetEqualsLod0 ? [] : ['boundary-set-differs']),
      ]);
      return { pass: bad.length === 0, codes: bad };
    },
    expect: 'boundary-set-differs',
  },
  {
    check: 'Model.auditVisibility',
    pass: () => {
      const m = model();
      m.box({ size: [1, 1, 1], tag: 'form' });
      m.markRole(sel.tag('form'), 'form');
      const r = m.auditVisibility();
      if (!r.ok) throw r.error;
      return { pass: r.value.findings.length === 0, codes: r.value.findings.map((f) => f.code) };
    },
    fail: () => {
      const m = model();
      m.box({ size: [4, 4, 4], tag: 'shell' });
      m.box({ size: [0.4, 0.4, 0.4], center: [0, 0, 0], tag: 'core' });
      m.markRole(sel.tag('core'), 'form');
      const r = m.auditVisibility();
      if (!r.ok) throw r.error;
      return { pass: r.value.findings.length === 0, codes: r.value.findings.map((f) => f.code) };
    },
    expect: 'form-hidden',
  },
  {
    check: 'Model.validateChecks',
    pass: () => {
      const r = (closedBox() as unknown as ChecksHost).validateChecks({});
      return { pass: r.pass, codes: issueCodes(r) };
    },
    fail: () => {
      const r = (flippedBox() as unknown as ChecksHost).validateChecks({});
      return { pass: r.pass, codes: issueCodes(r) };
    },
    expect: 'mesh-inverted',
  },
  {
    check: 'Model.validateEdgeFlow',
    pass: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
      m.featureLine({
        name: 'waist',
        curve: {
          degree: 1,
          points: [
            [-0.5, 0.125, 0],
            [0.5, 0.125, 0],
          ],
          knots: [0, 0, 1, 1],
        },
      });
      const r = m.validate({ edgeFlow: true, strict: ['edge-flow'] });
      return { pass: r.pass, codes: checkCodes(r, 'edge-flow') };
    },
    fail: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
      m.featureLine({
        name: 'shoulder',
        curve: {
          degree: 1,
          points: [
            [-0.5, 0.18, 0],
            [0.5, 0.18, 0],
          ],
          knots: [0, 0, 1, 1],
        },
      });
      const r = m.validate({ edgeFlow: true, strict: ['edge-flow'] });
      return { pass: r.pass, codes: checkCodes(r, 'edge-flow') };
    },
    expect: 'feature-loop',
  },
  {
    check: 'checkEdgeFlow',
    pass: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
      const line = nurbs.interpolate(
        [
          [-0.5, 0.125, 0],
          [0.5, 0.125, 0],
        ],
        { degree: 1 },
      );
      if (!line.ok) throw line.error;
      const r = checkEdgeFlow(m.editMesh, [{ name: 'waist', curve: line.value }]);
      if (!r.ok) return fail(r.error.code);
      return { pass: r.value.pass, codes: r.value.issues.map((i) => i.code) };
    },
    fail: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 8, heightSegments: 8 });
      const line = nurbs.interpolate(
        [
          [-0.5, 0.18, 0],
          [0.5, 0.18, 0],
        ],
        { degree: 1 },
      );
      if (!line.ok) throw line.error;
      const r = checkEdgeFlow(m.editMesh, [{ name: 'shoulder', curve: line.value }]);
      if (!r.ok) return fail(r.error.code);
      return { pass: r.value.pass, codes: r.value.issues.map((i) => i.code) };
    },
    expect: 'feature-loop',
  },
  {
    check: 'Model.validateShellClearance',
    pass: () => {
      const m = nose(0.05);
      if (m.shell(SHELL_BOTH, { thickness: SHELL_T }).status !== 'ok') throw new Error('shell');
      const r = m.validate({ strict: ['thin-wall'] });
      return { pass: r.pass, codes: checkCodes(r, 'thin-wall') };
    },
    fail: () => {
      const m = nose(0.0035);
      if (m.shell(SHELL_BOTH, { thickness: SHELL_T }).status !== 'ok') throw new Error('shell');
      const r = m.validate({ strict: ['thin-wall'] });
      return { pass: r.pass, codes: checkCodes(r, 'thin-wall') };
    },
    expect: 'shell-clearance',
  },
  {
    check: 'Model.validateDrawings',
    pass: () => {
      const r = boxWithSheet(0.5).validate({ drawing: true, strict: ['drawing'] });
      return { pass: r.pass, codes: checkCodes(r, 'drawing') };
    },
    fail: () => {
      const r = boxWithSheet(0.65).validate({ drawing: true, strict: ['drawing'] });
      return { pass: r.pass, codes: checkCodes(r, 'drawing') };
    },
    expect: 'silhouette',
  },
  {
    check: 'brep.measureContinuity',
    pass: () => {
      const r = measureContinuity(unitBrepBox());
      if (!r.ok) return fail(r.error.code);
      return { pass: r.value.counts.open === 0, codes: [] };
    },
    fail: () => {
      const s = JSON.parse(JSON.stringify(unitBrepBox())) as Shape;
      const plane = s.surfaces.find((x) => x.kind === 'plane');
      if (plane === undefined) throw new Error('no plane surface');
      const origin = plane.frame.o as unknown as number[];
      origin[2] = (origin[2] as number) + 0.01;
      const r = measureContinuity(s);
      if (!r.ok) return fail(r.error.code);
      const grades = r.value.edges.filter((e) => e.grade === 'open').map((e) => e.grade);
      return { pass: r.value.counts.open === 0, codes: grades };
    },
    expect: 'open',
  },
  {
    check: 'brep.measure',
    pass: () => {
      const r = measure(unitBrepBox());
      return r.ok ? { pass: true, codes: [] } : fail(r.error.code);
    },
    fail: () => {
      const s = JSON.parse(JSON.stringify(unitBrepBox())) as Shape;
      const face = s.faces[0] as unknown as { loops: number[] };
      face.loops = [];
      const r = measure(s);
      if (r.ok) return { pass: true, codes: [] };
      const brep = (r.error.detail as { brep?: string } | undefined)?.brep;
      return { pass: false, codes: [brep ?? r.error.code] };
    },
    expect: 'brep-orientation',
  },
];

export const MESH_PENDING: readonly PendingCheck[] = [
  {
    check: 'brep.measureTrimmedFace',
    reason: 'Returns raw area/volume/moment numbers with no pass threshold or error code to judge.',
  },
  {
    check: 'checkInvariants',
    reason: 'Global on/off switch for debug checks; its verdict is the debugValidate row.',
  },
];
