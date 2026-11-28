import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure } from '../../src/brep/measure.ts';
import { renderShape } from '../brep-kit/render.ts';
import { buildMeasureCases } from './cases.ts';

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export function renderMeasureExample(outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const rows = buildMeasureCases().map((item, index) => {
    const exact = must(measure(item.shape));
    must(
      renderShape(item.shape, {
        outDir,
        name: `measure-${index}-`,
        size: 384,
        views: ['iso'],
        modes: ['shaded', 'features'],
        legend: 'first',
      }),
    );
    return {
      name: item.name,
      exactArea: exact.area,
      closedFormArea: item.area,
      areaError: exact.area - item.area,
      exactVolume: exact.volume,
      closedFormVolume: item.volume,
      volumeError: exact.volume - item.volume,
      exactCentroid: exact.centroid,
      closedFormCentroid: item.centroid,
    };
  });
  const path = join(outDir, 'measure-table.json');
  writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
  return path;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  const output = process.argv[2] ?? '/tmp/brep-measure';
  process.stdout.write(`${renderMeasureExample(output)}\n`);
}
