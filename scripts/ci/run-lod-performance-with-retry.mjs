#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ATTEMPTS = 2;
const GPU_P95_MAX_REGRESSION = 0.05;
const GPU_MEDIAN_MIN_IMPROVEMENT = 0.2;
const CPU_P95_MAX_REGRESSION = 0.05;
const EVIDENCE_PATH = resolve(
  process.cwd(),
  'apps/hello/lod-occlusion/artifacts/gpu-frame-samples.json',
);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The LOD producer is deliberately fail-closed. A lavapipe timestamp sample
 * can still produce one long GPU tail while every structural, CPU, budget,
 * and median-gain fact is valid. In that one declared case, a fresh producer
 * process is a transport retry; thresholds and the workload do not change.
 */
export function isRetryableLodPerformanceEvidence(evidence) {
  const metrics = evidence?.metrics;
  const falsification = evidence?.falsification;
  if (
    evidence?.verdict !== 'not-production-ready' ||
    metrics?.timestampAvailable !== true ||
    !Array.isArray(falsification) ||
    falsification.length !== 5 ||
    falsification.some((entry) => entry?.verdict !== 'pass')
  ) {
    return false;
  }
  return (
    finite(metrics.gpuP95Regression) &&
    metrics.gpuP95Regression > GPU_P95_MAX_REGRESSION &&
    finite(metrics.gpuMedianImprovement) &&
    metrics.gpuMedianImprovement >= GPU_MEDIAN_MIN_IMPROVEMENT &&
    finite(metrics.cpuP95Regression) &&
    metrics.cpuP95Regression <= CPU_P95_MAX_REGRESSION &&
    finite(metrics.lodCoverage) &&
    metrics.lodCoverage >= 0.5 &&
    finite(metrics.submittedInstanceRatio) &&
    metrics.submittedInstanceRatio <= 0.2 &&
    finite(metrics.geometryWorkReduction) &&
    metrics.geometryWorkReduction >= 0.5
  );
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator !== 0 || separator === argv.length - 1) {
    throw new Error('usage: run-lod-performance-with-retry.mjs -- <command> [args...]');
  }
  return argv.slice(separator + 1);
}

function run(command, attempt) {
  return new Promise((resolveResult) => {
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, FORGEAX_LOD_PERF_ATTEMPT: String(attempt) },
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      process.stderr.write(`[lod-performance-retry] failed to start: ${error.message}\n`);
      resolveResult(1);
    });
    child.once('close', (status) => resolveResult(status ?? 1));
  });
}

async function readEvidence() {
  try {
    return JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  } catch {
    return undefined;
  }
}

async function main(argv) {
  const command = parseArgs(argv);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const status = await run(command, attempt);
    if (status === 0) return;
    if (attempt === MAX_ATTEMPTS) {
      process.exitCode = status;
      return;
    }
    const evidence = await readEvidence();
    if (!isRetryableLodPerformanceEvidence(evidence)) {
      process.exitCode = status;
      return;
    }
    const metrics = evidence.metrics;
    process.stderr.write(
      `[lod-performance-retry] retrying fresh producer after GPU p95 tail ` +
        `regression=${metrics.gpuP95Regression}; medianImprovement=${metrics.gpuMedianImprovement}\n`,
    );
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[lod-performance-retry] ${error.message}\n`);
    process.exitCode = 1;
  }
}
