import { writeFileSync } from 'node:fs';
import { attachBrowserGamepadFeedback } from '../src/browser-gamepad-feedback';
import { createGamepadFeedback } from '../src/gamepad-feedback';

// Contract load only. No hardware, mechanical amplitude or onset measurements.
const sampleCount = 1000;
const warmup = 100;
const budgetP95Ms = 1;
const rows: { round: number; targets: number; mode: string; sample: number; ms: number; pending: number }[] = [];
const summaries: unknown[] = [];
for (let round = 0; round < 3; round++) {
  for (const count of [1, 2, 4]) for (const mode of ['idle', 'event', 'burst']) {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as Document;
    const win = new EventTarget() as Window;
    let nativeCalls = 0;
    const pads = Array.from({ length: count }, (_, index) => ({
      index, id: `contract-${index}`, connected: true, mapping: 'standard', buttons: [], axes: [],
      vibrationActuator: { effects: ['dual-rumble'],
        playEffect: () => { nativeCalls++; return Promise.resolve('complete'); },
        reset: () => { nativeCalls++; return Promise.resolve('complete'); },
      },
    }));
    const host = attachBrowserGamepadFeedback(doc, win);
    const source = createGamepadFeedback();
    host.observe(pads);
    const heapBefore = process.memoryUsage().heapUsed;
    for (let sample = -warmup; sample < sampleCount; sample++) {
      const start = performance.now();
      host.observe(pads); // Host consumes the one scan; no extra native discovery.
      if (mode === 'burst' || (mode === 'event' && sample % 60 === 0)) {
        for (let n = 0; n < (mode === 'burst' ? 32 : count); n++) {
          const target = host.target(n % count);
          if (!target) throw new Error('missing target');
          source.play(target, { durationMs: 120, strongMagnitude: 0.8, weakMagnitude: 0.2 });
        }
      }
      host.dispatch(structuredClone(source.drainIntents()));
      const pending = host.inspect().pendingNative;
      await Promise.resolve(); await Promise.resolve();
      const observation = structuredClone(host.sampleResults());
      source.acceptResults(observation.feedbackResults, observation.feedbackLostResults);
      source.readResults();
      const ms = performance.now() - start;
      if (sample >= 0) rows.push({ round, targets: count, mode, sample, ms, pending });
    }
    const samples = rows.filter(row => row.round === round && row.targets === count && row.mode === mode);
    const values = samples.map(row => row.ms).sort((a, b) => a - b);
    const p95 = values[Math.floor(values.length * 0.95)] ?? Infinity;
    summaries.push({ round, targets: count, mode, p50Ms: values[500], p95Ms: p95,
      p95BudgetMs: budgetP95Ms, pass: p95 <= budgetP95Ms, nativeCalls,
      pendingHighWater: Math.max(...samples.map(row => row.pending)), pendingAfter: host.inspect().pendingNative,
      heapDeltaBeforeGcBytes: process.memoryUsage().heapUsed - heapBefore });
    host.detach(); source.dispose();
  }
}
const prefix = process.argv[2] ?? 'packages/input/reports/roi-20-gamepad-haptics/contract-performance';
writeFileSync(`${prefix}.json`, JSON.stringify({ physicalEvidence: false, runtime: process.versions,
  platform: process.platform, arch: process.arch, sampleCount, warmup, rounds: 3,
  method: 'Host observation + producer + actual structuredClone roundtrip + dispatch + native-double settlement + result polling; each sample awaits two microtasks. Heap delta is uncollected churn, not retained memory or per-frame allocation.', summaries }, null, 2));
writeFileSync(`${prefix}.csv`, 'round,targets,mode,sample,ms,pending\n' + rows.map(row => Object.values(row).join(',')).join('\n') + '\n');
console.log(JSON.stringify(summaries));
if (summaries.some(item => !(item as { pass: boolean }).pass)) process.exitCode = 1;
