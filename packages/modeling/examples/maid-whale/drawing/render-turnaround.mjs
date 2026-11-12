// Case C-200 turnaround with structure lines and the G6 facet plan (drawing/turnaround-structure.ts),
// rendered over the current G6 model: every near-side facet edge of the model as the sheet's
// measured overlay (grey) under the drawing, rasterised with chrome-headless-shell, plus the
// numbers (silhouette IoU per view, facet edges along each unit and plane-change line).
//   node examples/maid-whale/drawing/render-turnaround.mjs <out-dir> [<chrome-headless-shell>]
// Writes <out-dir>/f2-turnaround-<sha>.{svg,png,json}; <sha> is this repository's HEAD.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? '.');
const chrome = process.argv[3] ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell');
mkdirSync(out, { recursive: true });
const sha = execFileSync('git', ['-C', here, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();

const { drawingSvg, resolveDrawing } = await import('@forgeax/engine-modeling');
const { buildFaceted } = await import(join(here, '../faceting.ts'));
const { measureTurnaroundStructure, projectedEdges, TURNAROUND_STRUCTURE } = await import(join(here, 'turnaround-structure.ts'));

const started = Date.now();
const m = buildFaceted();
const built = Date.now() - started;
const measure = measureTurnaroundStructure(m);
m.drawing(TURNAROUND_STRUCTURE);
const findings = m
  .validate({ drawing: true })
  .issues.filter((i) => i.code === 'drawing')
  .map((i) => i.detail);

const resolved = resolveDrawing(TURNAROUND_STRUCTURE);
if (!resolved.ok) throw resolved.error;
const mesh = m.editMesh;
const all = mesh.faces();
const measured = Object.fromEntries(['front', 'right', 'back'].map((view) => [view, projectedEdges(mesh, all, view)]));
const svg = drawingSvg(resolved.value, { measured });
const base = join(out, `f2-turnaround-${sha}`);
writeFileSync(`${base}.svg`, svg);

const width = 3200;
const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) ?? [];
const height = Math.ceil((width * Number(h)) / Number(w));
const html = `${base}.html`;
writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#fff"><img src="${pathToFileURL(`${base}.svg`).href}" style="width:${width}px;height:${height}px;display:block"></body></html>`);
execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, `--screenshot=${base}.png`, pathToFileURL(html).href], { stdio: 'inherit' });

const summary = {
  case: 'C-200',
  drawing: TURNAROUND_STRUCTURE.name,
  modeling: sha,
  buildMs: built,
  triangles: all.length,
  silhouetteIoU: measure.iou,
  units: measure.units,
  planes: measure.planes,
  kernelFindings: {
    total: findings.length,
    byCheck: findings.reduce((acc, f) => ({ ...acc, [f.check]: (acc[f.check] ?? 0) + 1 }), {}),
    silhouette: findings.filter((f) => f.check === 'silhouette'),
    featureWithoutSessionLine: findings.filter((f) => f.check === 'feature' && f.max === undefined).length,
    dimension: findings.filter((f) => f.check === 'dimension'),
  },
  method: {
    iou: 'silhouetteIoU at 5 mm cells: the sheet silhouette (reference.json) against the model projection',
    along: 'a facet edge of the unit (near side, ignoring occlusion) within 4 mm and 25 deg of a drawn sample, every 5 mm; p50/p90 = distance to the nearest parallel edge within 5 cm',
  },
};
writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify({ png: `${base}.png`, iou: measure.iou, findings: summary.kernelFindings.byCheck }));
