import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { createUiLocalization, refreshUiLocalization } from '../dist/localization/index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
const localization = JSON.parse(await readFile(resolve(root, 'templates/game-3d/assets/guide.ui.i18n.json'), 'utf8'));
const asset = { guid: 'benchmark-ui', html: '', css: '', localization };
const init = [], lookup = [], refresh = [];
const summarize = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
};
let i18n;
for (let n = 0; n < 100; n++) {
  const started = performance.now();
  const opened = await createUiLocalization(asset, { lng: 'fr-CA' });
  if (!opened.ok) throw opened.error;
  init.push(performance.now() - started); i18n = opened.value;
}
// Warm native lookup before collecting the measured samples.
for (let n = 0; n < 10_000; n++) i18n.t('controls');
let checksum = 0;
for (let sample = 0; sample < 25; sample++) {
  const started = performance.now();
  for (let n = 0; n < 20_000; n++) checksum += i18n.t('controls').length;
  lookup.push((performance.now() - started) * 1000 / 20_000);
  const refreshStart = performance.now();
  const refreshed = await refreshUiLocalization(i18n, asset);
  if (!refreshed.ok) throw refreshed.error;
  refresh.push(performance.now() - refreshStart);
}
const size = async (file) => { const bytes = await readFile(file); return { bytes: bytes.length, gzipBytes: gzipSync(bytes).length }; };
const report = {
  hardware: { cpu: cpus()[0].model, platform: platform(), arch: arch(), node: process.version },
  method: { initSamples: 100, warmedLookups: 10_000, lookupSamples: 25, lookupsPerSample: 20_000, checksum },
  initMs: summarize(init), lookupUs: summarize(lookup), refreshMs: summarize(refresh),
  runtimeRoot: await size(resolve(root, 'packages/ui/dist/index.mjs')),
  optInEntry: await size(resolve(root, 'packages/ui/dist/localization/index.mjs')),
  i18nextLibrary: await size(require.resolve('i18next')),
  // i18next remains a direct published dependency, external to the library entry.
  translationPayload: { bytes: Buffer.byteLength(JSON.stringify(localization)), gzipBytes: gzipSync(JSON.stringify(localization)).length },
};
const output = resolve(root, '.forgeax-debug/g09/benchmark.json');
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
