#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const { values } = parseArgs({ options: {
  root: { type: 'string' }, out: { type: 'string' }, chrome: { type: 'string' }, playwright: { type: 'string' },
  mode: { type: 'string', default: 'all' }, software: { type: 'boolean', default: false }, 'tool-verification': { type: 'boolean', default: false }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node run_game_scene_profile.mjs --root PREPARED_DIRECTORY --out NEW_DIRECTORY --chrome CHROME --playwright MODULE [--mode all|cpu|gpu|control|receipts] [--tool-verification [--software]]\nPrepared ordinaryEffects Browser scene only; no frontend UI or recorder. CPU/control use the real App loop. GPU queries use a separate paused submission lane. Receipts compares disabled/enabled/disabled submission callbacks and requires a receiptObservation-enabled entry. Default measurement retains 60 frames. Tool verification uses five frames after the original 60-frame warmup and makes no FPS claim. Root operator must qualify fresh host headroom.');
  process.exit(0);
}
assert.ok(values.root && values.out && values.chrome && values.playwright, 'root, out, chrome and playwright are required');
assert.ok(['all', 'cpu', 'gpu', 'control', 'receipts'].includes(values.mode));
assert.ok(!values.software || values['tool-verification'], 'Software driver requires explicit tool-verification mode');
const root = resolve(values.root), out = resolve(values.out);
await mkdir(out, { recursive: false });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(resolve(root, 'profile-manifest.json'));
const manifest = JSON.parse(manifestBytes);
async function verify() {
  for (const row of manifest.files) {
    const file = resolve(root, row.path);
    assert.ok(file.startsWith(root + sep));
    const bytes = await readFile(file);
    assert.equal(bytes.length, row.bytes, row.path); assert.equal(sha(bytes), row.sha256, row.path);
  }
}
const report = {
  success: false, scope: manifest.scope, mode: values.mode, manifestSha256: sha(manifestBytes),
  toolVerification: values['tool-verification'], framesPerWindow: values['tool-verification'] ? 5 : 60,
  bundle: manifest.files.find(row => row.path === 'entry.js'),
  sourceMap: manifest.files.find(row => row.path === 'entry.js.map'),
  startedAtUtc: new Date().toISOString(), phases: {}, errors: [], console: [],
  interpretation: 'Scene diagnostic. CPU sampling adds overhead. Native query intervals and manually stepped throughput are not ordinary App FPS. Browser host has no frontend UI and is not WeChat acceptance.',
};
let browser, server, page, profiler;
const interrupted = () => {
  report.failure = { code: 'interrupted', message: 'Operator interrupted diagnostic; cleanup requested.' };
  void stopProfile('failed-profile.cpuprofile').catch(error => { report.profileCleanupError = error.message; }).finally(() => browser?.close());
};
process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
const save = async (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
const call = (method, ...args) => page.evaluate(({ method, args }) => globalThis.ordinaryEffects[method](...args), { method, args });
async function stopProfile(name) {
  if (!profiler) return;
  const current = profiler; profiler = undefined;
  try { const { profile } = await current.send('Profiler.stop'); await save(name, profile); }
  finally { try { await current.send('Profiler.disable'); } finally { await current.detach(); } }
}
async function phase(name, method = 'runFrames', ...args) {
  const startedAtUtc = new Date().toISOString();
  console.log(JSON.stringify({ phase: name, startedAtUtc }));
  const result = await call(method, report.framesPerWindow, ...args);
  report.phases[name] = { startedAtUtc, endedAtUtc: new Date().toISOString(), result };
  await save(`${name}.json`, report.phases[name]);
}
try {
  await verify();
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      assert.ok(file.startsWith(root + sep));
      let bytes;
      try { bytes = await readFile(file); } catch { bytes = brotliDecompressSync(await readFile(file + '.br')); }
      response.setHeader('cross-origin-opener-policy', 'same-origin');
      response.setHeader('cross-origin-embedder-policy', 'require-corp');
      response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(file)] ?? 'application/octet-stream');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { chromium } = await import(pathToFileURL(resolve(values.playwright)).href);
  const launch = { executablePath: values.chrome, headless: true, chromiumSandbox: true, args: values.software ? ['--use-angle=swiftshader'] : [] };
  report.launch = launch;
  browser = await chromium.launch({ ...launch, chromiumSandbox: true }); report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (report.console.length < 100) report.console.push({ type: message.type(), text: message.text().slice(0, 1000) }); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => globalThis.ordinaryEffects);
  console.log(JSON.stringify({ phase: 'initialize', startedAtUtc: new Date().toISOString() }));
  report.initial = await call('initialize', 'webgl');
  report.inspection = await call('inspect');
  const driver = report.inspection.driver?.renderer ?? '';
  assert.ok(driver, 'Driver identity absent');
  if (!values.software) assert.doesNotMatch(driver, /swiftshader|llvmpipe|software/i, 'Hardware driver required');
  await page.screenshot({ path: resolve(out, 'before.png') });
  if (values.mode !== 'gpu') await phase('control-before');
  if (values.mode === 'receipts') {
    assert.equal(report.phases['control-before'].result.receiptObservation?.enabled, false, 'Prepared entry does not support disabled receipt observation');
    await phase('receipt-trace', 'runFrames', true);
    assert.equal(report.phases['receipt-trace'].result.receiptObservation?.enabled, true, 'Prepared entry did not record receipt observations');
    await phase('control-after');
  }
  if (values.mode === 'all' || values.mode === 'cpu') {
    profiler = await page.context().newCDPSession(page);
    await profiler.send('Profiler.enable'); await profiler.send('Profiler.setSamplingInterval', { interval: 1000 });
    await profiler.send('Profiler.start');
    await phase('cpu-profile');
    await stopProfile('profile.cpuprofile');
    await phase('control-after');
  }
  if (values.mode === 'all' || values.mode === 'gpu') {
    await phase('gpu-query', 'gpuFrames');
    assert.notEqual(report.phases['gpu-query'].result.status, 'failed', 'Native GPU query failed; retained original structured result');
  }
  await page.screenshot({ path: resolve(out, 'after.png') });
  report.final = await call('snapshot');
  report.disposal = await call('dispose');
  await verify(); report.inputsUnchanged = true;
  assert.deepEqual(report.errors, []);
  report.success = true;
} catch (error) {
  report.failure ??= { code: error.code, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) try { report.failedState = await call('snapshot'); } catch { /* initialization may not have a World */ }
} finally {
  try { await stopProfile('failed-profile.cpuprofile'); } catch (error) { report.profileCleanupError = error.message; report.success = false; }
  if (page && !report.disposal) try { report.disposal = await call('dispose'); } catch (error) { report.disposalError = error.message; report.success = false; }
  try { await browser?.close(); } catch (error) { report.browserCleanupError = error.message; report.success = false; }
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  report.endedAtUtc = new Date().toISOString();
  await save('result.json', report);
  process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
}
console.log(JSON.stringify({ success: report.success, failure: report.failure, out, phases: Object.keys(report.phases) }));
process.exitCode = report.success ? 0 : 1;
