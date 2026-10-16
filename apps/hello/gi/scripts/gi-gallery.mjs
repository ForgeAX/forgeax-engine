// Per-scene contact sheets across gather lanes from reference.mjs output folders.
//
//   node scripts/gi-gallery.mjs --root <dir> --scenes cornell,leak,courtyard
//     [--lanes exact,irradiance-field,screen-probe] [--suffix "" | -refl] [--out <dir>]
//
// <root>/<lane><suffix>/ holds one reference.mjs run. Rows: final image, indirect
// only, signed indirect error (red = over, blue = under, saturated at 2x the mean
// reference indirect). Column 0 is the path-traced reference (and its direct).
//
// Energy gate: Sponza is too heavy for the Dawn smoke budget, so its accuracy is
// checked here. The irradiance-field indirect/reference ratio of the Sponza run
// (`metrics.all.ratio`, 7 bounces, 512 px) must lie in [0.9, 1.1]. The
// leak scene's dark room (`metrics.leak.ratio`, the region the Dawn smoke's AC-7
// samples at 64 px) must lie in [0.8, 1.1]. Historical brightness-masked results
// do not qualify the current source. A violation prints FAIL
// and exits 1 after every sheet is written.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contactSheet, luminance, readPfm, toDisplay, toHeatmap, writePng } from './gi-metrics.mjs';
import { optionReader } from './gi-comparison.mjs';

const args = process.argv.slice(2);
const option = optionReader(args);
const ROOT = resolve(option('root'));
const SCENES = option('scenes', 'cornell,leak,courtyard').split(',');
const LANES = option('lanes', 'exact,irradiance-field,screen-probe').split(',');
const SUFFIX = option('suffix', '');
const OUT = resolve(option('out', ROOT));
const SHORT = { exact: 'exact', 'irradiance-field': 'IF', 'screen-probe': 'SP' };
mkdirSync(OUT, { recursive: true });

const ENERGY_GATES = {
  sponza: { 'irradiance-field': { metric: 'all', range: [0.9, 1.1] } },
  leak: { 'irradiance-field': { metric: 'leak', range: [0.8, 1.1] } },
};
const failures = [];
const requested = [];

const meanOf = (rgb) => {
  let sum = 0;
  const n = rgb.length / 3;
  for (let p = 0; p < n; p++) sum += luminance(rgb, p);
  return sum / Math.max(1, n);
};

for (const id of SCENES) {
  const runs = LANES.map((lane) => ({ lane, dir: resolve(ROOT, `${lane}${SUFFIX}`) }));
  for (const run of runs)
    if (!existsSync(resolve(run.dir, `${id}-${run.lane}.pfm`)))
      throw new Error(`missing requested scene/lane ${id}/${run.lane}`);
  const first = runs[0].dir;
  const firstReport = JSON.parse(readFileSync(resolve(first, 'report.json'), 'utf8'));
  const firstScene = firstReport.scenes.find((s) => s.id === id);
  const reference = readPfm(resolve(first, `${id}-reference.pfm`));
  const referenceIndirect = readPfm(resolve(first, `${id}-reference-indirect.pfm`)).rgb;
  const { width, height } = reference;
  const exposure = 0.5 / Math.max(1e-4, meanOf(reference.rgb));
  const indirectMean = Math.max(1e-6, meanOf(referenceIndirect));
  const indirectExposure = 0.5 / indirectMean;
  const finals = [{ label: 'path reference', rgba: toDisplay(reference.rgb, width, height, exposure) }];
  const indirects = [
    { label: 'ref indirect', rgba: toDisplay(referenceIndirect, width, height, indirectExposure) },
  ];
  const errors = [
    {
      label: 'ref direct',
      rgba: toDisplay(readPfm(resolve(first, `${id}-direct.pfm`)).rgb, width, height, exposure),
    },
  ];
  for (const { lane, dir } of runs) {
    const report = JSON.parse(readFileSync(resolve(dir, 'report.json'), 'utf8'));
    const metrics = report.scenes.find((s) => s.id === id)?.metrics;
    if (report.settings.gather !== lane || metrics?.coverageSha256 === undefined ||
        metrics.coverageSha256 !== firstScene?.metrics.coverageSha256 ||
        JSON.stringify(report.provenance) !== JSON.stringify(firstReport.provenance) ||
        ['size', 'frames', 'samples', 'bounces', 'receiver', 'warmup', 'reflections', 'seed'].some(
          (key) => report.settings[key] !== firstReport.settings[key]))
      throw new Error(`unmatched source, window or reference coverage for ${id}/${lane}`);
    const tag = `${SHORT[lane] ?? lane}${SUFFIX === '-refl' ? ' R' : ''}`;
    const gate = ENERGY_GATES[id]?.[lane];
    requested.push(`${id}/${lane}`);
    if (gate !== undefined) {
      const ratio = metrics[gate.metric]?.ratio ?? Number.NaN;
      const pass = ratio >= gate.range[0] && ratio <= gate.range[1];
      console.log(`[gallery] ${pass ? 'PASS' : 'FAIL'} ${id} ${lane} ${gate.metric} indirect ratio ${ratio.toFixed(3)} in [${gate.range.join(', ')}]`);
      if (!pass) failures.push(`${id}/${lane}`);
    }
    const image = readPfm(resolve(dir, `${id}-${lane}.pfm`)).rgb;
    const indirect = readPfm(resolve(dir, `${id}-${lane}-indirect.pfm`)).rgb;
    finals.push({ label: `${tag} E=${metrics.totalRatio.toFixed(3)}`, rgba: toDisplay(image, width, height, exposure) });
    indirects.push({
      label: `${tag} ind ${metrics.all.ratio.toFixed(3)}`,
      rgba: toDisplay(indirect, width, height, indirectExposure),
    });
    errors.push({
      label: `${tag} rmse ${(metrics.all.relativeRmse * 100).toFixed(0)}%`,
      rgba: toHeatmap(indirect, referenceIndirect, width, height, 2 * indirectMean),
    });
  }
  const sheet = contactSheet([finals, indirects, errors], width, height);
  const path = resolve(OUT, `gallery-${id}${SUFFIX}.png`);
  writePng(path, sheet.rgba, sheet.width, sheet.height);
  console.log(`[gallery] ${path}`);
}
if (failures.length > 0) {
  console.error(`[gallery] energy gate failed: ${failures.join(', ')}`);
  process.exit(1);
}
if (requested.length !== SCENES.length * LANES.length) throw new Error('incomplete requested gallery');
