import { writeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { meshVolume } from '../../geom';
import { type Model, model } from '../../model';
import { sel } from '../../selectors';
import { filletBox } from '../fillet-box';
import { filletCylinder } from '../fillet-cylinder';
import { filletPrism } from '../fillet-prism';
import { measure } from '../measure';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { boundaryEdges } from './support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const PI = Math.PI;

type Family = 'box' | 'cylinder' | 'prism-square' | 'prism-hexagon';

interface Case {
  readonly family: Family;
  readonly radius: number;
  readonly segments: number;
}

interface Measured {
  readonly volume: number;
  readonly closed: boolean;
}

/** The operators the table reads. The default pair is the real model and exact fillet owners. */
interface Ops {
  readonly meshBevel: (c: Case) => Measured;
  /** Independent export path: signed volume of the toMesh MeshAsset of the same bevelled model. */
  readonly meshExport: (c: Case) => number;
  readonly exactFillet: (c: Case) => number;
}

// Fixed geometry for every row. Box and prism sizes keep 2r below the smallest span;
// the cylinder keeps 2r below the height and r below the radius.
const BOX_SIZE: [number, number, number] = [2, 3, 4];
const CYL = { radius: 2, height: 3, radialSegments: 64 };
const PRISM_SIDE = 2; // square [-1, 1]^2
const PRISM_H = 3;
const HEX_R = 1; // regular hexagon, circumradius 1, side 1, corner turn 60 degrees
const HEX_TAN30 = Math.tan(PI / 6);

const MESH_RATIO_FLOOR = 0.9;

const CASES: readonly Case[] = [
  ...[0.1, 0.25, 0.45].flatMap((radius) =>
    [2, 4, 8].map((segments) => ({ family: 'box' as const, radius, segments })),
  ),
  ...[0.25, 0.5, 1.0].flatMap((radius) =>
    [2, 4, 8].map((segments) => ({ family: 'cylinder' as const, radius, segments })),
  ),
  ...[0.25, 0.5, 0.9].flatMap((radius) =>
    [2, 4, 8].map((segments) => ({ family: 'prism-square' as const, radius, segments })),
  ),
  ...[0.2, 0.4, 0.6].flatMap((radius) =>
    [2, 4, 8].map((segments) => ({ family: 'prism-hexagon' as const, radius, segments })),
  ),
];

/** Mesh bevel width that yields a tangent distance r on a 90 degree corner; hexagon corners turn 60 degrees, so t = r tan(30 degrees). */
function meshWidth(c: Case): number {
  return c.family === 'prism-hexagon' ? c.radius * HEX_TAN30 : c.radius;
}

function hexagon(): [number, number][] {
  return Array.from({ length: 6 }, (_, k): [number, number] => [
    Math.cos((k * PI) / 3) * HEX_R,
    Math.sin((k * PI) / 3) * HEX_R,
  ]);
}

const SQUARE: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

function buildMesh(c: Case): Model {
  const m = model();
  if (c.family === 'box') {
    m.box({ size: BOX_SIZE });
    m.bevel(sel.edges.all(), { width: meshWidth(c), segments: c.segments, label: 'x5' });
  } else if (c.family === 'cylinder') {
    m.cylinder({
      radiusTop: CYL.radius,
      radiusBottom: CYL.radius,
      height: CYL.height,
      radialSegments: CYL.radialSegments,
    });
    m.bevel(sel.edges.dihedral('>', 30), {
      width: meshWidth(c),
      segments: c.segments,
      label: 'x5',
    });
  } else {
    const points = c.family === 'prism-square' ? SQUARE : hexagon();
    m.extrudePolygon({ points, depth: PRISM_H });
    m.bevel(sel.edges.parallel('z'), { width: meshWidth(c), segments: c.segments, label: 'x5' });
  }
  return m;
}

function buildExact(c: Case): Shape {
  if (c.family === 'box') {
    return must(filletBox({ size: BOX_SIZE, radius: c.radius }));
  }
  if (c.family === 'cylinder') {
    return must(filletCylinder({ radius: CYL.radius, height: CYL.height, fillet: c.radius }));
  }
  const profile = c.family === 'prism-square' ? SQUARE : hexagon();
  const n = profile.length;
  return must(filletPrism({ profile, height: PRISM_H, radii: Array(n).fill(c.radius) }));
}

/** Closed-form volume of the exact fillet, derived independently of the kernel. */
function closedForm(c: Case): number {
  if (c.family === 'box') {
    const [a, b, d] = BOX_SIZE.map((s) => s - 2 * c.radius) as [number, number, number];
    const r = c.radius;
    return (
      a * b * d +
      2 * r * (a * b + b * d + a * d) +
      PI * r * r * (a + b + d) +
      (4 / 3) * PI * r * r * r
    );
  }
  if (c.family === 'cylinder') {
    const R = CYL.radius;
    const H = CYL.height;
    const r = c.radius;
    const a = R - r;
    const corner = a * r * r * (1 - PI / 4) + (r * r * r) / 6;
    return PI * R * R * H - 2 * 2 * PI * corner;
  }
  if (c.family === 'prism-square') {
    // Each 90 degree corner removes r^2 (tan(45) - 45 degrees in radians) = r^2 (1 - pi/4).
    const area = PRISM_SIDE * PRISM_SIDE - 4 * c.radius * c.radius * (1 - PI / 4);
    return area * PRISM_H;
  }
  // Each 60 degree corner removes r^2 (tan(30) - pi/6); sharp hexagon area is 3 sqrt(3) / 2.
  const area = (3 * Math.sqrt(3)) / 2 - 6 * c.radius * c.radius * (HEX_TAN30 - PI / 6);
  return area * PRISM_H;
}

/** Signed volume of an export MeshAsset, computed from its position attribute and index buffer. */
function exportVolume(m: Model): number {
  m.uv.project({ mode: 'box', scale: 1 });
  const out = must(m.toMesh());
  const { mesh } = out;
  const pos = mesh.attributes.position;
  if (!(pos instanceof Float32Array))
    throw new Error('export position attribute is not Float32Array');
  const idx = mesh.indices ?? Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  const at = (k: number): number => pos[k] ?? Number.NaN;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = (idx[t] ?? 0) * 3;
    const b = (idx[t + 1] ?? 0) * 3;
    const c = (idx[t + 2] ?? 0) * 3;
    v +=
      (at(a) * (at(b + 1) * at(c + 2) - at(b + 2) * at(c + 1)) -
        at(a + 1) * (at(b) * at(c + 2) - at(b + 2) * at(c)) +
        at(a + 2) * (at(b) * at(c + 1) - at(b + 1) * at(c))) /
      6;
  }
  return v;
}

