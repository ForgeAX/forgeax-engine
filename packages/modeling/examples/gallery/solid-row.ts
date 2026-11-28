// One solid through every quad mode at its own equal element size: the solid row, shaded/feature images, one
// network pair (iso, top) per mode that succeeds, a refusal row per mode that does not, and the mode sheet.
import { measure } from '../../src/brep/measure.ts';
import type { SheetCell } from '../brep-kit/sheet.ts';
import {
  caption,
  metricLine,
  must,
  QUAD_MODES,
  type QuadMode,
  record,
  refusalImage,
  runQuad,
  savePng,
  saveSheet,
} from './common.ts';
import { networkImages, shapeImages } from './render-solid.ts';
import type { Solid } from './solids.ts';

export type BestMode = Record<string, { mode: QuadMode; run: ReturnType<typeof runQuad> }>;

/** Runs and renders one solid; the first successful mode is remembered in `best` for the hero. */
export function solidRow(solid: Solid, best: BestMode): void {
  const faces = solid.shape.faces.length;
  const volume = must(measure(solid.shape)).volume;
  record({ row: 'solid', solid: solid.name, faces, volume, size: solid.size });
  const { shaded, features } = shapeImages(solid.shape);
  caption(shaded, [`${solid.name} ${faces} faces`, 'shaded iso']);
  caption(features, [
    `${solid.name} ${faces} faces`,
    'feature lines iso (convex/concave/boundary)',
  ]);
  savePng(`solids/${solid.name}-shaded-iso.png`, shaded);
  savePng(`solids/${solid.name}-features-iso.png`, features);
  const cells: SheetCell[] = [
    { image: shaded, caption: `${solid.name}: shaded iso, ${faces} faces` },
    { image: features, caption: 'feature lines iso' },
  ];
  const topCells: SheetCell[] = [];
  for (const mode of QUAD_MODES) {
    const run = runQuad(solid.shape, mode, solid.size);
    record({ row: 'quad-mode', solid: solid.name, faces, ...run.row });
    if (run.result === undefined) {
      cells.push({
        image: refusalImage(['REFUSED', String(run.row.reason)]),
        caption: `${mode} size ${solid.size}: REFUSED ${String(run.row.code)} ${String(run.row.reason)}`,
      });
      continue;
    }
    if (best[solid.name] === undefined) best[solid.name] = { mode, run };
    const net = networkImages(run.result);
    for (const view of ['iso', 'top'] as const) {
      const image = net[view];
      if (image === undefined) continue;
      const line = metricLine(run.row);
      caption(image, [`${solid.name} ${mode} size ${solid.size} ${view}`, line]);
      savePng(`quad/${solid.name}-${mode}-network-${view}.png`, image);
      if (view === 'iso') cells.push({ image, caption: `${mode} size ${solid.size}: ${line}` });
      else topCells.push({ image, caption: `${mode} top: ${line}` });
    }
  }
  saveSheet(`sheets/${solid.name}-modes.png`, [...cells, ...topCells], {
    columns: 3,
    cell: 420,
    title: `${solid.name}: quad modes at one element size (${solid.size})`,
  });
}
