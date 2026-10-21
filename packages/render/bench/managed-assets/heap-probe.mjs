import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openHeapProfileTransport } from './heap-profile-transport.mjs';
import { createPostWindowEvidence } from './post-window-evidence.mjs';

/** Separate allocation and native-GC diagnostics over authenticated real realms. */
export async function startHeapProbe(browser, { outputPath, pageUrl, artifact, mode = 'allocation' }) {
  if (!['allocation', 'native-gc'].includes(mode)) throw new Error(`Unknown heap diagnostic mode: ${mode}`);
  const root = await browser.newBrowserCDPSession(), waiters = new Map(), realms = [], bySession = new Map();
  const evidence = await createPostWindowEvidence(outputPath);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let id = 0;
  root.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const data = JSON.parse(message), key = `${sessionId}:${data.id}`, waiter = waiters.get(key);
    if (data.method === 'Debugger.scriptParsed') bySession.get(sessionId)?.scripts?.set(data.params.scriptId, data.params);
    if (waiter) { waiters.delete(key); clearTimeout(waiter.timer); data.error ? waiter.reject(new Error(JSON.stringify(data.error))) : waiter.resolve(data.result); }
  });
  const send = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
    const command = ++id, key = `${sessionId}:${command}`;
    const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`CDP diagnostic command timed out: ${method}`)); }, 30000);
    waiters.set(key, { resolve, reject, timer });
    root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: command, method, params }) }).catch(error => { clearTimeout(timer); waiters.delete(key); reject(error); });
  });
  const evaluate = async (realm, expression) => {
    const result = await send(realm.sessionId, 'Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const origin = new URL(pageUrl).origin;
  const { targetInfos } = await root.send('Target.getTargets');
  const page = targetInfos.find(target => target.type === 'page' && target.url === pageUrl);
  if (!page) throw new Error('Missing benchmark page target');
  for (const target of targetInfos) {
    if (target.targetId !== page.targetId && !(target.type === 'worker' && target.url.startsWith(origin + '/'))) continue;
    const role = target.targetId === page.targetId ? 'Host' :
      ({ '/engine-worker.js': 'Engine Worker', '/render-worker.js': 'Render Worker', '/kernel-worker.js': 'Kernel Worker' })[new URL(target.url).pathname];
    if (!role) throw new Error(`Unqualified benchmark realm: ${target.url}`);
    const { sessionId } = await root.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const realm = { target, role, sessionId, scripts: new Map(), scriptDigests: [] };
    realms.push(realm); bySession.set(sessionId, realm);
    await send(sessionId, 'Debugger.enable');
    await evaluate(realm, 'void 0');
    for (const script of realm.scripts.values()) {
      if (!script.url.startsWith(origin + '/')) continue;
      const { scriptSource } = await send(sessionId, 'Debugger.getScriptSource', { scriptId: script.scriptId });
      const url = new URL(script.url), file = resolve(artifact, '.' + url.pathname);
      if (!file.startsWith(resolve(artifact) + '/')) throw new Error('Captured script escaped artifact');
      const sha256 = hash(scriptSource);
      if (hash(await readFile(file)) !== sha256) throw new Error(`Loaded script differs from frozen output: ${script.url}`);
      const receipt = evidence.save(`script-${target.targetId}-${script.scriptId}.js`, Buffer.from(scriptSource));
      realm.scriptDigests.push({ url: script.url, sha256, scriptId: script.scriptId, receipt });
    }
    await send(sessionId, 'Debugger.disable');
    delete realm.scripts;
  }
  const host = realms.find(realm => realm.role === 'Host');
  const execution = await evaluate(host, 'globalThis.assetBenchmark.execution');
  for (const [key, role] of [['engine', 'Engine Worker'], ['render', 'Render Worker']]) {
    const actual = realms.filter(realm => realm.role === role).length;
    if (actual !== Number(execution.workers[key].enabled)) throw new Error(`Actual ${role} targets differ from App execution report`);
  }
  const counter = `__forgeax_gc_${randomUUID().replaceAll('-', '')}`;
  const q = JSON.stringify;
  await evaluate(host, `(()=>{const state={frames:0};state.canvas=document.querySelector('canvas');state.handler=event=>{if(event.detail.presentation==='ready')state.frames++};state.canvas.addEventListener('forgeax:frame-completed',state.handler);globalThis[${q(counter)}]=state})()`);
  const frames = () => evaluate(host, `globalThis[${q(counter)}].frames`);
  await evidence.flush();
  const trace = [], maxTraceEvents = 2_000_000;
  let overflow = 0;
  root.on('Tracing.dataCollected', data => {
    for (const event of data.value) { if (trace.length < maxTraceEvents) trace.push(event); else overflow++; }
  });
  await root.send('Tracing.start', { categories: 'v8,disabled-by-default-v8.gc,devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' });
  const samplingOptions = { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
  const samplerBeforeFrames = await frames();
  const setupProfiles = mode === 'allocation' ? await openHeapProfileTransport(root, evidence) : undefined;
  try {
  for (const realm of realms) {
    realm.before = await send(realm.sessionId, 'Runtime.getHeapUsage');
    if (mode === 'allocation') {
      realm.samplingRequestedAt = performance.now();
      realm.samplingSessionId = await setupProfiles.start(realm.target, samplingOptions);
      realm.samplingAcknowledgedAt = performance.now();
      realm.samplingOptions = samplingOptions;
    }
    realm.marker = `forgeax-owned-${realm.target.targetId}-${randomUUID()}`;
    await evaluate(realm, `performance.mark(${q(realm.marker)})`);
  }
  } finally { await setupProfiles?.close(); }
  const samplerAfterFrames = await frames();
  const startMarker = `forgeax-window-start-${randomUUID()}`, endMarker = `forgeax-window-end-${randomUUID()}`;
  const metadata = { mode, browser: await root.send('Browser.getVersion'), markers: realms.map(realm => ({ targetId: realm.target.targetId, realm: realm.role, name: realm.marker })), startMarker, endMarker, samplerBeforeFrames, samplerAfterFrames };
  evidence.save('preflight.json', { ...metadata, realms }); await evidence.flush();
  await evaluate(host, `globalThis.assetBenchmarkDiagnosticWindow={begin:()=>performance.mark(${q(startMarker)}),end:()=>performance.mark(${q(endMarker)})}`);
  return async () => {
    await evaluate(host, 'delete globalThis.assetBenchmarkDiagnosticWindow');
    const currentTargets = (await root.send('Target.getTargets')).targetInfos;
    const ownedIds = targets => targets.filter(target => target.targetId === page.targetId || (target.type === 'worker' && target.url.startsWith(origin + '/'))).map(target => target.targetId).sort();
    if (q(ownedIds(currentTargets)) !== q(realms.map(realm => realm.target.targetId).sort())) throw new Error('Owned realm roster changed during the GC window');
    const pausedFrames = await frames();
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP GC trace completion timed out')), 30000);
      root.once('Tracing.tracingComplete', value => { clearTimeout(timer); resolve(value); });
    });
    const [, traceComplete] = await Promise.all([root.send('Tracing.end'), ended]);
    evidence.save('trace-receipt.json', { traceComplete, events: trace.length, overflow });
    evidence.saveRows('trace.ndjson', trace);
    await evidence.flush();
    if (overflow || traceComplete.dataLossOccurred !== false) throw new Error('Native trace is incomplete or exceeds its explicit event bound');
    const markerTime = name => {
      const matches = trace.filter(event => event.name === name && event.cat?.includes('user_timing'));
      if (matches.length !== 1) throw new Error(`Missing or ambiguous GC window marker: ${name}`);
      return matches[0].ts;
    };
    const window = { startTime: markerTime(startMarker), endTime: markerTime(endMarker) };
    const { summarizeNativeGc } = await import('../../../../skills/forgeax-engine-performance/scripts/summarize_native_gc.mjs');
    const nativeGc = summarizeNativeGc({ traceEvents: trace }, metadata.markers, window);
    let profiles;
    try {
      if (mode === 'allocation') profiles = await openHeapProfileTransport(root, evidence);
      for (const realm of realms) {
        realm.after = await send(realm.sessionId, 'Runtime.getHeapUsage');
        if (profiles) {
          realm.samplingStopRequestedAt = performance.now();
          const completed = await profiles.stop(realm.target, realm.samplingSessionId);
          realm.samplingStopAcknowledgedAt = performance.now();
          realm.allocation = completed.profile;
          delete realm.samplingSessionId;
          evidence.event({ stage: 'realm-stop-complete', target: realm.target, receipt: completed.receipt });
        }
      }
      await evaluate(host, `(()=>{const state=globalThis[${q(counter)}];state.canvas.removeEventListener('forgeax:frame-completed',state.handler);delete globalThis[${q(counter)}]})()`);
      for (const realm of realms) { await root.send('Target.detachFromTarget', { sessionId: realm.sessionId }); delete realm.sessionId; }
    } finally { await profiles?.close(); await evidence.flush(); }
    await root.detach();
    return { ...metadata, traceComplete, trace, nativeGc, realms,
      samplingInterval: mode === 'allocation' ? samplingOptions.samplingInterval : null,
      completedFrameBounds: { minimum: pausedFrames - samplerAfterFrames, maximum: pausedFrames - samplerBeforeFrames },
      boundary: mode === 'allocation' ? 'Statistical allocation diagnostic, including bounded pre-window frames and post-window sampler retrieval; native GC here is sampler-instrumented, not natural GC acceptance' : 'Native GC diagnostic without allocation sampler; owned target/thread markers and complete common workload interval' };
  };
}
