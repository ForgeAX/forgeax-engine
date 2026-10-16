#!/usr/bin/env node

// Physical performance carrier for the existing 10k-cubes workload. The
// native runner owns adapter creation and timing; this entry point owns the
// manifest, exact-revision check, raw-sample preservation, and fail-closed
// admission. It never substitutes a software, browser, RhiNull, or Dawn
// result for physical timing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const manifestPath = resolve(appRoot, 'physical-benchmark-manifest.json');
const MINIMUM_SAMPLES = 30;
const FORBIDDEN_ADAPTER_MARKERS = /browser|chromium|gputrace|depot_tools|swiftshader|lavapipe|software/i;

function currentRevision(cwd = repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv, env = process.env) {
  let input;
  let output = env.FORGEAX_PHYSICAL_BENCHMARK_OUTPUT;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--input') {
      input = argv[++index];
    } else if (argument === '--output') {
      output = argv[++index];
    } else if (argument !== undefined) {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return {
    input: input ?? env.FORGEAX_PHYSICAL_BENCHMARK_INPUT,
    output: output ?? resolve(appRoot, 'artifacts', 'physical-benchmark.json'),
  };
}

function nearestRank(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[rank - 1] ?? null;
}

function stats(values) {
  return {
    count: values.length,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

function finiteSamples(value, name, minimumSamples) {
  if (!Array.isArray(value)) return { values: [], errors: [`${name} must be an array`] };
  const values = value.filter((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0);
  const errors = [];
  if (values.length !== value.length) errors.push(`${name} contains non-finite or negative samples`);
  if (values.length < minimumSamples) errors.push(`${name} has ${values.length} samples; need at least ${minimumSamples}`);
  return { values, errors };
}

function failClosed({ revision, reason, inputPath = null, input = null }) {
  return {
    schemaVersion: 'forgeax-physical-benchmark/1',
    status: 'not-run',
    acceptance: 'fail-closed',
    reason,
    testedRevision: revision,
    source: inputPath,
    adapter: null,
    capture: null,
    workloads: [],
    evidence: input === null ? null : { rejectedInput: input },
  };
}

function validateAdapter(input) {
  const adapter = input?.adapter;
  const runner = input?.runner;
  const errors = [];
  if (input?.schemaVersion !== 'forgeax-physical-benchmark-input/1') {
    errors.push('schemaVersion must be forgeax-physical-benchmark-input/1');
  }
  if (input?.status !== 'complete') errors.push('input status must be complete');
  if (adapter?.api !== 'webgpu') errors.push('adapter.api must be webgpu');
  if (adapter?.physical !== true) errors.push('adapter.physical must be true');
  if (adapter?.isFallbackAdapter !== false) errors.push('adapter.isFallbackAdapter must be false');
  if (adapter?.timestampQuery !== true) errors.push('adapter.timestampQuery must be true');
  for (const key of ['vendor', 'device', 'driver']) {
    if (typeof adapter?.[key] !== 'string' || adapter[key].trim().length === 0) {
      errors.push(`adapter.${key} is required`);
    }
  }
  if (FORBIDDEN_ADAPTER_MARKERS.test(JSON.stringify({ adapter, runner }))) {
    errors.push('adapter/runner identifies a forbidden substitute rather than a physical native adapter');
  }
  if (runner?.kind !== 'native-physical') errors.push('runner.kind must be native-physical');
  for (const key of ['name', 'class', 'environment', 'os', 'arch', 'queue']) {
    if (typeof runner?.[key] !== 'string' || runner[key].trim().length === 0) {
      errors.push(`runner.${key} is required`);
    }
  }
  return errors;
}

function validateCapture(input, manifest) {
  const capture = input?.capture;
  const errors = [];
  if (capture?.seed !== manifest.seed) errors.push(`capture.seed must be ${manifest.seed}`);
  if (capture?.cameraPath !== manifest.cameraPath) errors.push(`capture.cameraPath must be ${manifest.cameraPath}`);
  if (capture?.resolution?.width !== manifest.resolution.width || capture?.resolution?.height !== manifest.resolution.height) {
    errors.push('capture.resolution must match the manifest');
  }
  if (!Number.isInteger(capture?.warmupFrames) || capture.warmupFrames < manifest.warmupFrames) {
    errors.push(`capture.warmupFrames must be at least ${manifest.warmupFrames}`);
  }
  if (!Number.isInteger(capture?.sampleCount) || capture.sampleCount < manifest.minimumSamples) {
    errors.push(`capture.sampleCount must be at least ${manifest.minimumSamples}`);
  }
  if (!Number.isFinite(capture?.memoryHighWaterBytes) || capture.memoryHighWaterBytes <= 0) {
    errors.push('capture.memoryHighWaterBytes must be a positive finite number');
  }
  return errors;
}

function validateCommonSamples(raw, minimumSamples) {
  const measured = {};
  const errors = [];
  for (const key of ['cpuMs', 'gpuMs', 'frameMs']) {
    const result = finiteSamples(raw?.[key], `workload.${key}`, minimumSamples);
    measured[key] = result.values;
    errors.push(...result.errors);
  }
  return { measured, errors };
}

function validateWorkload(raw, spec, minimumSamples) {
  const errors = [];
  if (raw?.id !== spec.id) errors.push(`workload id ${spec.id} is missing or mismatched`);
  const common = validateCommonSamples(raw, minimumSamples);
  errors.push(...common.errors);
  const observed = raw?.observed;
  if (observed?.drawItems !== spec.drawItems) errors.push(`${spec.id}.observed.drawItems must be ${spec.drawItems}`);
  if (spec.resourceClasses !== undefined && observed?.resourceClasses !== spec.resourceClasses) {
    errors.push(`${spec.id}.observed.resourceClasses must be ${spec.resourceClasses}`);
  }
  if (spec.kind === 'pbr-resource-class') {
    if (observed?.batchCount !== spec.resourceClasses) {
      errors.push(`${spec.id}.observed.batchCount must equal resourceClasses (${spec.resourceClasses})`);
    }
    if (observed?.perEntityBindingCreates !== 0) {
      errors.push(`${spec.id}.observed.perEntityBindingCreates must be 0`);
    }
  }
  if (spec.kind === 'pbr-numeric') {
    const baselineResult = finiteSamples(raw?.baselineFrameMs, `${spec.id}.baselineFrameMs`, minimumSamples);
    errors.push(...baselineResult.errors);
    if (
      common.measured.frameMs.length >= minimumSamples &&
      baselineResult.values.length >= minimumSamples &&
      nearestRank(common.measured.frameMs, 0.95) > nearestRank(baselineResult.values, 0.95)
    ) {
      errors.push(`${spec.id} frame p95 exceeds the direct-draw baseline`);
    }
  }
  if (spec.kind === 'shadow') {
    if (observed?.viewCount !== spec.shadowViews.length) {
      errors.push(`${spec.id}.observed.viewCount must be ${spec.shadowViews.length}`);
    }
    const channels = observed?.channels;
    if (!Array.isArray(channels) || spec.shadowViews.some((view) => !channels.includes(view))) {
      errors.push(`${spec.id}.observed.channels must include every declared shadow view`);
    }
    if (observed?.perEntityBindingCreates !== 0) errors.push(`${spec.id}.observed.perEntityBindingCreates must be 0`);
    if (observed?.cpuWorkPerView !== true) errors.push(`${spec.id}.observed.cpuWorkPerView must be true`);
  }
  if (spec.kind === 'skin' || spec.kind === 'skin-mixed') {
    if (observed?.joints !== spec.joints) errors.push(`${spec.id}.observed.joints must be ${spec.joints}`);
    if (observed?.stablePaletteUploadBytes !== 0) errors.push(`${spec.id}.observed.stablePaletteUploadBytes must be 0`);
    if (!Array.isArray(observed?.dirtyJointCounts) || observed.dirtyJointCounts.length === 0) {
      errors.push(`${spec.id}.observed.dirtyJointCounts must contain dirty-range evidence`);
    }
    if (!Array.isArray(observed?.paletteUploadBytes) || observed.paletteUploadBytes.length === 0) {
      errors.push(`${spec.id}.observed.paletteUploadBytes must contain raw upload evidence`);
    }
  }
  if (spec.kind === 'skin-mixed') {
    if (observed?.rigidDrawItems !== spec.rigidDrawItems || observed?.skinnedDrawItems !== spec.skinnedDrawItems) {
      errors.push(`${spec.id}.observed rigid/skinned composition must match the manifest`);
    }
  }
  if (spec.kind === 'mixed') {
    const baselineResult = finiteSamples(raw?.baselineFrameMs, `${spec.id}.baselineFrameMs`, minimumSamples);
    errors.push(...baselineResult.errors);
    if (
      common.measured.frameMs.length >= minimumSamples &&
      baselineResult.values.length >= minimumSamples &&
      nearestRank(common.measured.frameMs, 0.95) > nearestRank(baselineResult.values, 0.95) * 1.05
    ) {
      errors.push(`${spec.id} frame p95 exceeds the 5% direct-draw budget`);
    }
  }
  return {
    report: {
      id: spec.id,
      kind: spec.kind,
      drawItems: spec.drawItems,
      measured: {
        cpuMs: stats(common.measured.cpuMs),
        gpuMs: stats(common.measured.gpuMs),
        frameMs: stats(common.measured.frameMs),
      },
      observed: observed ?? null,
      rawSamples: {
        cpuMs: common.measured.cpuMs,
        gpuMs: common.measured.gpuMs,
        frameMs: common.measured.frameMs,
        ...(Array.isArray(raw?.baselineFrameMs) ? { baselineFrameMs: raw.baselineFrameMs } : {}),
      },
      status: errors.length === 0 ? 'pass' : 'fail',
      errors,
    },
  };
}

function validateInput(input, manifest, revision, inputPath) {
  const admissionErrors = [...validateAdapter(input), ...validateCapture(input, manifest)];
  if (input?.testedRevision !== revision) admissionErrors.push('testedRevision does not match checkout HEAD');
  if (admissionErrors.length > 0) {
    return {
      ...failClosed({
        revision,
        reason: admissionErrors.join('; '),
        inputPath,
        input,
      }),
      runner: input?.runner ?? null,
    };
  }
  const errors = [];
  const rawById = new Map(Array.isArray(input?.workloads) ? input.workloads.map((workload) => [workload.id, workload]) : []);
  const workloads = [];
  for (const spec of manifest.workloads) {
    const raw = rawById.get(spec.id);
    const result = validateWorkload(raw, spec, manifest.minimumSamples ?? MINIMUM_SAMPLES);
    workloads.push(result.report);
    errors.push(...result.report.errors);
  }
  if (rawById.size !== manifest.workloads.length) errors.push('input workloads must match the manifest exactly');

  const numeric10k = workloads.find((workload) => workload.id === 'pbr-numeric-10k');
  const numeric100k = workloads.find((workload) => workload.id === 'pbr-numeric-100k');
  const numeric10kP95 = numeric10k?.measured.cpuMs.p95;
  const numeric100kP95 = numeric100k?.measured.cpuMs.p95;
  if (Number.isFinite(numeric10kP95) && Number.isFinite(numeric100kP95)) {
    const upperBound = Math.max(numeric10kP95 * 1.1, numeric10kP95 + 0.25);
    if (numeric100kP95 > upperBound) {
      errors.push(`pbr-numeric-100k CPU p95=${numeric100kP95} exceeds bound=${upperBound}`);
    }
  }
  const result = {
    schemaVersion: 'forgeax-physical-benchmark/1',
    status: errors.length === 0 ? 'passed' : 'failed',
    acceptance: errors.length === 0 ? 'accepted' : 'fail-closed',
    testedRevision: revision,
    source: 'native-physical-runner-input',
    runner: input.runner,
    adapter: input.adapter,
    capture: input.capture,
    thresholds: {
      pbrNumericCpuP95: 'max(1.10 * p95(10k), p95(10k) + 0.25ms)',
      mixedFrameP95: '<= 1.05 * direct-draw p95',
    },
    workloads,
    errors,
    rawInput: input,
  };
  return result;
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv, env);
  const revision = currentRevision();
  const outputPath = resolve(args.output);
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    throw new Error(`physical benchmark manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inputPath = args.input;
  let report;
  if (inputPath === undefined || inputPath.length === 0) {
    report = failClosed({
      revision,
      reason: 'physical adapter evidence unavailable; provide --input from a native-physical runner',
    });
  } else if (!existsSync(resolve(inputPath))) {
    report = failClosed({
      revision,
      reason: `physical benchmark input is missing: ${inputPath}`,
      inputPath,
    });
  } else {
    let input;
    try {
      input = readJson(resolve(inputPath));
    } catch (error) {
      report = failClosed({
        revision,
        reason: `physical benchmark input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        inputPath,
      });
    }
    if (report === undefined) {
      report = validateInput(input, manifest, revision, inputPath);
    }
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[physical-benchmark] status=${report.status} output=${outputPath}`);
  if (report.reason !== undefined) console.log(`[physical-benchmark] reason=${report.reason}`);
  return report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
}

const invoked = process.argv[1] === undefined ? false : resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[physical-benchmark] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
