import { mkdirSync, writeFileSync } from 'node:fs';
import { EditMesh } from '../../src/mesh.ts';
import { type PatchGrid, patchGrid } from '../../src/quad/patch-grid.ts';
import type { TriMesh } from '../../src/quad/trimesh.ts';
import { renderShape } from '../brep-kit/render.ts';
import { bossBox, bracket, chamferBox } from '../quad-field/models.ts';

const outDir = new URL('../../../../_scratch/viz-out/quad-patch-grid/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

function gridMesh(g: PatchGrid): EditMesh {
  const m = new EditMesh();
  const ids: number[] = [];
  for (let v = 0; v < g.positions.length / 3; v++) {
    ids.push(
      m.addVertex(
        g.positions[3 * v] as number,
        g.positions[3 * v + 1] as number,
        g.positions[3 * v + 2] as number,
      ),
    );
  }
  for (let f = 0; f < g.quads.length / 4; f++) {
    const loop = [0, 1, 2, 3].map((k) => ids[g.quads[4 * f + k] as number] as number);
    m.addFace(loop);
  }
  return m;
}

function unmeshedMesh(mesh: TriMesh, triangles: readonly number[]): EditMesh {
  const m = new EditMesh();
  const map = new Map<number, number>();
  const vid = (v: number): number => {
    let id = map.get(v);
    if (id === undefined) {
      id = m.addVertex(
        mesh.positions[3 * v] as number,
        mesh.positions[3 * v + 1] as number,
        mesh.positions[3 * v + 2] as number,
      );
      map.set(v, id);
    }
    return id;
  };
  for (const f of triangles) {
    m.addFace([0, 1, 2].map((k) => vid(mesh.triangles[3 * f + k] as number)));
  }
  return m;
}

const cases: [string, TriMesh][] = [
  ['chamfer', chamferBox()],
  ['boss', bossBox()],
  ['bracket', bracket()],
];

for (const [id, mesh] of cases) {
  const g = patchGrid(mesh);
  const m = g.metrics;
  const reasons: Record<string, number> = {};
  for (const u of g.unmeshed) reasons[u.detail.reason] = (reasons[u.detail.reason] ?? 0) + 1;

  const tris = [...g.unmeshed.flatMap((u) => u.triangles)];
  const grid = gridMesh(g);
  const hole = unmeshedMesh(mesh, tris);
  const ungridded = renderShape([grid, hole], {
    name: `${id}-grid-`,
    modes: ['shaded', 'network'],
    outDir,
    colorBy: 'part',
    label: false,
  });
  if (!ungridded.ok) {
    continue;
  }
  writeFileSync(
    `${outDir}${id}-summary.json`,
    JSON.stringify({ id, metrics: m, reasons }, null, 2),
  );
}
