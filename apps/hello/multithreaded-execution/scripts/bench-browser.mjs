import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { waitForPreview } from './preview-readiness.mjs';
import {
  assessProductImprovement,
  assessRunnerQualification,
  pauseEvidence,
  detectRunnerPause,
  summarize,
} from './benchmark-statistics.mjs';
import { chromeLaunchOptions } from './chrome-options.mjs';
import { runnerResources } from '../../../../scripts/lib/runner-resources.mjs';

const port = 5200;
const warmupCount = 20;
const sampleCount = 240;
const roundCount = 2;
const requiredImprovement = 0.15;
const requiredFrameSamples = warmupCount + sampleCount;
const sampleTimeoutMs = 120_000;
const runner = runnerResources();
const server = await preview({
  preview: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
});

async function readCgroupEvidence() {
  const read = async (file) => {
    try {
      return (await readFile(file, 'utf8')).trim();
    } catch {
      return null;
    }
  };
  const [cpuMax, cpuStat, memoryMax] = await Promise.all([
    read('/sys/fs/cgroup/cpu.max'),
    read('/sys/fs/cgroup/cpu.stat'),
    read('/sys/fs/cgroup/memory.max'),
  ]);
  return { cpuMax, cpuStat, memoryMax };
}

async function readinessDiagnostics(page) {
  return page
    .evaluate(() => {
      const scope = globalThis;
      const report = scope.__forgeaxExecutionReport?.();
      return {
        frameSamples: scope.__forgeaxExecutionFrameSamples?.length ?? 0,
        report,
        documentHidden: document.hidden,
        readyState: document.readyState,
        hardwareConcurrency: navigator.hardwareConcurrency,
        crossOriginIsolated: scope.crossOriginIsolated,
        userAgent: navigator.userAgent,
      };
    })
    .catch((error) => ({ evaluateError: String(error) }));
}

