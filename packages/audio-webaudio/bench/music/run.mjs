import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, loadavg, platform, arch } from 'node:os';
import { preview } from 'vite';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { quietPreflight, quietSnapshot } from './quiet-admission.mjs';
import { head, sourceHashes, siteHashes } from './inputs.mjs';
import { watchNativeStages } from './native-stage.mjs';
import { retainNativeEvidence } from './retain-native-evidence.mjs';
import { captureWorkerRetirement } from './native-worker-retirement.mjs';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const site = resolve(root, process.env.FORGEAX_MUSIC_SITE ?? 'artifacts/roi-23/site');
const name = process.env.FORGEAX_MUSIC_RUN ?? `round-${Date.now()}`;
const output = resolve(root, 'artifacts/roi-23', name);
const prepareOnly = process.argv.includes('--prepare-only');
const nativeOnly = process.argv.includes('--native-only');
const heapDiagnostic = process.argv.includes('--heap-diagnostic');
const rhiCapture = process.argv.includes('--rhi-capture');
const workerRetirement = process.argv.includes('--worker-retirement');
if (prepareOnly === nativeOnly) throw new Error('select --prepare-only outside the lease or --native-only through the maintained bounded lease CLI');
if (nativeOnly && (process.env.FORGEAX_LOCAL_GPU_LEASE !== '1' || process.env.FORGEAX_LOCAL_GPU_LEASE_HELD !== '1'))
  throw new Error('native music requires the maintained local-gpu-lease.mjs --timeout-ms process owner');
const caseIndex = process.argv.indexOf('--app-case');
const appCase = caseIndex < 0 ? undefined : JSON.parse(process.argv[caseIndex+1] ?? 'null');
const repeatIndex = process.argv.indexOf('--app-repeat');
const appRepeat = repeatIndex < 0 ? 1 : Number(process.argv[repeatIndex + 1]);
if (!Number.isSafeInteger(appRepeat) || appRepeat < 1 || appRepeat > 9 || (repeatIndex >= 0 && !appCase))
  throw new Error('App repetition is a bounded diagnostic of one original matrix case (1–9 repetitions)');
if (rhiCapture && appCase === undefined) throw new Error('RHI capture is a separate single App diagnostic, not part of the frozen measurement matrix');
if (rhiCapture && appRepeat !== 1) throw new Error('RHI capture retains one original App case per tape');
if(appCase && (!['main-serial','engine-worker','shared'].includes(appCase.tier) || ![1,4,16].includes(appCase.count) || ![0,1,3].includes(appCase.delayFrames) || (appCase.falsifier !== undefined && typeof appCase.falsifier !== 'boolean')))
  throw new Error('diagnostic App case must belong to the original frozen matrix');
await mkdir(output, { recursive: true });
const admissionPath = resolve(output, 'prepared-native.json');
const report = nativeOnly ? JSON.parse(await readFile(admissionPath, 'utf8')) : { head: head(root),
  dirty: execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(), sourceHashes: await sourceHashes(root),siteHashes:await siteHashes(root,site),
  host: { cpu:cpus()[0]?.model, cores:cpus().length, platform:platform(), arch:arch(), loadBefore:loadavg() },
  audioDevices:JSON.parse(execFileSync('system_profiler',['SPAudioDataType','-json'],{encoding:'utf8'})),
  appCase, appRepeat, startedAt:new Date().toISOString(), short:process.argv.includes('--short'), effectsOnly:process.argv.includes('--effects-only'), heapDiagnostic, rhiCapture, workerRetirement };
