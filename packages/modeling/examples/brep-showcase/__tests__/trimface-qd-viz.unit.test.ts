import { expect, it } from 'vitest';
import { booleanSolids } from '../../../src/brep/boolean';
import { box, cylinder } from '../../../src/brep/build';
import { type FaceQuality, type QuadReport, quadrangulate } from '../../../src/brep/quad';
import { renderShape } from '../../brep-kit/index.ts';
import { asPolyMesh, type PolyMesh } from '../../brep-kit/mesh-scene.ts';
import { vizOutputDir } from '../../test-output.ts';
import { buildHousing } from '../housing.ts';

const OUT = vizOutputDir('trimface-qd');
/** Quads must clear this corner-sine floor; dominant mode never admits a flat or folded quad. */
const QUAD_FLOOR = 1e-6;
type P3 = readonly [number, number, number];

function sj(p: readonly P3[]): number {
  const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: P3, b: P3): P3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a: P3) => Math.sqrt(dot(a, a));
  const n0 = cross(sub(p[2] as P3, p[0] as P3), sub(p[3] as P3, p[1] as P3));
  const ln = len(n0);
  if (ln === 0) return 0;
  const normal: P3 = [n0[0] / ln, n0[1] / ln, n0[2] / ln];
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub(p[(i + 1) % 4] as P3, here);
    const d2 = sub(p[(i + 3) % 4] as P3, here);
    const l1 = len(d1);
    const l2 = len(d2);
    if (l1 === 0 || l2 === 0) return 0;
    min = Math.min(min, dot(cross(d1, d2), normal) / (l1 * l2));
  }
  return min;
}

/** Quads coloured by their scaled Jacobian (0 positive, 1 flat, 2 folded); triangles are group 3. */
function coloured(mesh: PolyMesh): PolyMesh {
  const group = mesh.faces.map((f) => {
    if (f.length !== 4) return 3;
    const s = sj(f.map((i) => mesh.positions[i] as P3));
    return s > QUAD_FLOOR ? 0 : s >= 0 ? 1 : 2;
  });
  return { ...mesh, group };
}

function topology(mesh: PolyMesh): { open: number; nonManifold: number } {
  const uses = new Map<string, number>();
  for (const f of mesh.faces)
    for (let k = 0; k < f.length; k++) {
      const a = f[k] as number;
      const b = f[(k + 1) % f.length] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  let open = 0;
  let nonManifold = 0;
  for (const n of uses.values()) {
    if (n === 1) open++;
    else if (n > 2) nonManifold++;
  }
  return { open, nonManifold };
}

interface Part {
  readonly name: string;
  readonly mesh: PolyMesh;
  readonly report: QuadReport;
  readonly faces: readonly FaceQuality[];
}

/** Quadrangulate one shape in dominant mode and check the face-level contract. */
function quadDominant(name: string, shape: unknown, size: number): Part {
  const q = quadrangulate(shape as never, { size, trimmed: 'quad-dominant' });
  if (!q.ok) throw new Error(`${name}: quad-dominant failed ${JSON.stringify(q.error)}`);
  const { report, faceQuality } = q.value;
  expect(report.openEdges).toBe(0);
  expect(report.nonManifoldEdges).toBe(0);
  expect(faceQuality.length).toBeGreaterThan(0);
  for (const f of faceQuality) {
    expect(f.minSj).toBeGreaterThan(QUAD_FLOOR);
    expect(f.foldedPairs).toBe(0);
    expect(f.unresolved).toBe(0);
  }
  const mesh = asPolyMesh(q.value.mesh);
  expect(topology(mesh)).toEqual({ open: 0, nonManifold: 0 });
  return { name, mesh: coloured(mesh), report, faces: faceQuality };
}

it('quad-dominant: box minus cylinder, base flange and top plate meet the contract', () => {
  const block = box({ size: [2.6, 1, 1] });
  const hole = cylinder({ radius: 0.3, height: 3 });
  if (!block.ok || !hole.ok) throw new Error('primitive build failed');
  const d = booleanSolids(block.value, hole.value, 'difference');
  if (!d.ok) throw new Error('boolean failed');
  const parts: Part[] = [quadDominant('box-minus-cylinder', d.value, 0.25)];
  const housing = buildHousing();
  for (const want of ['base flange', 'top plate']) {
    const p = housing.find((h) => h.name === want);
    if (p === undefined) throw new Error(`housing part ${want} missing`);
    parts.push(quadDominant(want, p.shape, 4));
  }
  for (const part of parts) {
    // Coverage: the report's triangle count is the sum over the trimmed faces.
    const fromFaces = part.faces.reduce((n, f) => n + f.triangles, 0);
    expect(fromFaces).toBe(part.report.triangles);
    const rendered = renderShape([part.mesh], {
      outDir: OUT,
      size: 480,
      silhouette: false,
      modes: ['network', 'jacobian'],
      name: `${part.name.replace(/ /g, '-')}-`,
      colorBy: 'face',
    });
    expect(rendered.ok).toBe(true);
  }
});
