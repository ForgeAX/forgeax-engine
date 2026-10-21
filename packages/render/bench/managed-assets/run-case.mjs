import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { startHeapProbe } from './heap-probe.mjs';
import { writeHeapEvidence } from './write-heap.mjs';
import { pixels, difference } from './pixels.mjs';
import { budgets } from './budgets.mjs';
const [artifact, caseId = 'static-1', mode = 'default', output = 'macro-result.json', phase = 'measure'] = process.argv.slice(2);
if (!artifact) throw new Error('Pass the built artifact directory');
const frozenIdentity = JSON.parse(await readFile(resolve(artifact, 'build-identity.json'), 'utf8'));
const gpuTimingEnabled = frozenIdentity.observation?.gpuPassTiming ?? true;
const runnerFiles = ['run-case.mjs', 'heap-probe.mjs', 'heap-profile-transport.mjs', 'post-window-evidence.mjs', 'write-heap.mjs', 'pixels.mjs', 'budgets.mjs', 'summarize.mjs'];
const runnerInventory = await Promise.all(runnerFiles.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex') })));
const measurementRunner = { browserMode: 'headless', gpuPassTiming: gpuTimingEnabled, diagnosticOnly: gpuTimingEnabled || phase !== 'measure-lean', observationBoundary: gpuTimingEnabled ? 'GPU timestamp and per-receipt timing diagnostic; not ordinary throughput or production natural-GC acceptance' : 'Existing FrameReceipt.completed; one disabled-timing preflight during warmup (awaited before measurement), no timed-window GPU timing/counters/Renderer.observe; heap/native tracing only in separately named phases', sha256: createHash('sha256').update(JSON.stringify(runnerInventory)).digest('hex'), inventory: runnerInventory };
if (!['measure', 'measure-lean', 'measure-native-gc', 'measure-allocation', 'diagnostic', 'calibration', 'compare'].includes(phase)) throw new Error(`Unknown measurement phase: ${phase}`);
const { chromium } = await import(process.env.FORGEAX_BENCH_PLAYWRIGHT ?? 'playwright-core');
const root = resolve(artifact), failures = [];
const verifyArtifact = async () => {
  if (!Array.isArray(frozenIdentity.inventory) || createHash('sha256').update(JSON.stringify(frozenIdentity.inventory)).digest('hex') !== frozenIdentity.artifactSha256)
    throw new Error('Artifact inventory does not match its frozen digest');
  for (const item of frozenIdentity.inventory) {
    const file = resolve(root, item.path);
    if (!file.startsWith(root + '/')) throw new Error('Artifact inventory escaped its directory');
    const bytes = await readFile(file);
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new Error('Artifact bytes differ: ' + item.path);
  }
};
await verifyArtifact();
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
let activePage;
const server = createServer(async (req, res) => { try {
  const request = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (request === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
  const file = resolve(root, '.' + (request === '/' ? '/index.html' : request));
  if (!file.startsWith(root + '/')) throw new Error('Invalid artifact path');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.html': 'text/html' })[extname(file)] ?? 'application/octet-stream');
  res.end(await readFile(file));
} catch (error) { res.statusCode = 404; res.end(String(error)); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.FORGEAX_BENCH_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-precise-memory-info', '--remote-debugging-port=0'], chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  activePage = page;
  page.on('pageerror', error => { failures.push(String(error)); console.error(String(error)); });
  page.on('console', message => { if (message.type() === 'error') {failures.push(message.text()); console.error(message.text());} });
  await page.waitForTimeout(3000);
  await page.goto(`http://127.0.0.1:${server.address().port}/?case=${encodeURIComponent(caseId)}&mode=${mode}`);
  const deadline=Date.now()+300000;
  while(!await page.evaluate(()=>Boolean(globalThis.assetBenchmark||globalThis.assetBenchmarkFailure))){if(failures.length)throw new Error(failures.join('\n'));if(Date.now()>deadline)throw new Error('Benchmark startup timeout');await page.waitForTimeout(100);}
  console.log(JSON.stringify({stage:'ready',caseId,mode}));
  const error = await page.evaluate(() => globalThis.assetBenchmarkFailure); if (error) throw new Error(error);
  const adapter = await page.evaluate(async () => { const adapter = await navigator.gpu.requestAdapter(); return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, device: adapter?.info.device, description: adapter?.info.description }; });
  const identity = frozenIdentity;
  const expectedCanvasCount = await page.evaluate(() => globalThis.assetBenchmark.config.renderers ?? 1);
  let result, heap;
  const oracles=[];
  const capture = async name => {
    const canvases = page.locator('canvas'), files=[];
    const count = await canvases.count();
    if (count !== expectedCanvasCount) throw new Error(`Expected ${expectedCanvasCount} benchmark canvases, got ${count}`);
    for(let i=0;i<count;i++){
      const path=output+(i===0?'':`.renderer${i}`)+`.${name}.png`;
      await canvases.nth(i).screenshot({path});files.push(path);
    }
    return files;
  };
  if (phase === 'diagnostic') {
    result = await page.evaluate(() => ({ diagnosticOnly: true, execution: globalThis.assetBenchmark.execution, config: globalThis.assetBenchmark.config }));
    await capture('warmed');
  } else {
    for (const value of [0, 1]) {
      const adopted=await page.evaluate(value => globalThis.assetBenchmark.probe(value), value);
      oracles.push({value,adopted,files:await capture(`oracle${value}`)});
    }
    for(let i=0;i<oracles[0].files.length;i++){
      const [zero,one]=await Promise.all([oracles[0].files[i],oracles[1].files[i]].map(async file=>pixels(await readFile(file))));
      const visible=difference(zero,one);
      if(visible.max<budgets.oracleMinimumDifference){
        await writeFile(output+'.correctness-error.json',json({identity,config:caseId,mode,oracles,renderer:i,visible}));
        throw new Error(`Renderer ${i} oracle values are not visibly distinct: ${json(visible)}`);
      }
    }
    await page.evaluate(() => globalThis.assetBenchmark.probe(0));
    await page.evaluate(() => globalThis.assetBenchmark.prepareWindow?.());
    const stopHeap = phase === 'measure-lean' ? undefined : await startHeapProbe(browser, { outputPath: output + '.heap-diagnostic', pageUrl: page.url(), artifact: root, mode: phase === 'measure-native-gc' ? 'native-gc' : 'allocation' });
    const progress = setInterval(async () => { try { console.log(json(await page.evaluate(() => globalThis.assetBenchmarkProgress))); } catch {} }, 10000);
    try {
      result = await page.evaluate(() => globalThis.assetBenchmark.run());
      // Preserve completed timing even if a later diagnostics transport fails.
      // This sidecar is not an accepted window: heap, pixels and teardown follow.
      await writeFile(output + '.timing.json', json({ browser: browser.version(), adapter, phase, measurementRunner, identity, oracles, ...result }));
    }
    finally {
      clearInterval(progress);
      try {
        await page.evaluate(() => globalThis.assetBenchmark.pause());
        heap = await stopHeap?.();
        if (heap) await writeHeapEvidence(output + '.heap.json', heap);
        const after = await page.evaluate(() => globalThis.assetBenchmark.pause());
        const frameState = value => value?.carrier === 'native-renderer-consumers'
          ? { sourceStep: value.sourceStep, completedFrames: value.completedFrames }
          : { sourceFrameId: value?.sourceFrameId, readyFrames: value?.readyFrames, frame: value?.execution.frame, renderFrame: value?.execution.render?.completedFrame };
        if (result && (!result.quiescence || json(frameState(result.quiescence)) !== json(frameState(after)))) {
          throw new Error('Frames advanced during post-window heap collection');
        }
      } catch (error) {
        // Report diagnostics failure without replacing an earlier workload error.
        failures.push(`Heap evidence failed: ${String(error?.stack ?? error)}`);
        console.error(failures.at(-1));
      }
    }
    const settledFiles=await capture('settled');
    const expected=result.config.writes===0?0:result.source.step&1;
    result.pixelChecks=[];
    for(let i=0;i<settledFiles.length;i++){
      const [zero,one,settled]=await Promise.all([oracles[0].files[i],oracles[1].files[i],settledFiles[i]].map(async file=>pixels(await readFile(file))));
      const visible=difference(zero,one),final=difference(expected===0?zero:one,settled);
      result.pixelChecks.push({renderer:i,expected,visible,final});
      if(visible.max<budgets.oracleMinimumDifference)failures.push(`Renderer ${i} oracle values are not visibly distinct: ${json(visible)}`);
      if(final.max>budgets.settledPixelMaxDifference||final.mean>budgets.settledPixelMeanDifference)failures.push(`Renderer ${i} final pixels do not match the last committed value: ${json(final)}`);
    }
  }
  if (!gpuTimingEnabled && phase !== 'diagnostic') {
    if (result.preflight?.code !== 'gpu-timing-not-enabled' || result.preflight.status !== 'unavailable' || result.observation?.gpuPassTiming !== false || result.observation?.gpuCounters !== false || result.samples.some(sample => sample.gpuTiming !== undefined || sample.gpuPassEnvelopeMs !== undefined || sample.gpu !== undefined))
      throw new Error('Completion-only artifact unexpectedly produced GPU diagnostic evidence');
  }
  await verifyArtifact();
  await page.evaluate(() => globalThis.assetBenchmark.dispose());
  await writeFile(output, json({ browser: browser.version(), adapter, phase, measurementRunner, artifactVerification: { before: 'complete', after: 'complete', digest: identity.artifactSha256 }, failures, identity, oracles, teardown: 'complete', ...result }));
  console.log(JSON.stringify({ output, phase, adapter, failures, execution: result.execution, samples: result.samples?.length }));
  if (failures.length) process.exitCode = 1;
} catch (error) { console.error(String(error?.stack ?? error)); await writeFile(output + '.failure.json', json({measurementRunner, phase, error: String(error?.stack ?? error), failures})); console.error(json({ failures, progress: await activePage?.evaluate(() => globalThis.assetBenchmarkProgress).catch(() => undefined) })); process.exitCode = 1; }
finally { await browser.close(); server.close(); }