const prepared=JSON.parse(await readFile(resolve(site,'prepared-inputs.json'),'utf8'));
if(prepared.head!==report.head||JSON.stringify(prepared.sourceHashes)!==JSON.stringify(report.sourceHashes)||JSON.stringify(prepared.siteHashes)!==JSON.stringify(report.siteHashes))throw new Error('prepared public source/site inputs do not match this epoch; rebuild outside lease');
if(nativeOnly && (report.head !== head(root) || JSON.stringify(report.sourceHashes)!==JSON.stringify(await sourceHashes(root)) || JSON.stringify(report.siteHashes)!==JSON.stringify(await siteHashes(root,site)) || JSON.stringify(report.appCase)!==JSON.stringify(appCase) || report.appRepeat!==appRepeat || report.short!==process.argv.includes('--short') || report.effectsOnly!==process.argv.includes('--effects-only') || report.heapDiagnostic!==heapDiagnostic || report.rhiCapture!==rhiCapture || report.workerRetirement!==workerRetirement))
  throw new Error('prepared native admission does not match the current frozen inputs or complete workload');
report.cleanPerformance = false;
if (prepareOnly && process.env.FORGEAX_MUSIC_QUIET_RECEIPT) {
  if (report.dirty) throw new Error('quiet performance requires the committed frozen source epoch');
  report.ownerReadyReceipt = await readFile(process.env.FORGEAX_MUSIC_QUIET_RECEIPT, 'utf8');
  try {
    report.quietPreflight = await quietPreflight(row => writeFile(resolve(output,'quiet-preflight.json'),JSON.stringify({head:report.head,sourceHashes:report.sourceHashes,...row},null,2)));
  } catch(error) {
    report.failure=String(error);
    await writeFile(resolve(output,'raw.json'),JSON.stringify(report,null,2));
    throw error;
  }
}
if (prepareOnly) {
  report.preparedAt = new Date().toISOString();
  await writeFile(admissionPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({prepared:admissionPath,scope:'CPU/admission preparation only; no native acceptance'}));
  process.exit(0);
}
report.nativeStartedAt = new Date().toISOString();
const server = await preview({ configFile:false, root:site, build:{outDir:site}, preview:{port:5323,strictPort:true,
  headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'} } });
let browser;
let resourceTimer;
let workerHeapTimer;
let stages;
try {
  report.lease = await (async () => {
    try {
    report.admittedEnvironment = quietSnapshot();
    if (report.quietPreflight && (report.admittedEnvironment.load[0] > 3 || report.admittedEnvironment.pressure !== 1 || report.admittedEnvironment.competingHeavy.length || report.admittedEnvironment.swapUsedBytes > report.quietPreflight.snapshots.at(-1).swapUsedBytes))
      throw new Error('quiet conditions changed while awaiting the maintained lease');
    browser = await chromium.launch({ ...browserLaunch, headless:true, args:[...(browserLaunch.args??[]),'--autoplay-policy=no-user-gesture-required'], chromiumSandbox:true });
    report.browser = browser.version();
    const resourceSession = await browser.newBrowserCDPSession();
    report.backend = await resourceSession.send('SystemInfo.getInfo');
    report.browserLaunch = { headless:true, configuredArgs:[...(browserLaunch.args??[]),'--autoplay-policy=no-user-gesture-required'] };
    try { report.browserCommandLine = await resourceSession.send('Browser.getBrowserCommandLine'); }
    catch(error) { report.browserCommandLine = { unavailable:String(error) }; }
    const workerTargets = new Map();
    const pendingWorkerCommands = new Map();
    let workerCommandId = 0;
    const recordWorkerEvent = row => {
      const event = {...row, observedAt:new Date().toISOString()};
      report.workerTargetEvents.push(event);
      void appendFile(resolve(output,'worker-targets.jsonl'),JSON.stringify(event)+'\n');
    };
    const workerCommand = (state, method) => new Promise((resolveCommand, rejectCommand) => {
      const id = ++workerCommandId, key = `${state.sessionId}:${id}`;
      const timer = setTimeout(() => {
        pendingWorkerCommands.delete(key);
        rejectCommand(new Error(`worker target ${method} timed out`));
      }, 5000);
      pendingWorkerCommands.set(key, { resolve:resolveCommand, reject:rejectCommand, timer });
      resourceSession.send('Target.sendMessageToTarget', {
        sessionId:state.sessionId, message:JSON.stringify({id,method}),
      }).catch(error => {
        clearTimeout(timer); pendingWorkerCommands.delete(key); rejectCommand(error);
      });
    });
    const sampleWorkerHeap = async state => {
      if (!state.sessionId || state.destroyed || state.samplePending) return;
      state.samplePending = true;
      try {
        const heap = await workerCommand(state, 'Runtime.getHeapUsage');
        const sample = {targetId:state.targetId,url:state.info.url,type:state.info.type,
          parentId:state.info.parentId,sampledAt:new Date().toISOString(),heap};
        report.workerHeapSamples.push(sample);
        await appendFile(resolve(output,'worker-heaps.jsonl'),JSON.stringify(sample)+'\n');
      } catch(error) {
        const failure = {targetId:state.targetId,url:state.info.url,time:new Date().toISOString(),failure:String(error)};
        report.workerHeapSampleFailures.push(failure);
        await appendFile(resolve(output,'worker-heap-failures.jsonl'),JSON.stringify(failure)+'\n');
      } finally { state.samplePending = false; }
    };
    if (heapDiagnostic) {
      report.workerTargetEvents = [];
      report.workerHeapSamples = [];
      report.workerHeapSampleFailures = [];
      report.targetCrashEvents = [];
      resourceSession.on('Target.targetCrashed', event => {
        const row = {...event,observedAt:new Date().toISOString()};
        report.targetCrashEvents.push(row);
        void appendFile(resolve(output,'target-crashes.jsonl'),JSON.stringify(row)+'\n');
      });
      resourceSession.on('Target.receivedMessageFromTarget', event => {
        let message;
        try { message = JSON.parse(event.message); } catch { return; }
        const key = `${event.sessionId}:${message.id}`, pending = pendingWorkerCommands.get(key);
        if (!pending) return;
        clearTimeout(pending.timer); pendingWorkerCommands.delete(key);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      });
      resourceSession.on('Target.targetCreated', event => {
        const info = event.targetInfo;
        if (info.type !== 'worker') return;
        const state = {targetId:info.targetId,info,sessionId:undefined,destroyed:false,samplePending:false};
        workerTargets.set(state.targetId,state);
        recordWorkerEvent({event:'created',targetId:state.targetId,type:info.type,url:info.url,parentId:info.parentId});
        void resourceSession.send('Target.attachToTarget',{targetId:state.targetId,flatten:false}).then(async attached => {
          state.sessionId = attached.sessionId;
          const current = await resourceSession.send('Target.getTargetInfo',{targetId:state.targetId});
          state.info = current.targetInfo;
          recordWorkerEvent({event:'attached',targetId:state.targetId,type:state.info.type,url:state.info.url,parentId:state.info.parentId});
          await workerCommand(state,'Runtime.enable');
          await sampleWorkerHeap(state);
        }).catch(error => {
          const failure = {targetId:state.targetId,time:new Date().toISOString(),failure:String(error)};
          report.workerHeapSampleFailures.push(failure);
          void appendFile(resolve(output,'worker-heap-failures.jsonl'),JSON.stringify(failure)+'\n');
        });
      });
      resourceSession.on('Target.targetInfoChanged', event => {
        const state = workerTargets.get(event.targetInfo.targetId);
        if (!state) return;
        state.info = event.targetInfo;
        recordWorkerEvent({event:'info-changed',targetId:state.targetId,type:state.info.type,url:state.info.url,parentId:state.info.parentId});
      });
      resourceSession.on('Target.targetDestroyed', event => {
        const state = workerTargets.get(event.targetId);
        if (!state) return;
        state.destroyed = true;
        recordWorkerEvent({event:'destroyed',targetId:state.targetId,type:state.info.type,url:state.info.url,parentId:state.info.parentId});
      });
      await resourceSession.send('Target.setDiscoverTargets',{discover:true});
      workerHeapTimer = setInterval(() => {
        for (const state of workerTargets.values()) void sampleWorkerHeap(state);
      },1000);
    }
    report.resourceSamples = [];
    report.rssHighWaterKiB = 0;
    const sampleResources = async () => {
      const processInfo = await resourceSession.send('SystemInfo.getProcessInfo');
      const ids = processInfo.processInfo.map(row => row.id).filter(Number.isSafeInteger);
      const rssRows = ids.length ? execFileSync('ps',['-o','pid=,rss=','-p',ids.join(',')],{encoding:'utf8'}).trim().split('\n').filter(Boolean) : [];
      const rssByPid = new Map(rssRows.map(row => row.trim().split(/\s+/).map(Number))
        .filter(row => row.length === 2 && Number.isSafeInteger(row[0]) && Number.isFinite(row[1])));
      const rss = [...rssByPid.values()].reduce((sum,value)=>sum + value,0);
      report.rssHighWaterKiB = Math.max(report.rssHighWaterKiB,rss);
      report.resourceSamples.push({time:new Date().toISOString(),rssKiB:rss,processes:processInfo.processInfo,
        processRssKiB:processInfo.processInfo.map(row=>({id:row.id,type:row.type,rssKiB:rssByPid.get(row.id) ?? null}))});
      const environment = quietSnapshot();
      await appendFile(resolve(output,'environment.jsonl'),JSON.stringify(environment)+'\n');
      const {processes:inventory,...summary}=environment;
      (report.environmentSamples ??= []).push(summary);
    };
    await sampleResources();
    resourceTimer=setInterval(()=>void sampleResources().catch(error=>{
      (report.resourceSampleFailures??=[]).push({time:new Date().toISOString(),failure:String(error)});
      console.error('[music resource sample]',String(error));
    }),5000);
    const page = await browser.newPage({viewport:{width:1500,height:1100}});
    const pageHeapSession = heapDiagnostic ? await page.context().newCDPSession(page) : undefined;
    if (pageHeapSession) {
      await pageHeapSession.send('Runtime.enable');
      await pageHeapSession.send('Memory.startSampling', {samplingInterval:65536,suppressRandomness:true});
      report.pageHeapSamples = [];
      report.pageHeapSampleFailures = [];
    }
    const samplePageHeap = async receipt => {
      if (!pageHeapSession) return;
      try {
        const heap = await pageHeapSession.send('Runtime.getHeapUsage');
        const sample = {...receipt, sampledAt:new Date().toISOString(), heap};
        report.pageHeapSamples.push(sample);
        await appendFile(resolve(output,'page-heap.jsonl'),JSON.stringify(sample)+'\n');
      } catch(error) {
        report.pageHeapSampleFailures.push({time:new Date().toISOString(),stage:receipt.stage,failure:String(error)});
      }
    };
    const startupReceipt = async row => {
      const receipt = {...row,observedAt:new Date().toISOString()};
      (report.startupReceipts ??= []).push(receipt);
      if (receipt.stage === 'browser-worker-created' && receipt.url?.startsWith('blob:')) await samplePageHeap(receipt);
      try {await appendFile(resolve(output,'startup.jsonl'),JSON.stringify(receipt)+'\n');}
      catch(error) {report.startupReceiptFailure=String(error);process.exitCode=1;}
    };
    page.on('worker',worker=>{
      void startupReceipt({stage:'browser-worker-created',url:worker.url()});
      worker.on('close',()=>void startupReceipt({stage:'browser-worker-closed',url:worker.url()}));
    });
    page.on('requestfailed',request=>void startupReceipt({stage:'request-failed',url:request.url(),failure:request.failure()}));
    page.on('crash',()=>{
      report.failure ??= 'native browser page crashed'; process.exitCode=1;
      void startupReceipt({stage:'browser-page-crashed'});
      // A crashed page cannot complete its pending evaluation. Retire the
      // existing native owner now; the original positive stage budgets stay.
      void browser?.close().catch(error=>{report.crashCleanupFailure=String(error);});
    });
    await page.exposeFunction('__musicStartup',startupReceipt);
    const errors = [];report.errors=errors;
    page.on('pageerror',error=>{errors.push(String(error));void appendFile(resolve(output,'page-errors.jsonl'),JSON.stringify({time:new Date().toISOString(),failure:String(error)})+'\n');});
    page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());void appendFile(resolve(output,'page-errors.jsonl'),JSON.stringify({time:new Date().toISOString(),failure:message.text()})+'\n');}});
    stages = watchNativeStages(async row=>{
      report.lastStage=row;await appendFile(resolve(output,'stages.jsonl'),JSON.stringify(row)+'\n');
      console.log(`[music stage] ${row.probe}/${row.stage} ${row.status}`);
    },async row=>{
      report.stageDeadline=row;report.failure=`native music stage exceeded its original ${row.budgetMs}ms budget: ${row.probe}/${row.stage}`;
      process.exitCode=1;console.error(report.failure);clearInterval(resourceTimer);
      try {await appendFile(resolve(output,'stages.jsonl'),JSON.stringify(row)+'\n');}
      finally {await browser?.close();}
    });
    await page.exposeFunction('__musicStage',row=>stages.receive(row));
    await page.exposeFunction('__musicRetain', async (name, row) => {
      await retainNativeEvidence(output, name, row);
      if (row.wavBase64 === undefined) console.log(`[music] retained ${name}`);
    });
    await page.goto('http://localhost:5323');
    await page.waitForFunction(()=>globalThis.__musicEvidence);
    const sampleNativeMemory = async name => {
      if (!pageHeapSession) return;
      const profile = await pageHeapSession.send('Memory.getSamplingProfile');
      const heap = await pageHeapSession.send('Runtime.getHeapUsage');
      const dom = await pageHeapSession.send('Memory.getDOMCounters');
      await writeFile(resolve(output,`native-memory-${name}.json`),JSON.stringify({sampledAt:new Date().toISOString(),profile,heap,dom},null,2));
      await sampleResources();
    };
    await sampleNativeMemory('baseline');
    try {
      if(appCase) {
        report.diagnosticRepetitions = [];
        for (let repetition=0;repetition<appRepeat;repetition++) {
        const download = rhiCapture ? page.waitForEvent('download', { timeout: 90000 }) : undefined;
        const row = JSON.parse(await page.evaluate(async ({tier,count,delayFrames,falsifier,rhiCapture})=>JSON.stringify(await globalThis.__musicEvidence.app(tier,count,delayFrames,falsifier===true,true,rhiCapture)),{...appCase,rhiCapture}));
        if (download !== undefined) {
          const tape = await download;
          const tapePath = resolve(output, 'music-app.rhitape');
          await tape.saveAs(tapePath);
          const bytes = new Uint8Array(await readFile(tapePath));
          const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          if (row.rhiCapture?.bytes !== bytes.byteLength || !row.rhiCapture.digest.endsWith(digest.slice(7)))
            throw new Error('downloaded RHI tape does not match the captured artifact receipt');
          report.rhiCaptureArtifact = { path:tapePath, digest, bytes:bytes.byteLength };
        }
        await writeFile(resolve(output,appRepeat===1?'diagnostic-app.wav':`diagnostic-app-${repetition}.wav`),new Uint8Array(row.wav));delete row.wav;
        report.diagnosticRepetitions.push(row);
        await sampleNativeMemory(`app-${repetition}`);
        report.diagnosticResult=row;report.scope='one original App case; full frozen acceptance and clean performance remain required';
        if(!row.pass)process.exitCode=1;
        }
      } else {
      // These are persisted POD snapshots, not native handles. One JSON value avoids
      // the browser RPC's per-field object expansion while preserving all raw data.
      report.results = JSON.parse(await page.evaluate(async ({short,effectsOnly})=>JSON.stringify(await globalThis.__musicEvidence.run(short,effectsOnly)),
        {short:report.short,effectsOnly:report.effectsOnly}));
      for (const row of report.results.signals) {
        await copyFile(resolve(output,`signal-${row.count}.wav`),resolve(output,`stems-${row.count}.wav`)); delete row.wav;
      }
      await copyFile(resolve(output,'disabled.wav'),resolve(output,'disabled-stem.wav')); delete report.results.disabled.wav;
      await copyFile(resolve(output,'offline-600.wav'),resolve(output,'ten-minute-window.wav')); delete report.results.long.wav;
      for (const row of report.results.listening) delete row.wav;
      for (const row of report.results.resampling) delete row.wav;
      for (const row of report.results.immediate) delete row.wav;
      // The complete 600-second float PCM was retained before its oracle in realtime().
      for(const row of report.results.apps) {
        if(row.wav?.length) await writeFile(resolve(output,`${row.tier}-${row.count}-delay${row.delayFrames}.wav`),new Uint8Array(row.wav)); delete row.wav;
      }
      await page.screenshot({path:resolve(output,'native-signal-and-cost.png'),fullPage:true});
      if(!report.results.pass)process.exitCode=1;
      }
      if(workerRetirement) {
        report.workerRetirementResult = await captureWorkerRetirement(resourceSession,output);
        if(!report.workerRetirementResult.pass)throw new Error('native retirement requires zero Worker targets/global scopes after disposal');
      }
    } catch(error) {report.failure ??= String(error);process.exitCode=1;
      try{await page.screenshot({path:resolve(output,'failure.png'),fullPage:true});}catch(cause){report.failureCaptureError=String(cause);}
    }
    report.errors = errors;
    if(errors.length)process.exitCode=1;
    if(browser.isConnected()) {
      const cdp=await browser.newBrowserCDPSession();report.backend=await cdp.send('SystemInfo.getInfo');
      clearInterval(resourceTimer); await sampleResources();
    }
    report.cleanPerformance = Boolean(report.quietPreflight && report.results?.acceptanceComplete && !report.failure && !report.startupReceiptFailure && errors.length===0 && !report.resourceSampleFailures?.length
      && report.environmentSamples.every((row,index) => row.pressure === 1 && row.competingHeavy.length === 0
        && row.swapUsedBytes <= (report.environmentSamples[index-1] ?? report.admittedEnvironment).swapUsedBytes));
    return { label:'ROI23 prepared native audio and App evidence',lockPath:'/tmp/forgeax-physical-gpu.lock' };
    } finally {
      stages?.dispose();clearInterval(resourceTimer);clearInterval(workerHeapTimer);
      // Await the owned browser's cleanup before the maintained holder releases.
      await browser?.close();browser=undefined;
      await stages?.settled();
    }
  })();
} catch(error) {
  report.failure ??= String(error); process.exitCode=1;
} finally {
  clearInterval(resourceTimer);
  await browser?.close(); await new Promise(resolve=>server.httpServer.close(resolve));
  report.finishedAt=new Date().toISOString();report.host.loadAfter=loadavg();
  report.finalSourceHashes=await sourceHashes(root);report.finalSiteHashes=await siteHashes(root,site);
  if(JSON.stringify(report.sourceHashes)!==JSON.stringify(report.finalSourceHashes)){report.changedDuringRun=true;report.cleanPerformance=false;process.exitCode=1;}
  if(JSON.stringify(report.siteHashes)!==JSON.stringify(report.finalSiteHashes)){report.changedDuringRun=true;report.cleanPerformance=false;process.exitCode=1;}
  await writeFile(resolve(output,'raw.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,failure:report.failure,pass:report.results?.pass,errors:report.errors?.length}));
}
