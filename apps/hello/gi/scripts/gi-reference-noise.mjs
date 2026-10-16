// Compare independent reference streams on one exact primary-geometry mask.
// Usage: node gi-reference-noise.mjs <candidate-dir> <reference-only-dir> <scene> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contactSheet, indirectMetrics, luminance, readPfm, toDisplay, toHeatmap, writePng } from './gi-metrics.mjs';

if (process.argv.length !== 6) throw new Error('expected candidate directory, independent directory, scene and output directory');
const [candidateDir, independentDir, scene, outDir] = process.argv.slice(2).map((arg, index) => index === 2 ? arg : resolve(arg));
const out = outDir;
mkdirSync(out, { recursive: true });
const reports = [candidateDir, independentDir].map((dir) => JSON.parse(readFileSync(resolve(dir, 'report.json'), 'utf8')));
const [first, second] = reports;
if (first.settings.seed === second.settings.seed ||
    JSON.stringify(first.provenance) !== JSON.stringify(second.provenance) ||
    ['size', 'samples', 'bounces', 'receiver'].some((key) => first.settings[key] !== second.settings[key]))
  throw new Error('independent references require different seeds and matching source/integrator');
const masks = [candidateDir, independentDir].map((dir) => readFileSync(resolve(dir, `${scene}-coverage.bin`)));
if (!masks[0].equals(masks[1])) throw new Error('independent primary coverage differs');
const mask = masks[0];
const references = [candidateDir, independentDir].map((dir) => readPfm(resolve(dir, `${scene}-reference-indirect.pfm`)));
const { width, height } = references[0];
if (width !== references[1].width || height !== references[1].height || mask.length !== width * height)
  throw new Error('independent reference dimensions differ');
const images = references.map((image) => image.rgb);
const candidateImage = readPfm(resolve(candidateDir, `${scene}-${first.settings.gather}-indirect.pfm`));
if (candidateImage.width !== width || candidateImage.height !== height) throw new Error('candidate dimensions differ');
const candidate = candidateImage.rgb;
if ([...images, candidate].some((image) => image.some((value) => !Number.isFinite(value))))
  throw new Error('nonfinite comparison HDR value');
const errors = [];
for (let p = 0; p < mask.length; p++) if (mask[p])
  errors.push(Math.abs(luminance(images[1], p) - luminance(images[0], p)));
errors.sort((a, b) => a - b);
if (errors.length === 0) throw new Error('empty independent reference coverage');
const noise = indirectMetrics(images[1], images[0], mask);
const report = {
  scene, provenance: first.provenance,
  settings: { size: width, samples: first.settings.samples, bounces: first.settings.bounces,
    receiver: first.settings.receiver, seeds: reports.map((r) => r.settings.seed) },
  semantics: 'paired luminance error divided by reference mean; two independent streams are a noise witness, not a statistical confidence interval',
  referenceDifference: noise,
  absoluteErrorPercentiles: Object.fromEntries([0.5, 0.95, 0.99].map((p) => [String(p), errors[Math.min(errors.length - 1, Math.floor(p * errors.length))]])),
  candidateAgainstReferences: images.map((image, index) => ({ seed: reports[index].settings.seed,
    metrics: indirectMetrics(candidate, image, mask) })),
};
writeFileSync(resolve(out, `noise-${scene}.json`), `${JSON.stringify(report, null, 2)}\n`);
const exposure = 0.5 / Math.max(1e-6, noise.referenceMean);
const sheet = contactSheet([[...images.map((image, index) => ({ label: `reference seed ${reports[index].settings.seed}`,
  rgba: toDisplay(image, width, height, exposure) })),
  { label: 'reference difference', rgba: toHeatmap(images[1], images[0], width, height, 2 * Math.max(1e-6, noise.referenceMean)) }]], width, height);
writePng(resolve(out, `noise-${scene}.png`), sheet.rgba, sheet.width, sheet.height);
console.log(JSON.stringify(report));
