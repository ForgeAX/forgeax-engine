import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';
const root = resolve(import.meta.dirname, '../../../..'),
  source = resolve(import.meta.dirname, '../assets/terrain.pack.ts'),
  original = readFileSync(source);
const server = spawn('pnpm', ['-F', '@forgeax/hello-terrain', 'dev'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', FORGEAX_ENGINE_RHI_DEBUG: '1' },
  }),
  stop = createOwnedProcessGroupStopper(server);
let url,
  output = '',
  browser,
  page;
for (const stream of [server.stdout, server.stderr])
  stream.on('data', (data) => {
    output = (output + data).slice(-8192);
    process.stdout.write(data);
    const match = output
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .match(/Local:\s+(https?:\/\/[^\s]+)/);
    if (match) url = match[1];
  });
const errors = [],
  consoleDetails = [],
  consoleReads = [];
const worker = process.argv.includes('--worker');
const dir = resolve(
  import.meta.dirname,
  worker ? '../.forgeax-debug/hmr-worker' : '../.forgeax-debug/hmr',
);
mkdirSync(dir, { recursive: true });
const wait = async (predicate, label, timeout = 120000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(30);
  }
  throw new Error(`timed out: ${label}`);
};
try {
  await wait(() => url !== undefined, 'Vite startup', 300000);
  browser = await chromium.launch({
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    headless: true,
    args: resolveBrowserWebGpuLaunch().args,
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
      consoleReads.push(
        Promise.all(
          message
            .args()
            .map((arg) =>
              arg.evaluate((value) => ({
                text: String(value),
                code: value?.code,
                detail: value?.detail,
                stack: value?.stack,
              })),
            ),
        ).then((details) => consoleDetails.push({ text: message.text(), details })),
      );
    }
  });
  await page.goto(worker ? `${url}?workers=1` : url, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  const state = () => page.evaluate(() => window.__terrainHmrProbe?.state());
  await wait(async () => {
    if (errors.length) throw new Error('terrain startup console error: ' + errors[0]);
    const s = await state();
    return s !== undefined && !s.gate.blocked;
  }, 'initial physics and submitted terrain readiness');
  const workerBaseline = worker
    ? await page.evaluate(() => window.__verifyTerrainWorker())
    : undefined;
  const initial = await state();
  await page.evaluate(() => window.__terrainHmrProbe.move());
  await wait(
    async () => (await state()).walker.updates > initial.walker.updates + 3,
    'real walker movement',
  );
  await page.screenshot({ path: resolve(dir, 'before.png') });
  await page.evaluate((worker) => {
    if (worker) window.__terrainWorkerReject();
    else window.__terrainRejectNextSubmit = true;
  }, worker);
  await wait(
    () =>
      page.evaluate(() =>
        window.__terrainHmrProbe.events.some((event) => event.kind === 'submit-rejected'),
      ),
    worker
      ? 'native queue rejects the Worker submission'
      : 'rejected submission preserves prior receipt',
  );
  let recovered;
  if (worker) {
    await wait(async () => {
      const s = await state();
      return (
        s.worldIdentity === initial.worldIdentity &&
        s.render.epoch > initial.render.epoch &&
        s.render.state === 'alive' &&
        s.frameId > initial.frameId
      );
    }, 'Render Worker replacement completes with the original World');
    recovered = await state();
    const old = await page.evaluate((frame) => window.__terrainWorkerQuery(frame), initial.frameId);
    assert.equal(old.ok, false, 'replaced Renderer sessions reject old submitted receipt IDs');
  }
  const replace = (offset) =>
    writeFileSync(
      source,
      original.toString().replace('const HEIGHT_OFFSET = 0;', `const HEIGHT_OFFSET = ${offset};`),
    );
  await page.evaluate(() => window.__terrainHmrProbe.rejectOnCatalog());
  replace(3);
  await wait(async () => {
    const s = await state();
    return s.height > initial.height + 2.9 && !s.gate.blocked;
  }, 'height +3 replacement resumes');
  const changed = await state();
  assert.notEqual(changed.asset, initial.asset);
  if (worker) {
    assert.equal(changed.worldIdentity, initial.worldIdentity);
    assert(changed.render.epoch > recovered.render.epoch);
  }
  assert.equal(changed.physics.shapeIds.includes(`terrain:${changed.asset}`), true);
  const query = await page.evaluate(() => window.__terrainHmrProbe.submitted());
  assert(query.ok && Math.abs(query.value - changed.height) < 0.02);
  await page.screenshot({ path: resolve(dir, 'after.png') });
  // Same-root retry must retain its only ECS reference and pause the actual writer.
  await page.evaluate(() => window.__terrainHmrProbe.retry());
  await wait(async () => !(await state()).gate.blocked, 'same-root retry');
  const retried = await state();
  assert.equal(retried.asset, changed.asset);
  replace(6);
  await sleep(50);
  replace(9);
  await wait(async () => {
    const s = await state();
    return s.height > initial.height + 8.9 && !s.gate.blocked;
  }, 'rapid updates select latest root');
  const rapid = await state();
  const observations = await page.evaluate(() => ({
    events: window.__terrainHmrProbe.events,
    failures: window.__terrainHmrProbe.failures,
  }));
  assert.deepEqual(observations.failures, []);
  if (worker) assert.deepEqual(rapid.failures, []);
  assert.deepEqual(errors, []);
  const rejected = observations.events.filter((event) => event.kind === 'submit-rejected');
  assert.equal(rejected.length, 2);
  if (!worker) {
    assert.equal(rejected[1].state.gate.blocked, true);
    assert.equal(
      rejected[0].query.ok,
      true,
      'the rejected frame leaves the prior accepted receipt usable',
    );
    assert(Number.isFinite(rejected[0].query.value));
  }
  const report = {
    status: 'PASS',
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    worker,
    workerBaseline,
    recovered,
    initial,
    changed,
    retried,
    rapid,
    query,
    ...observations,
    errors,
  };
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await Promise.allSettled(consoleReads);
  if (page) {
    const evidence = await page
      .evaluate(async () => ({
        state: await window.__terrainHmrProbe?.state(),
        events: window.__terrainHmrProbe?.events,
        failures: window.__terrainHmrProbe?.failures,
      }))
      .catch((problem) => ({ probeError: String(problem) }));
    writeFileSync(
      resolve(dir, 'failure.json'),
      JSON.stringify({ error: String(error), errors, consoleDetails, ...evidence }, null, 2),
    );
  }
  if (page) await page.screenshot({ path: resolve(dir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  writeFileSync(source, original);
  await browser?.close();
  await stop();
  assert.equal(
    createHash('sha256').update(readFileSync(source)).digest('hex'),
    createHash('sha256').update(original).digest('hex'),
  );
}
