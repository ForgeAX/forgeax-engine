import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { measureAllocations } from '../../../skills/forgeax-engine-performance/scripts/allocation_probe.mjs';

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
assert.ok(
  baselinePath && candidatePath && outputPath,
  'Pass baseline.mjs candidate.mjs output-directory',
);
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const paths = [baselinePath, candidatePath].map((path) => resolve(path));
const arms = await Promise.all(paths.map((path) => import(pathToFileURL(path).href)));
assert.deepEqual(arms[0].modes, arms[1].modes);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const calls = 1000;
const controlRing = new Array(32);
function allocationControl(index) {
  controlRing[index & 31] = new Array(32).fill(index);
  return controlRing[index & 31][0];
}
function time(target, cpuCalls) {
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < cpuCalls; index++) target.run(index);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  return {
    wallNsPerCall: (wallMs * 1e6) / cpuCalls,
    cpuNsPerCall: ((used.user + used.system) * 1000) / cpuCalls,
  };
}
const report = {
  node: process.version,
  cpu: cpus()[0]?.model,
  loadBefore: loadavg(),
  allocationCallsPerSample: calls,
  cpuCallsPerSample: { fog: 100000, environment: 2000 },
  cpuPairs: 7,
  allocationRounds: 3,
  method:
    'Alternating paired complete production helper calls. Cases measure either selectFogFrame alone or selectFogFrame followed by extractWorldEnvironment, including the real camera/sun/atmosphere producers. Cloud Time advancement and moving-pose writes are included in their case. Fixture construction and module initialization are outside timing; every result escapes through a 32-slot ring. CPU-only synthetic evidence, not Worker/GPU acceptance. Raw profiles include collected objects and explicit target-frame attribution.',
  sha256: Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  ),
  results: [],
};
const coldImport = `
  globalThis.gc();
  const heap = process.memoryUsage().heapUsed;
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  await import(process.argv[1]);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  globalThis.gc();
  console.log(JSON.stringify({wallMs, cpuMs:(used.user+used.system)/1000,
    retainedHeapDelta:process.memoryUsage().heapUsed-heap}));
`;
report.coldModuleImports = [];
for (let pair = 0; pair < 3; pair++) {
  const result = [];
  for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
    result[arm] = JSON.parse(
      execFileSync(
        process.execPath,
        ['--expose-gc', '--input-type=module', '-e', coldImport, pathToFileURL(paths[arm]).href],
        { encoding: 'utf8' },
      ),
    );
  }
  report.coldModuleImports.push({ baseline: result[0], candidate: result[1] });
}
const { profile: controlProfile, ...control } = await measureAllocations(allocationControl, {
  calls,
  warmup: 512,
  samplingWarmup: 256,
  samplingInterval: 128,
  includeProfile: true,
  targetFrame: { url: import.meta.url, functionName: 'allocationControl' },
});
assert.ok(control.bytesPerCall > 64, 'Allocation sampler must detect the escaping array control');
await writeFile(
  resolve(output, 'allocation-control.heap-profile.json'),
  JSON.stringify(controlProfile),
  { flag: 'wx' },
);
report.allocationControl = control;
for (const mode of arms[0].modes) {
  const cpuCalls = mode.startsWith('fog-') ? 100000 : 2000;
  const cases = arms.map((arm) => arm.createCase(mode));
  for (let index = 0; index < 512; index++) assert.equal(cases[0].run(index), cases[1].run(index));
  for (const target of cases) time(target, cpuCalls);
  const samples = [];
  for (let pair = 0; pair < report.cpuPairs; pair++) {
    const result = [];
    for (const arm of pair % 2 ? [1, 0] : [0, 1]) result[arm] = time(cases[arm], cpuCalls);
    assert.deepEqual(cases[0].inspect(), cases[1].inspect());
    samples.push({ baseline: result[0], candidate: result[1] });
  }
  const allocations = [];
  for (let round = 0; round < report.allocationRounds; round++) {
    const result = [];
    for (const arm of round % 2 ? [1, 0] : [0, 1]) {
      const { profile, ...sample } = await measureAllocations(cases[arm].run, {
        calls,
        warmup: 512,
        samplingWarmup: 256,
        samplingInterval: 128,
        includeProfile: true,
        targetFrame: { url: pathToFileURL(paths[arm]).href, functionName: 'projectionTarget' },
      });
      await writeFile(
        resolve(output, `${mode}-${arm}-${round}.heap-profile.json`),
        JSON.stringify(profile),
        { flag: 'wx' },
      );
      result[arm] = sample;
    }
    assert.deepEqual(cases[0].inspect(), cases[1].inspect());
    allocations.push({ baseline: result[0], candidate: result[1] });
  }
  const result = {
    mode,
    cpuCallsPerSample: cpuCalls,
    samples,
    allocations,
    cpuNsPerCall: ['baseline', 'candidate'].map((arm) =>
      median(samples.map((sample) => sample[arm].cpuNsPerCall)),
    ),
    wallNsPerCall: ['baseline', 'candidate'].map((arm) =>
      median(samples.map((sample) => sample[arm].wallNsPerCall)),
    ),
    bytesPerCall: ['baseline', 'candidate'].map((arm) =>
      median(allocations.map((sample) => sample[arm].bytesPerCall)),
    ),
  };
  report.results.push(result);
  console.log(
    JSON.stringify({
      mode,
      cpuNsPerCall: result.cpuNsPerCall,
      wallNsPerCall: result.wallNsPerCall,
      bytesPerCall: result.bytesPerCall,
    }),
  );
}
report.loadAfter = loadavg();
await writeFile(resolve(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
