// Small, self-contained integer-flow demo. Run with the modeling package's tsx runner.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { solveIntegerOffsets } from '../../src/quad/integer-flow.ts';
import type { TriMesh } from '../../src/quad/trimesh.ts';
import { contactSheet, renderShape } from '../brep-kit/index.ts';
import { chamferBox, flangedTee } from '../quad-field/models.ts';
import { alignedPositionField } from './aligned-field.ts';

type Point = [number, number, number];

function asPoly(mesh: TriMesh) {
  const positions: Point[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3)
    positions.push([
      mesh.positions[i] as number,
      mesh.positions[i + 1] as number,
      mesh.positions[i + 2] as number,
    ]);
  const faces: number[][] = [];
  for (let i = 0; i < mesh.triangles.length; i += 3)
    faces.push([
      mesh.triangles[i] as number,
      mesh.triangles[i + 1] as number,
      mesh.triangles[i + 2] as number,
    ]);
  return { positions, faces };
}

function main(): void {
  const outDir = resolve(process.argv[2] ?? 'examples/quad-flow/out');
  const renderDir = resolve(outDir, 'renders');
  const cases = [
    { name: 'chamfer-box', mesh: chamferBox() },
    { name: 'flanged-tee', mesh: flangedTee() },
  ];
  const cells = [];
  const metrics = [];
  for (const item of cases) {
    const result = solveIntegerOffsets(alignedPositionField(item.mesh, 0.08, 0.023), {
      maxCapacity: 64,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const render = renderShape(asPoly(item.mesh), {
      outDir: renderDir,
      name: `${item.name}-input-`,
      modes: ['shaded', 'features'],
      views: ['iso'],
    });
    if (!render.ok) throw new Error(JSON.stringify(render.error));
    for (const view of render.value.views)
      cells.push({ image: view.image, caption: `${item.name}: ${view.mode}/${view.view}` });
    metrics.push({
      case: item.name,
      faces: item.mesh.triangles.length / 3,
      integerFlow: result.value.report,
      fieldSource: 'self-generated axis-aligned test field, not a production M4 field',
    });
  }
  contactSheet(cells, {
    columns: 2,
    cell: 384,
    title: 'M5 integer-flow inputs: chamfer box and flanged tee',
    path: resolve(outDir, 'm5-inputs.png'),
  });
  writeFileSync(resolve(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  process.stdout.write(`${resolve(outDir, 'm5-inputs.png')}\n`);
}

main();
