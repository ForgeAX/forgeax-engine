import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const root = process.env.TERRAIN_PROBE_ROOT ?? resolve(import.meta.dirname, '../../../..');
const { chromium } = await import(pathToFileURL(resolve(root, 'node_modules/playwright/index.mjs')).href);
const { createOwnedProcessGroupStopper } = await import(pathToFileURL(resolve(root, 'apps/shared/scripts/rhi-debug-process.mjs')).href);
const { resolveBrowserWebGpuLaunch } = await import(pathToFileURL(resolve(root, 'apps/shared/scripts/rhi-debug-verify.mjs')).href);
const dir = resolve(process.env.TERRAIN_NORMAL_APP_ARTIFACT_DIR ?? resolve(root, 'artifacts/terrain-normal-app-response'));
mkdirSync(dir, { recursive: true });
const server = spawn('pnpm', ['-F', '@forgeax/hello-terrain', 'dev'], { cwd: root, detached: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NODE_ENV: 'development', FORGEAX_ENGINE_RHI_DEBUG: '1' } });
const stop = createOwnedProcessGroupStopper(server);
let url, output = '', browser, page;
for (const stream of [server.stdout,server.stderr]) stream.on('data', data => {
  output = (output + data).slice(-8192);
  const match = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').match(/Local:\s+(https?:\/\/[^\s]+)/);
  if (match) url = match[1];
});
const errors = [];
try {
  const startupDeadline = Date.now() + 300000;
  while (!url && Date.now() < startupDeadline) await sleep(30);
  assert(url, 'normal Vite startup must finish');
  browser = await chromium.launch({ channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chromium', headless: true, args: resolveBrowserWebGpuLaunch().args, chromiumSandbox: true});
  page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__terrainHmrProbe && !window.__terrainHmrProbe.state().gate.blocked, {}, { timeout: 300000 });
  const hostRequestUtcMs = Date.now();
  const report = await page.evaluate(async ({ queryUrl }) => {
    const { terrainHeight } = await import(queryUrl);
    const { app } = window.__terrain;
    const probe = window.__terrainHmrProbe;
    const baseline = probe.state();
    const terrainEntity = baseline.physics?.entity;
    const schema = app.world.components.resolve('Terrain');
    if (terrainEntity === undefined || schema === undefined) throw new Error('actual Terrain schema/publication must exist');
    const root = app.assets.read(app.world.get(terrainEntity, schema).unwrap().asset).unwrap();
    const submissions = [], targets = [], failures = [], completionOrder = [];
    let unsubscribe, timer, intentUtcMs, intentMs, firstUpdatedSubmission, frozenWindow = false, finished = false;
    const snapshot = (status) => ({ schemaVersion: 2, status,
      canvas: { width: document.querySelector('#app').width, height: document.querySelector('#app').height, devicePixelRatio },
      boundary: 'Normal createApp.start pacing; fixture intent enters the actual Update writer. Completion observations are live World snapshots, not receipt-frozen poses. No manual World update, Renderer draw, pause, or extra queue drain.',
      execution: app.execution.report(), terrainEntity, intentUtcMs, intentMs, baseline, firstUpdatedSubmission,
      targetFrameIds: targets.map(frame => frame.frameId), frames: targets, submissions, completionOrder, failures,
      errors: [...window.__terrain.errors], rejections: [...window.__terrain.rejections], writerFailures: [...probe.failures], inspection: app.renderer.inspect() });
    try {
      return await new Promise(resolve => {
        const finish = status => {
          if (finished) return;
          finished = true; clearTimeout(timer); unsubscribe?.();
          resolve(JSON.parse(JSON.stringify(snapshot(status))));
        };
        const settleWindow = () => {
          if (frozenWindow && submissions.every(frame => frame.settlement !== 'pending')) finish('COMPLETE');
        };
        unsubscribe = app.renderer.subscribe(event => {
          if (finished || frozenWindow || event.kind !== 'frame-submitted' || intentMs === undefined) return;
          const receipt = event.receipt;
          const submitMs = performance.now(), submitUtcMs = Date.now(), submitted = probe.state();
          const sample = { frameId: receipt.frameId, presentation: receipt.presentation, submitMs, submitUtcMs, submitted, settlement: 'pending' };
          submissions.push(sample);
          const eligible = receipt.presentation === 'ready' && submitted.walker.updates > baseline.walker.updates;
          if (eligible && targets.length < 60) {
            const [x,y,z] = submitted.position;
            const rayZ = z + 3;
            const expectedCollisionHeight = terrainHeight(root, x, rayZ);
            const hit = app.world.getResource('PhysicsWorld').raycast(new Float32Array([x,y+20,rayZ]), new Float32Array([0,-1,0]), 100);
            Object.assign(sample, { ray: { x, z: rayZ }, expectedCollisionHeight, hit: hit ? { entity: hit.entity, point: Array.from(hit.point), timeOfImpact: hit.timeOfImpact } : null,
              collisionError: hit && expectedCollisionHeight !== undefined ? Math.abs(expectedCollisionHeight-hit.point[1]) : null,
              walkerAuthorHeight: terrainHeight(root,x,z), walkerFootError: Math.abs(y-1-terrainHeight(root,x,z)) });
            targets.push(sample);
            firstUpdatedSubmission ??= sample;
            if (targets.length === 60) frozenWindow = true;
          }
          receipt.completed.then(result => {
            if (finished) return;
            Object.assign(sample, { settlement: result.ok ? 'completed' : 'failed', completedMs: performance.now(), completedUtcMs: Date.now(), completionWorldObservation: probe.state() });
            completionOrder.push(receipt.frameId);
            if (!result.ok) failures.push({ frameId: receipt.frameId, error: result.error });
            settleWindow();
          }, error => {
            if (finished) return;
            Object.assign(sample, { settlement: 'rejected', completedMs: performance.now(), completedUtcMs: Date.now(), error: String(error) });
            failures.push({ frameId: receipt.frameId, error: String(error) });
            settleWindow();
          });
        });
        timer = setTimeout(() => finish('TIMEOUT'), 60000);
        intentUtcMs = Date.now(); intentMs = performance.now();
        probe.move();
      });
    } finally {
      clearTimeout(timer); unsubscribe?.();
      app.world.getResource('TerrainWalker').speed = 0;
    }
  }, { queryUrl: '/@fs' + resolve(root,'packages/terrain/src/query.ts') });
  writeFileSync(resolve(dir,'report.json'), JSON.stringify({ ...report, hostRequestUtcMs, hostRequestToToolIntentAppliedMs: report.intentUtcMs - hostRequestUtcMs, browserBackend: resolveBrowserWebGpuLaunch(), browserConsoleErrors: errors, hostRequestBoundary: 'Host evaluate request to tool intent, including owner module import and fixture setup; not isolated transport latency.' }, null, 2));
  await page.screenshot({ path: resolve(dir,'normal-app-after-intent.png') });
  assert.equal(report.status,'COMPLETE');
  assert.equal(report.frames.length,60);
  assert.equal(new Set(report.targetFrameIds).size,60);
  assert(report.frames.every(frame => frame.settlement === 'completed'));
  assert(report.submissions.every(frame => frame.settlement === 'completed'));
  assert(report.submissions.every(frame => frame.presentation === 'ready'), 'static post-intent window must not hide a non-ready presentation');
  assert.deepEqual(report.failures,[]); assert.deepEqual(report.errors,[]); assert.deepEqual(report.rejections,[]); assert.deepEqual(report.writerFailures,[]); assert.deepEqual(errors,[]);
  assert(report.frames.every(frame => !frame.submitted.gate.blocked && frame.submitted.asset === report.baseline.asset && frame.hit?.entity === report.terrainEntity && Number.isFinite(frame.expectedCollisionHeight) && frame.hit.point.every(Number.isFinite) && Number.isFinite(frame.collisionError) && frame.collisionError <= 1e-5 && Number.isFinite(frame.walkerAuthorHeight) && Number.isFinite(frame.walkerFootError) && frame.walkerFootError <= 1e-5 && frame.submitted.physics?.entity === report.terrainEntity && frame.submitted.physics.fixedStep > 0 && frame.submitted.physics.shapeIds.includes('terrain:' + frame.submitted.asset)), 'each gameplay response retains the real author-heightfield collision contract');
  assert(report.frames.at(-1).submitted.walker.updates > report.baseline.walker.updates);
  assert(report.frames.at(-1).submitted.position[0] > report.baseline.position[0]);
  const ordered = [...report.frames].sort((a,b)=>a.frameId-b.frameId);
  const completedOrder = [...report.frames].sort((a,b)=>a.completedMs-b.completedMs);
  const intervals = completedOrder.slice(1).map((frame,index)=>frame.completedMs-completedOrder[index].completedMs);
  const stats = xs => { const s=[...xs].sort((a,b)=>a-b); return { median:s[Math.floor((s.length-1)*.5)],p95:s[Math.floor((s.length-1)*.95)],peak:Math.max(...s) }; };
  const result = { status:'PASS', completedFrames:60, windowSubmittedFrames:report.submissions.length, windowReadyFrames:report.submissions.filter(frame=>frame.presentation==='ready').length, preUpdateSubmissions:report.submissions.filter(frame=>frame.submitted.walker.updates<=report.baseline.walker.updates).length, pendingSettlements:report.submissions.filter(frame=>frame.settlement==='pending').length, intentToFirstUpdatedSubmitMs:report.firstUpdatedSubmission.submitMs-report.intentMs, intentToFirstCompletedResponseMs:completedOrder[0].completedMs-report.intentMs, completionIntervalMs:stats(intervals), submitToCompletedMs:stats(ordered.map(frame=>frame.completedMs-frame.submitMs)), intervalsAbove100Ms:intervals.filter(value=>value>100).length, boundary:'Semantic/collision response PASS; timing data is descriptive and does not replace any existing budget verdict.' };
  writeFileSync(resolve(dir,'summary.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(resolve(dir,'failure.json'),JSON.stringify({ status:'FAIL',message:String(error),errors,serverTail:output },null,2));
  if (page) await page.screenshot({path:resolve(dir,'failure.png')}).catch(()=>{});
  throw error;
} finally {
  if (page) await page.evaluate(()=>window.__disposeTerrain?.()).catch(()=>{});
  await browser?.close(); await stop();
}
