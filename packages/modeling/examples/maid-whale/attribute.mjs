// Error attribution of the silhouette difference to parts (level sheet cameras):
//   node examples/maid-whale/attribute.mjs <engine-worktree> <pack> [<out-dir>]
// Each part group renders highlighted: the highlighted pixels are that group's visible
// region. Extra model pixels (outside the reference) belong to the visible group;
// missing pixels (reference only) go to the nearest visible model pixel's group.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePng } from './calibrate/png.mjs';
import { FRAME, rasterize, SCALE, SIZE, subjectMask, VIEWS } from './measure.mjs';

export const GROUPS = {
  hair: "sel.tag('hair').or(sel.tag('ahoge'))",
  headdress: "sel.tag('headdress').or(sel.tag('fin-l')).or(sel.tag('fin-r')).or(sel.tag('ribbon-l')).or(sel.tag('ribbon-r'))",
  head: "sel.tag('head')",
  dress: "sel.tag('dress').or(sel.tag('collar')).or(sel.tag('bowtie')).or(sel.tag('brooch')).or(sel.tag('back-bow'))",
  arms: "sel.tag('arm-l').or(sel.tag('arm-r'))",
  legs: "sel.tag('leg-l').or(sel.tag('leg-r')).or(sel.tag('shoe-l')).or(sel.tag('shoe-r')).or(sel.tag('strap-l')).or(sel.tag('strap-r'))",
  tail: "sel.tag('tail')",
};

export function attribute(engineArg, source) {
  const engine = resolve(engineArg);
  const project = join(engine, 'packages/modeling');
  const ref = JSON.parse(readFileSync(join(project, 'examples/maid-whale/reference.json'), 'utf8'));
  const cli = join(engine, 'packages/engine/dist/bin/forgeax.mjs');
  const [w, h] = SIZE;
  const names = Object.keys(GROUPS);
  const labels = Object.fromEntries(VIEWS.map((v) => [v, new Int8Array(w * h).fill(-1)]));
  for (const [g, name] of names.entries()) {
    const selector = GROUPS[name];
    const args = ['model', 'render', '--source', source, '--views', JSON.stringify(VIEWS), '--annotate', 'false', '--scale', String(SCALE), '--width', String(w), '--height', String(h), '--frame', JSON.stringify(FRAME), '--selector', selector, '--timeout-ms', '600000', '--json'];
    const parsed = JSON.parse(spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', maxBuffer: 256 << 20 }).stdout);
    if (!parsed.ok) throw new Error(`${names[g]}: ${JSON.stringify(parsed.error)}`);
    for (const view of VIEWS) {
      const mask = subjectMask(decodePng(readFileSync(join(project, parsed.value.views.find((v) => v.view === view).image))));
      for (let i = 0; i < mask.length; i++) if (mask[i] === 1) labels[view][i] = g;
    }
  }
  const area = 1 / (SCALE * SCALE);
  const rows = [];
  for (const view of VIEWS) {
    const reference = rasterize(view, ref.views[view].silhouette.points);
    const label = labels[view];
    // Multi-source BFS from every labeled model pixel gives the nearest group.
    const nearest = Int8Array.from(label);
    let frontier = [];
    for (let i = 0; i < label.length; i++) if (label[i] >= 0) frontier.push(i);
    while (frontier.length > 0) {
      const next = [];
      for (const i of frontier) {
        const x = i % w;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (j < 0 || j >= w * h || Math.abs((j % w) - x) > 1 || nearest[j] >= 0) continue;
          nearest[j] = nearest[i];
          next.push(j);
        }
      }
      frontier = next;
    }
    const missing = new Array(names.length).fill(0);
    const extra = new Array(names.length).fill(0);
    let union = 0;
    for (let i = 0; i < reference.length; i++) {
      const m = label[i] >= 0;
      if (m || reference[i] === 1) union++;
      if (reference[i] === 1 && !m) missing[nearest[i]]++;
      if (m && reference[i] === 0) extra[label[i]]++;
    }
    for (const [g, name] of names.entries()) {
      rows.push({ view, part: name, missingM2: missing[g] * area, extraM2: extra[g] * area, iouLoss: (missing[g] + extra[g]) / union });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [engine, source, out] = process.argv.slice(2);
  const rows = attribute(engine, source);
  if (out !== undefined) writeFileSync(join(resolve(out), 'attribution.json'), `${JSON.stringify(rows, null, 2)}\n`);
  const top = [...rows].sort((a, b) => b.iouLoss - a.iouLoss).slice(0, 12);
  for (const r of top) console.log(r.view.padEnd(6), r.part.padEnd(10), `loss ${(r.iouLoss * 100).toFixed(1)}%`, `missing ${(r.missingM2 * 1e4).toFixed(0)} cm2`, `extra ${(r.extraM2 * 1e4).toFixed(0)} cm2`);
}