async function measure(browser, tier) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/?tier=${tier}&profile=1`, {
      waitUntil: 'domcontentloaded',
    });
    try {
      await page.waitForFunction(
        (required) => globalThis.__forgeaxExecutionFrameSamples?.length >= required,
        requiredFrameSamples,
        { timeout: sampleTimeoutMs },
      );
    } catch (error) {
      const diagnostic = await readinessDiagnostics(page);
      const cgroup = await readCgroupEvidence();
      const healthy =
        diagnostic.report?.engine?.health === 'running' &&
        diagnostic.report?.world?.health === 'healthy';
      const transientFrameDeadline =
        errors.length === 0 &&
        diagnostic.frameSamples > warmupCount &&
        diagnostic.report?.engine?.health === 'faulted' &&
        diagnostic.report?.world?.health === 'healthy' &&
        diagnostic.report?.world?.partialWrite === false &&
        diagnostic.report?.fault?.code === 'app-execution-deadline-exceeded' &&
        diagnostic.report?.fault?.detail?.phase === 'frame';
      if (transientFrameDeadline) {
        throw new Error(
          `[multithreaded benchmark] browser readiness timeout; runner instability: ${JSON.stringify({
            tier,
            requiredFrameSamples,
            sampleTimeoutMs,
            diagnostic,
            cgroup,
            reason: 'transient-frame-deadline-after-healthy-progress',
          })}`,
        );
      }
      if (errors.length === 0 && healthy) {
        throw new Error(
          `[multithreaded benchmark] browser readiness timeout; runner instability: ${JSON.stringify({
            tier,
            requiredFrameSamples,
            sampleTimeoutMs,
            diagnostic,
            cgroup,
          })}`,
        );
      }
      throw new Error(
        `[multithreaded benchmark] browser readiness failed: ${JSON.stringify({
          tier,
          requiredFrameSamples,
          sampleTimeoutMs,
          diagnostic,
          cgroup,
          pageErrors: errors,
          cause: String(error),
        })}`,
      );
    }
    const result = await page.evaluate(() => ({
      report: globalThis.__forgeaxExecutionReport(),
      frameSamples: globalThis.__forgeaxExecutionFrameSamples,
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      capture: globalThis.__forgeaxExecutionCapture(),
    }));
    if (errors.length > 0) throw new Error(`${tier} page errors: ${errors.join(' | ')}`);
    return result;
  } finally {
    await page.close().catch(() => undefined);
  }
}

function hostFrameSamples(capture) {
  return capture.records
    .filter(
      (record) =>
        record.kind === 'phase' && record.source === 'app' && record.phase === 'host-frame',
    )
    .map((record) => record.durationMicros / 1_000);
}

try {
  await waitForPreview(server);
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  // Alternate treatment order so a thermal/scheduler epoch cannot be
  // mistaken for a tier effect. Each mode gets one window in each order;
  // the existing lower-bound threshold remains unchanged.
  const orders = [
    ['engine-worker', 'shared'],
    ['shared', 'engine-worker'],
  ];
  const runs = [];
  for (const [round, order] of orders.entries()) {
    for (const tier of order) {
      runs.push({ round: round + 1, tier, result: await measure(browser, tier) });
    }
  }
  await browser.close();
  const tierRuns = (tier) => runs.filter((run) => run.tier === tier);
  const collectSamples = (tier, source) =>
    tierRuns(tier).flatMap((run) => source(run.result).slice(warmupCount, warmupCount + sampleCount));
  const inlineRuns = tierRuns('engine-worker');
  const sharedRuns = tierRuns('shared');
  const inlineCadence = collectSamples('engine-worker', (result) => result.frameSamples);
  const sharedCadence = collectSamples('shared', (result) => result.frameSamples);
  const inlineSamples = collectSamples('engine-worker', (result) => hostFrameSamples(result.capture));
  const sharedSamples = collectSamples('shared', (result) => hostFrameSamples(result.capture));
  if (
    inlineSamples.length !== roundCount * sampleCount ||
    sharedSamples.length !== roundCount * sampleCount
  ) {
    throw new Error(
      `profile sample count mismatch: inline=${inlineSamples.length}, shared=${sharedSamples.length}`,
    );
  }
  const inlineFrame = summarize(inlineSamples);
  const sharedFrame = summarize(sharedSamples);
  const runnerPauses = [
    { tier: 'engine-worker', ...detectRunnerPause(inlineSamples) },
    { tier: 'shared', ...detectRunnerPause(sharedSamples) },
  ].filter(({ detected }) => detected);
  const verdict = assessProductImprovement(
    inlineSamples,
    sharedSamples,
    requiredImprovement,
  );
  const browserHardwareConcurrency = [
    ...new Set(runs.map((run) => run.result.hardwareConcurrency)),
  ];
  const runnerQualification = assessRunnerQualification({
    runnerCpuCount: runner.cpus,
    browserHardwareConcurrency: Math.max(...browserHardwareConcurrency),
    containerized: runner.containerized,
  });
  const collectMetric = (tier, key) =>
    tierRuns(tier).map((run) => run.result.report.performance[key]);
  const collectDispatch = (tier) => tierRuns(tier).map((run) => run.result.report.kernelDispatch);
  const evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    protocol: {
      productionBuild: true,
      sameBrowser: true,
      sameWorkload: true,
      warmupCount,
      sampleCount,
      roundCount,
      order: orders,
      workload: { rows: 65_536, iterationsPerRow: 96 },
    },
    environment: {
      runner: {
        name: process.env.RUNNER_NAME ?? null,
        vcpus: runner.cpus,
        memoryBytes: runner.memoryBytes,
        containerized: runner.containerized,
        source: runner.containerized ? 'cgroup' : 'host',
        cpuAffinity: process.env.FORGEAX_RUNNER_CPU_AFFINITY
          ? JSON.parse(process.env.FORGEAX_RUNNER_CPU_AFFINITY)
          : null,
      },
      browserHardwareConcurrency,
      userAgents: [...new Set(runs.map((run) => run.result.userAgent))],
      crossOriginIsolated: [...new Set(runs.map((run) => run.result.crossOriginIsolated))],
      runnerQualification,
      pauseEvidence: {
        inline: pauseEvidence(inlineSamples),
        shared: pauseEvidence(sharedSamples),
      },
    },
    inline: {
      workers: inlineRuns.map((run) => run.result.report.workers),
      frame: inlineFrame,
      rawSamplesMs: inlineSamples,
      presentationCadence: summarize(inlineCadence),
      workerRoundTrip: collectMetric('engine-worker', 'hostFrameMs'),
      engineUpdate: collectMetric('engine-worker', 'engineUpdateMs'),
      runs: inlineRuns.map((run) => ({ round: run.round })),
    },
    shared: {
      workers: sharedRuns.map((run) => run.result.report.workers),
      frame: sharedFrame,
      rawSamplesMs: sharedSamples,
      presentationCadence: summarize(sharedCadence),
      workerRoundTrip: collectMetric('shared', 'hostFrameMs'),
      engineUpdate: collectMetric('shared', 'engineUpdateMs'),
      kernelWait: collectMetric('shared', 'kernelWaitMs'),
      kernelDispatch: collectDispatch('shared'),
      runs: sharedRuns.map((run) => ({ round: run.round })),
    },
    verdict,
    runnerPauses,
  };
  const evidencePath = resolve(
    process.cwd(),
    '../../../artifacts/feat-20260807-web-ts-multithreaded-engine-architecture/m3/evidence/product-benchmark.json',
  );
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (runnerPauses.length > 0) {
    process.stderr.write(
      `[multithreaded benchmark] runner pause detected; runner instability: ${JSON.stringify(runnerPauses)}\n`,
    );
    process.exitCode = 1;
  } else if (!runnerQualification.ok) {
    process.stderr.write(
      `[multithreaded benchmark] runner-unqualified: ${JSON.stringify(runnerQualification)}\n`,
    );
    process.exitCode = 1;
  } else if (!evidence.verdict.passed) {
    process.stderr.write('[multithreaded benchmark] performance verdict failed\n');
    process.exitCode = 1;
  }
} finally {
  await server.close();
}
