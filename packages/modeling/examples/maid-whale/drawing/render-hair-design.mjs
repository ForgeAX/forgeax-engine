// Sheet HAIR-01 (drawing/hair-design.ts) over a model's hair: the hair's near-side facet
// edges as the measured overlay, rasterised with chrome-headless-shell, plus measureHairDesign.
//   node examples/maid-whale/drawing/render-hair-design.mjs <out-dir> [<model.fxem>] [<chrome-headless-shell>]
// Without a snapshot the G6 model is built. Writes <out-dir>/f2-hair-design-<sha>.{svg,png,json}.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? '.');
const fxem = process.argv[3];
const chrome = process.argv[4] ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell');
mkdirSync(out, { recursive: true });
const sha = execFileSync('git', ['-C', here, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();

const { drawingSvg, model, resolveDrawing } = await import('@forgeax/engine-modeling');
const { HAIR_DESIGN, hairOnly, measureHairDesign } = await import(join(here, 'hair-design.ts'));
const { projectedEdges } = await import(join(here, 'turnaround-structure.ts'));

let m;
if (fxem) {
  m = model();
  m.append(new Uint8Array(readFileSync(fxem)));
} else m = (await import(join(here, '../faceting.ts'))).buildFaceted();
const measure = measureHairDesign(m);
const h = hairOnly(m);
h.drawing(HAIR_DESIGN);
const findings = h
  .validate({ drawing: true })
  .issues.filter((i) => i.code === 'drawing')
  .map((i) => i.detail);
const resolved = resolveDrawing(HAIR_DESIGN);
if (!resolved.ok) throw resolved.error;
const mesh = h.editMesh;
const faces = mesh.faces();
const measured = Object.fromEntries(['front', 'right', 'back', 'top'].map((view) => [view, projectedEdges(mesh, faces, view)]));
const svg = drawingSvg(resolved.value, { measured });
const base = join(out, `f2-hair-design-${sha}`);
writeFileSync(`${base}.svg`, svg);
const width = 3200;
const [, w, hh] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) ?? [];
const height = Math.ceil((width * Number(hh)) / Number(w));
writeFileSync(`${base}.html`, `<!doctype html><html><body style="margin:0;background:#fff"><img src="${pathToFileURL(`${base}.svg`).href}" style="width:${width}px;height:${height}px;display:block"></body></html>`);
execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, `--screenshot=${base}.png`, pathToFileURL(`${base}.html`).href], { stdio: 'inherit' });
writeFileSync(`${base}.json`, `${JSON.stringify({ drawing: HAIR_DESIGN.name, modeling: sha, items: HAIR_DESIGN.items.length, measure, kernelFindings: findings }, null, 1)}\n`);
console.log(JSON.stringify({ iou: measure.iou, lowest: measure.lowest, tips: measure.tips.map((t) => `${t.clump}.${t.tip}:${t.distance.toFixed(3)}`).join(' '), findings: findings.length }));
