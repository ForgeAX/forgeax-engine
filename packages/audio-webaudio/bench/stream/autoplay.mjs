import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { audioImporter } from '../../dist/audio-importer.mjs';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = resolve(root, 'artifacts/audio-stream');
const binding = createStandaloneRuntimeAssetBinding('roi-audio-autoplay');
const pack = pluginPack({ roots: [resolve(output, 'sources')], importers: [audioImporter],
  runtimeBinding: binding, producerReadiness: 'before-consume',
  ddc: { projectDdcRoot: resolve(output, 'ddc-finalizer') } });
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('.', import.meta.url)),
  optimizeDeps: { noDiscovery: true }, plugins: [pack],
  server: { port: 5299, strictPort: true, fs: { allow: [root] } } });
let browser;
const report = { policy: 'document-user-activation-required', cases: [] };
try {
  await server.listen(); await pack.ready();
  browser = await chromium.launch({ ...browserLaunch, headless: true,
    args: [...(browserLaunch.args ?? []).filter(arg => !arg.startsWith('--autoplay-policy=')), '--autoplay-policy=document-user-activation-required'], chromiumSandbox: true});
  report.browser = browser.version();
  for (const stopBeforeGesture of [false, true]) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => { errors.push(String(error)); console.log(String(error)); });
    await page.goto('http://localhost:5299/?autoplay=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    const before = await page.evaluate(() => globalThis.__gatedBefore);
    report.discovery = { before, errors };
    if (!before) throw new Error(`native gated start failed: ${JSON.stringify(errors)}`);
    if (before.audio.contextState !== 'suspended' || before.audio.activeSourceCount !== 0 || before.recordedBlocks !== 0)
      throw new Error('document-activation policy did not suspend native audio before user activation');
    if (stopBeforeGesture) await page.evaluate(() => globalThis.__streamEvidence.gatedStop());
    await page.locator('body').click();
    await page.waitForFunction(stopped => {
      const value = globalThis.__streamEvidence.gatedSample();
      return value.audio.contextState === 'running' && (stopped ? value.audio.activeSourceCount === 0 : value.audio.activeSourceCount === 1 && value.nonzero);
    }, stopBeforeGesture);
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => globalThis.__streamEvidence.gatedSample());
    if (stopBeforeGesture && after.nonzero) throw new Error('gesture resurrected stopped stream');
    if (!stopBeforeGesture) {
      const wav = await page.evaluate(() => globalThis.__streamEvidence.wav());
      await writeFile(resolve(output, 'autoplay-resumed.wav'), new Uint8Array(wav.bytes));
    }
    const disposed = await page.evaluate(() => globalThis.__streamEvidence.gatedDispose());
    if (disposed.activeSourceCount !== 0) throw new Error('dispose retained a stream');
    report.cases.push({ stopBeforeGesture, before, after, disposed });
    await page.close();
  }
  console.log(JSON.stringify(report));
} finally {
  await writeFile(resolve(output, 'autoplay.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server.close();
}