const realOps: Ops = {
  meshBevel(c) {
    const report = buildMesh(c).validate();
    return { volume: report.volume, closed: report.closed };
  },
  meshExport(c) {
    return exportVolume(buildMesh(c));
  },
  exactFillet(c) {
    return must(measure(buildExact(c))).volume;
  },
};

interface Row {
  readonly family: Family;
  readonly radius: number;
  readonly segments: number;
  readonly mesh: number;
  readonly exact: number;
  readonly ratio: number;
  readonly closed: boolean;
}

/** Builds the volume-ratio table from the operators. Throws if the exact side disagrees with closed forms. */
function buildTable(cases: readonly Case[], ops: Ops): Row[] {
  return cases.map((c) => {
    const exact = ops.exactFillet(c);
    const want = closedForm(c);
    if (!(Math.abs(exact - want) <= 1e-9 * Math.max(1, Math.abs(want)))) {
      throw new Error(
        `exact fillet ${c.family} r=${c.radius} disagrees with closed form: ${exact} vs ${want}`,
      );
    }
    const mesh = ops.meshBevel(c);
    const exported = ops.meshExport(c);
    if (!(Math.abs(exported - mesh.volume) <= 1e-4 * Math.max(1, Math.abs(mesh.volume)))) {
      throw new Error(
        `mesh export ${c.family} r=${c.radius} seg=${c.segments} disagrees with validate: ${exported} vs ${mesh.volume}`,
      );
    }
    const ratio = mesh.volume / exact;
    // An inscribed polygon removes material, so the mesh never exceeds the exact fillet. The lower
    // bound is a plausibility band set below the worst measured row (0.923, r=0.9, 2 segments);
    // so a mocked constant mesh side that the closed-form check cannot see is still rejected.
    if (!(ratio <= 1 + 1e-9 && ratio >= MESH_RATIO_FLOOR)) {
      throw new Error(
        `mesh bevel ${c.family} r=${c.radius} seg=${c.segments} ratio ${ratio} outside [${MESH_RATIO_FLOOR}, 1]`,
      );
    }
    return {
      family: c.family,
      radius: c.radius,
      segments: c.segments,
      mesh: mesh.volume,
      exact,
      ratio,
      closed: mesh.closed,
    };
  });
}

