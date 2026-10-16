import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const destination = resolve(root, 'artifacts/mesh-io/acceptance');
await mkdir(destination, { recursive: true });
await rm(resolve(destination, 'failure.json'), { force: true });
const browser = await chromium.launch({ ...(process.env.FORGEAX_BROWSER_EXECUTABLE ? { executablePath: process.env.FORGEAX_BROWSER_EXECUTABLE } : { channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel }), headless: true, args: process.env.CI && process.platform === 'linux' ? [...browserLaunch.args, '--use-angle=swiftshader', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'], chromiumSandbox: true});
let server;
let cacheDir;
let evidence;
const responses = [];
const responseReads = [];
const errors = [];
const warnings = [];
const navigations = [];
try {
  let url = process.env.MESH_IO_URL;
  if (url === undefined) {
    process.env.NODE_ENV = 'development';
    const appRoot = resolve(root, 'apps/parity/mesh-io');
    cacheDir = await mkdtemp(resolve(tmpdir(), 'forgeax-mesh-io-cold-'));
    server = await createServer({ root: appRoot, cacheDir, configFile: resolve(appRoot, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    url = server.resolvedUrls.local[0];
  }
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on('response', response => { if (response.status() >= 400) responseReads.push(response.text().catch(error=>String(error)).then(body=>responses.push({url:response.url(),status:response.status(),body}))); });
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.type() === 'warning') { warnings.push(message.text()); if (/GPUValidation|validation error|uncaptured.*error|Error creating query set|Invalid (QuerySet|CommandBuffer)|While (validating|encoding)/i.test(message.text())) errors.push(message.text()); } });
  const target = new URL(url);
  if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' && process.env.FIDELITY_ENFORCE_PHYSICAL_BUDGET !== '1') target.searchParams.set('ci-samples', '1');
  await page.goto(target.href);
  await page.waitForFunction(() => window.meshIoEvidence !== undefined);
  evidence = await page.evaluate(() => window.meshIoEvidence);
  await Promise.all(responseReads);
  if (navigations.length !== 1) errors.push(`unexpected page reloads: ${JSON.stringify(navigations)}`);
  // The browser already checked live pixels, fresh-device replay, imported GPU
  // bytes and every missing-draw control. CI retains bulk captures on failure;
  // offline numeric/initialization analysis still needs the source tape, pixels
  // and timings. Only duplicate control tapes and geometry diagnostics are optional.
  const preserveCaptures = !process.env.CI || !evidence.ok || errors.length > 0 || evidence.results.length !== 16;
  if (preserveCaptures) await page.screenshot({ path: resolve(destination, 'gallery.png'), fullPage: true });
  for (const file of evidence.files ?? []) {
    if (!preserveCaptures && /\/(?:missing-draw\.rhitape|geometry-\d+\.(?:vertices|indices))$/.test(file.name)) continue;
    const path = resolve(destination, file.name);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'w');
    try {
      for (let offset = 0; offset < file.byteLength; offset += 1024 * 1024) {
        const chunk = await page.evaluate(({ name, offset }) => window.meshIoReadFile(name, offset), { name: file.name, offset });
        await handle.write(Buffer.from(chunk, 'base64'));
      }
    } finally { await handle.close(); }
  }
  await Promise.all(responseReads);
  if (!evidence.ok) {
    const { files: _files, ...failure } = evidence;
    throw new Error(JSON.stringify({ evidence: failure, errors }));
  }
  if (preserveCaptures) for (const [index,row] of evidence.results.entries()) await page.locator('article').nth(index).screenshot({path:resolve(destination,`${row.id}.png`)});
  const report = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), browser: await browser.version(), measuredAt: new Date().toISOString(), navigations, results: evidence.results, errors, warnings };
  await writeFile(resolve(destination, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (errors.length || evidence.results.length !== 16) throw new Error(JSON.stringify(report));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  await writeFile(resolve(destination, 'failure.json'), `${JSON.stringify({ evidence: evidence === undefined ? undefined : { ...evidence, files: undefined }, error: error instanceof Error ? { ...error, name: error.name, message: error.message, stack: error.stack } : error, errors, warnings, responses, navigations }, null, 2)}\n`);
  throw error;
} finally { await browser.close(); await server?.close(); if (cacheDir !== undefined) await rm(cacheDir, { recursive: true, force: true }); }
