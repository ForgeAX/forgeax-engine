import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    out: { type: 'string' },
    playwright: { type: 'string' },
    chrome: { type: 'string' },
    backend: { type: 'string' },
    'skip-cpu-reference': { type: 'boolean', default: false },
    'include-composite': { type: 'boolean', default: false },
    performance: { type: 'boolean', default: false },
    'cpu-profile': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  },
});
const usage =
  'node run_ui_gpu_benchmark.mjs --root BUILT_DIRECTORY --out NEW_DIRECTORY --playwright PLAYWRIGHT_ENTRY --chrome CHROME_EXECUTABLE --backend webgpu|wgpu-webgl2 [--skip-cpu-reference] [--include-composite] [--performance | --cpu-profile]';
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.root || !values.out || !values.playwright || !values.chrome) throw Error(usage);
if (!['webgpu', 'wgpu-webgl2'].includes(values.backend)) throw Error(usage);
if (values.performance && values['cpu-profile'])
  throw Error('CPU profiling is a diagnostic mode; use a separate uninstrumented --performance run for acceptance');
const { chromium } = await import(pathToFileURL(resolve(values.playwright)).href);
const root = resolve(values.root),
  out = resolve(values.out);
const inputs = JSON.parse(await readFile(join(root, 'inputs.json'), 'utf8'));
if (inputs.backend !== values.backend)
  throw Error('Requested backend differs from benchmark build');
for (const [name, expected] of Object.entries(inputs.files)) {
  const bytes = await readFile(join(root, name));
  if (
    bytes.length !== expected.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw Error(`Benchmark input differs from its recorded identity: ${name}`);
}
await mkdir(out);
const result = {
  startedAtUtc: new Date().toISOString(),
  kind: 'ui-gpu-owner-benchmark',
  mode: values['cpu-profile'] ? 'cpu-profile' : values.performance ? 'performance' : 'correctness',
  runnerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  chromiumSandbox: true,
  viewport: { width: 844, height: 390, deviceScaleFactor: 3 },
  inputs,
  backend: values.backend,
  cpuReference: !values['skip-cpu-reference'],
  includeComposite: values['include-composite'],
  errors: [],
  steps: [],
};
if (values['cpu-profile'])
  result.cpuProfile = {
    samplingIntervalUs: 1000,
    scope: 'CPU attribution only; instrumented results do not qualify GPU time or an uninstrumented FPS budget.',
  };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (name.includes('..')) throw Error('bad path');
    const bytes = await readFile(join(root, name));
    res
      .writeHead(200, {
        'content-type':
          { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }[
            extname(name)
          ] ?? 'application/octet-stream',
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser, page, profiler;
async function stopProfile(name) {
  const session = profiler;
  profiler = undefined;
  try {
    const { profile } = await session.send('Profiler.stop');
    result.profileEndedAtUtc = new Date().toISOString();
    await writeFile(join(out, name), JSON.stringify(profile));
  } finally {
    try {
      await session.send('Profiler.disable');
    } finally {
      await session.detach();
    }
  }
}
try {
  browser = await chromium.launch({
    executablePath: resolve(values.chrome),
    headless: true,
    args: ['--disable-features=MacAppCodeSignClone'],
    chromiumSandbox: true,
  });
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    reducedMotion: 'no-preference',
  });
  page = await context.newPage();
  page.on('pageerror', (error) => result.errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => !!window.nativeUiProbe);
  for (const method of [
    'initialize',
    'active',
    'form',
    ...(values.performance || values['cpu-profile']
      ? [
          'performance',
          ...(values.performance && values['include-composite'] ? ['cachedPerformance', 'backgroundControl'] : []),
        ]
      : []),
  ]) {
    const startedAtUtc = new Date().toISOString();
    console.log('start', method, startedAtUtc);
    if (values['cpu-profile'] && method === 'performance') {
      profiler = await context.newCDPSession(page);
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.setSamplingInterval', { interval: 1000 });
      result.profileStartedAtUtc = new Date().toISOString();
      await profiler.send('Profiler.start');
    }
    const value = await page.evaluate(
      ({ method, backend, cpuReference, includeComposite }) =>
        window.nativeUiProbe[method]({ backend, cpuReference, includeComposite }),
      {
        method,
        backend: values.backend,
        cpuReference: !values['skip-cpu-reference'],
        includeComposite: values['include-composite'],
      },
    );
    if (profiler) await stopProfile('profile.cpuprofile');
    result.steps.push({ method, startedAtUtc, endedAtUtc: new Date().toISOString(), value });
    await writeFile(join(out, 'progress.json'), JSON.stringify(result, null, 2));
    if (['initialize', 'active', 'form'].includes(method))
      await page.screenshot({ path: join(out, `${method}.png`) });
    const { receipts, ...summary } = value;
    console.log('done', method, JSON.stringify(summary));
  }
  result.ok =
    result.errors.length === 0 &&
    ['initialize', 'active', 'form'].every((method) =>
      result.steps.some((step) => step.method === method),
    );
  if (values.performance)
    result.ok &&= result.steps.find((step) => step.method === 'performance')?.value.pass === true;
  if (values['cpu-profile']) {
    const measured = result.steps.find((step) => step.method === 'performance')?.value;
    result.ok &&= measured?.frames === 60 && measured.movementIntentCount === 60 && measured.rasterPasses === 60;
  }
  if (values.performance && values['include-composite'])
    result.ok &&= ['cachedPerformance', 'backgroundControl'].every(
      (method) => result.steps.find((step) => step.method === method)?.value.pass === true,
    );
} catch (error) {
  result.ok = false;
  result.failure = String(error);
  console.error(result.failure);
} finally {
  if (profiler) {
    try {
      await stopProfile('failed-profile.cpuprofile');
    } catch (error) {
      result.profileCleanupFailure = String(error);
      result.ok = false;
    }
  }
  if (page) {
    result.facts = await page
      .evaluate(() => window.nativeUiProbe?.dispose())
      .catch((error) => ({ cleanupFailure: String(error) }));
    if (!result.facts || result.facts.cleanupFailure) result.ok = false;
  }
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  result.endedAtUtc = new Date().toISOString();
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
}
process.exitCode = result.ok ? 0 : 1;
