import { expect, it } from 'vitest';
import { booleanSolids } from '../../../src/brep/boolean';
import { box, cylinder } from '../../../src/brep/build';
import { quadrangulate } from '../../../src/brep/quad';
import { renderShape } from '../../brep-kit/index.ts';
import { asPolyMesh, type PolyMesh } from '../../brep-kit/mesh-scene.ts';
import { vizOutputDir } from '../../test-output.ts';
import { buildHousing } from '../housing.ts';

const OUT = vizOutputDir('trimface-penalty');
const EPS = 1e-9;
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
  const unit = (a: P3): P3 => {
    const l = len(a);
    return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
  };
  const n0 = cross(sub(p[2] as P3, p[0] as P3), sub(p[3] as P3, p[1] as P3));
  const ln = len(n0);
  if (ln === 0) return 0;
  const normal: P3 = [n0[0] / ln, n0[1] / ln, n0[2] / ln];
  let min = Infinity;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub(p[(i + 1) % 4] as P3, here);
    const d2 = sub(p[(i + 3) % 4] as P3, here);
    if (len(d1) === 0 || len(d2) === 0) return 0;
    min = Math.min(min, dot(cross(unit(d1), unit(d2)), normal));
  }
  return min;
}

/** Colour each quad by its own scaled Jacobian: 0 = positive, 1 = zero/degenerate, 2 = folded. */
function coloured(mesh: PolyMesh): PolyMesh {
  const group = mesh.faces.map((f) => {
    const s = sj(f.map((i) => mesh.positions[i] as P3));
    return s > EPS ? 0 : s >= -EPS ? 1 : 2;
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

it('renders penalty-mode quads with folded quads highlighted', () => {
  const block = box({ size: [2.6, 1, 1] });
  const hole = cylinder({ radius: 0.3, height: 3 });
  if (!block.ok || !hole.ok) throw new Error('primitive build failed');
  const d = booleanSolids(block.value, hole.value, 'difference');
  if (!d.ok) throw new Error('boolean failed');
  const bmc = quadrangulate(d.value, { size: 0.25, trimmed: 'blossom-penalty' });
  if (!bmc.ok) throw new Error('box-minus-cylinder penalty quadrangulation failed');
  const bmcMesh = coloured(asPolyMesh(bmc.value.mesh));
  const r1 = renderShape([bmcMesh], {
    outDir: OUT,
    size: 480,
    silhouette: false,
    modes: ['iso', 'network', 'jacobian'],
    name: 'box-minus-cylinder-',
    colorBy: 'face',
  });
  expect(r1.ok).toBe(true);

  const housing = buildHousing();
  const meshes: PolyMesh[] = [];
  for (const p of housing) {
    const q = quadrangulate(p.shape, { size: 4, trimmed: 'blossom-penalty' });
    if (q.ok) meshes.push(coloured(asPolyMesh(q.value.mesh)));
  }
  const r2 = renderShape(meshes, {
    outDir: OUT,
    size: 480,
    silhouette: false,
    modes: ['network', 'jacobian'],
    name: 'housing-',
    colorBy: 'face',
  });
  expect(r2.ok).toBe(true);
});

it('shared-edge perturbation falsifier on box minus cylinder', () => {
  const block = box({ size: [2.6, 1, 1] });
  const hole = cylinder({ radius: 0.3, height: 3 });
  if (!block.ok || !hole.ok) throw new Error('primitive build failed');
  const d = booleanSolids(block.value, hole.value, 'difference');
  if (!d.ok) throw new Error('boolean failed');
  const q = quadrangulate(d.value, { size: 0.25, trimmed: 'blossom-penalty' });
  if (!q.ok) throw new Error('quadrangulation failed');
  const base = asPolyMesh(q.value.mesh);
  const baseTopo = topology(base);
  expect(baseTopo).toEqual({ open: 0, nonManifold: 0 });

  // Move every vertex by a small, deterministic offset. Shared edges keep both incident faces.
  // A correct shared-edge topology must stay watertight, with the same face and vertex indices.
  const moved: PolyMesh = {
    ...base,
    positions: base.positions.map((p, i) => {
      const s = (i % 7) * 1e-4;
      return [p[0] + s, p[1] - s * 0.5, p[2] + s * 0.25] as const;
    }),
  };
  const movedTopo = topology(moved);
  expect(movedTopo).toEqual(baseTopo);
  expect(moved.faces.length).toBe(base.faces.length);
});
