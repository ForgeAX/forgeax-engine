// M-QF5b preview: loop-aligned quad networks of trimmed NURBS faces driven by the constrained field.
// Run: node --experimental-strip-types examples/qf-field/quads.ts [outDir]   (preview, not a final image)
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fieldQuads } from '../../src/quad/field-quads.ts';
import {
  contactSheet,
  drawLegend,
  type Image,
  quadNetwork,
  renderScene,
  toPng,
} from '../brep-kit/index.ts';
import { holedPlate, wavyPatch } from '../trimmed-faces/models.ts';

const OUT = process.argv[2] ?? join(tmpdir(), 'forgeax-qf-m5b');
const cases = {
  'holed-plate': { shape: holedPlate().shape, spacing: 4, views: ['top'] as const },
  'wavy-patch': { shape: wavyPatch(), spacing: 4, views: ['top', 'iso'] as const },
};

mkdirSync(OUT, { recursive: true });
const cells: { image: Image; caption: string }[] = [];
const summary: Record<string, unknown> = {};
for (const [name, c] of Object.entries(cases)) {
  const t0 = performance.now();
  const r = fieldQuads(c.shape, 0, { spacing: c.spacing, rows: 2, fallback: 'triangles' });
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) {
    summary[name] = { error: r.error };
    continue;
  }
  const { report } = r.value;
  const scene = quadNetwork(r.value.mesh);
  for (const view of c.views) {
    const image = renderScene(scene, view, { size: 720 });
    drawLegend(image, 8, 8, `preview: ${name}`, [
      {
        label: `quads ${report.quads}, triangles ${report.triangles}`,
        color: [200, 200, 200],
        style: 'line',
      },
      { label: `min SJ ${report.minSj.toFixed(3)}`, color: [200, 200, 200], style: 'line' },
      { label: 'amber = leftover triangle', color: [255, 176, 0], style: 'line' },
    ]);
    writeFileSync(join(OUT, `${name}-${view}.png`), toPng(image));
    cells.push({
      image,
      caption: `preview ${name} (${view}): ${report.quads} quads + ${report.triangles} tris, minSJ ${report.minSj.toFixed(2)}`,
    });
  }
  summary[name] = { ...report, field: undefined, fieldReport: report.field, runMs: ms };
}
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
writeFileSync(
  join(OUT, 'sheet.png'),
  toPng(
    contactSheet(cells, {
      columns: 2,
      cell: 720,
      title: 'preview: M-QF5b field-guided quad networks',
    }),
  ),
);
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