function formatTable(rows: readonly Row[]): string {
  const head = 'family        r      seg  mesh-volume    exact-volume   ratio    closed';
  const body = rows.map(
    (r) =>
      `${r.family.padEnd(13)} ${r.radius.toFixed(2).padStart(5)} ${String(r.segments).padStart(4)}  ${r.mesh.toFixed(4).padStart(11)}  ${r.exact.toFixed(4).padStart(13)}  ${r.ratio.toFixed(5)}  ${String(r.closed)}`,
  );
  const notMeasured = [
    'box per-axis widths (X/Y/Z edges different)  NOT MEASURED: exact filletBox takes one radius',
    'prism mixed-radius corners                    NOT MEASURED: exact filletPrism takes per-vertex radii, but this report does not build per-vertex mesh widths (no single-vertical-edge selector used)',
    'cylinder mesh base is a 64-gon while the exact reference is a true circle: the uncut 64-gon alone gives volume ratio n/(2 pi) sin(2 pi/n) = 0.99839, so cylinder ratios sit below 1 partly from polygonization',
  ];
  return [
    'x5 bevel vs exact fillet volume-ratio table (relative ratios only)',
    head,
    ...body,
    ...notMeasured,
  ].join('\n');
}

describe('X5 mesh bevel vs exact fillet agreement report', () => {
  const rows = buildTable(CASES, realOps);

  it('builds every row from real operators, each mesh bevel closed', () => {
    expect(rows).toHaveLength(CASES.length);
    for (const r of rows) {
      expect(r.closed).toBe(true);
      expect(Number.isFinite(r.ratio)).toBe(true);
    }
  });

  it('prints the volume-ratio table', () => {
    writeSync(1, `${formatTable(rows)}\n`);
  });

  it('exact fillet volume matches the closed form for each row', () => {
    for (const c of CASES) {
      const exact = realOps.exactFillet(c);
      expect(Math.abs(exact - closedForm(c))).toBeLessThan(1e-9 * Math.max(1, closedForm(c)));
    }
  });

  it('cylinder rim selection picks exactly the 2 x 64 rim edges, no cap or side edges', () => {
    const m = model();
    m.cylinder({
      radiusTop: CYL.radius,
      radiusBottom: CYL.radius,
      height: CYL.height,
      radialSegments: CYL.radialSegments,
    });
    expect(m.count(sel.edges.dihedral('>', 30))).toBe(2 * CYL.radialSegments);
  });

  it('mesh ratio is non-decreasing in segment count for each family and radius', () => {
    const byKey = new Map<string, Row[]>();
    for (const r of rows) {
      const key = `${r.family}:${r.radius}`;
      byKey.set(key, [...(byKey.get(key) ?? []), r]);
    }
    for (const group of byKey.values()) {
      const ratios = [...group].sort((a, b) => a.segments - b.segments).map((r) => r.ratio);
      ratios.slice(1).forEach((ratio, i) => {
        expect(ratio).toBeGreaterThanOrEqual((ratios[i] ?? Number.NaN) - 1e-9);
      });
    }
  });

  it('exact side cross-check: tessellation is watertight and its volume tracks measure', () => {
    for (const c of CASES) {
      const shape = buildExact(c);
      const t = must(tessellate(shape, { angle: 0.01 }));
      expect(boundaryEdges(t)).toBe(0);
      const tessVolume = Math.abs(meshVolume(t));
      const exact = realOps.exactFillet(c);
      expect(Math.abs(tessVolume - exact) / exact).toBeLessThan(2e-3);
    }
  });

  it('mesh side cross-check: validate volume matches the exported MeshAsset volume', () => {
    expect(() => buildTable(CASES, realOps)).not.toThrow();
  });
});

describe('X5 falsifier: a table built from mocked volumes is rejected', () => {
  it('the real operators pass the closed-form check (control)', () => {
    expect(() => buildTable(CASES, realOps)).not.toThrow();
  });

  it('constant mocked operators are rejected by the closed-form check', () => {
    const mocked: Ops = {
      meshBevel: () => ({ volume: 1, closed: true }),
      meshExport: () => 1,
      exactFillet: () => 1,
    };
    expect(() => buildTable(CASES, mocked)).toThrow(/disagrees with closed form/);
  });

  it('a mesh side that is only a constant with a matching export is rejected by the ratio band', () => {
    const mockedMesh: Ops = {
      meshBevel: () => ({ volume: 1, closed: true }),
      meshExport: () => 1,
      exactFillet: realOps.exactFillet,
    };
    expect(() => buildTable(CASES, mockedMesh)).toThrow(/outside \[0\.9, 1\]/);
  });

  it('a mesh side that over-removes material is rejected by the ratio band', () => {
    const scaled: Ops = {
      meshBevel: (c) => ({ volume: realOps.meshBevel(c).volume * 0.5, closed: true }),
      meshExport: (c) => realOps.meshExport(c) * 0.5,
      exactFillet: realOps.exactFillet,
    };
    expect(() => buildTable(CASES, scaled)).toThrow(/outside/);
  });

  it('a mocked export that disagrees with validate is rejected', () => {
    const mockedExport: Ops = {
      meshBevel: realOps.meshBevel,
      meshExport: () => 0,
      exactFillet: realOps.exactFillet,
    };
    expect(() => buildTable(CASES, mockedExport)).toThrow(/mesh export/);
  });
});
