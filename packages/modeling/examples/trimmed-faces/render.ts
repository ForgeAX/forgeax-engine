import { join } from 'node:path';
import type { Shape } from '../../src/brep/types.ts';
import { contactSheet, renderShape, type SheetCell } from '../brep-kit/index.ts';
import { holedPlate, obliqueCylinder, sphereCapWithHole, wavyPatch } from './models.ts';

export function renderTrimmedFaces(outDir: string): void {
  const size = 560;
  const models: { name: string; shape: Shape }[] = [
    { name: 'plate', shape: holedPlate().shape },
    { name: 'cylcap', shape: obliqueCylinder(2.5, 0.6, 1) },
    { name: 'patch', shape: wavyPatch() },
    { name: 'sphere', shape: sphereCapWithHole(50, 0.25).shape },
  ];

  const cells: SheetCell[] = [];
  for (const m of models) {
    const r = renderShape(m.shape, {
      outDir: join(outDir, m.name),
      name: `${m.name}-`,
      size,
      silhouette: false,
      modes: ['shaded', 'iso'],
      iso: { count: 14 },
    });
    if (!r.ok) throw new Error(`${m.name}: ${JSON.stringify(r.error)}`);
    for (const v of r.value.views)
      cells.push({ image: v.image, caption: `${m.name} ${v.mode} ${v.view}` });
  }

  contactSheet(cells, {
    columns: 4,
    cell: 300,
    title: 'Trimmed and NURBS faces: shaded and (u, v) iso network',
    path: join(outDir, 'sheet.png'),
  });
}
