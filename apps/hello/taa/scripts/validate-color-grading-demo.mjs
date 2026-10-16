#!/usr/bin/env node

// Numeric oracle for the software visual demo.  It deliberately reports an
// observation-only result: the run is useful for proving stage wiring and
// bounded values, but it is not physical-GPU or feature-admission evidence.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requestedOutputDir = process.argv.slice(2).find((arg) => arg !== '--' && !arg.startsWith('-'));
const outputDir = resolve(requestedOutputDir ?? process.env.TAA_DEMO_OUTPUT ?? '/tmp/forgeax-taa-color-grading-demo');
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const caseIds = [
  'exposure-adaptation-card',
  'exposure-auto-dark',
  'exposure-auto-bright',
  'exposure-manual-reference',
  'exposure-manual-dark',
  'exposure-manual-bright',
  'white-balance-card',
  'lut-output-card',
];
const expectedSceneScales = {
  'exposure-adaptation-card': 1,
  'exposure-auto-dark': 0.25,
  'exposure-auto-bright': 4,
  'exposure-manual-reference': 1,
  'exposure-manual-dark': 0.25,
  'exposure-manual-bright': 4,
  'white-balance-card': 1,
  'lut-output-card': 1,
};
const errors = [];
const warnings = [];
const records = new Map();

const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const readJson = (path) => JSON.parse(readFileSync(resolve(outputDir, path), 'utf8'));

for (const id of caseIds) {
  try {
    records.set(id, readJson(`${id}.json`));
  } catch (error) {
    fail(`${id}: missing or invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

const getRecord = (id) => records.get(id);
const getInspection = (id) => getRecord(id)?.inspection;
const getStage = (id, domain) => {
  const normalized = domain.toLowerCase();
  return getInspection(id)?.observations?.find((stage) => stage.domain.toLowerCase() === normalized);
};
const hasPass = (id, pass) => getInspection(id)?.passes?.includes(pass) === true;

const same = (left, right, label) => {
  if (left !== right) fail(`${label}: expected ${String(left)} === ${String(right)}`);
};

const checkStage = (id, domain, expectedFormat) => {
  const stage = getStage(id, domain);
  if (stage === undefined) {
    fail(`${id}: missing ${domain} observation`);
    return undefined;
  }
  if (stage.summary?.finite !== true) fail(`${id}/${domain}: sampled values are not all finite`);
  if (!Number.isInteger(stage.summary?.sampleCount) || stage.summary.sampleCount < 100) {
    fail(`${id}/${domain}: bounded sample count is missing or too small`);
  }
  if (stage.metadata?.format !== expectedFormat && !(domain === 'final-sRGB' && ['rgba8unorm', 'bgra8unorm'].includes(stage.metadata?.format))) {
    fail(`${id}/${domain}: unexpected format ${String(stage.metadata?.format)}`);
  }
  return stage;
};

const checkSharedMetadata = (id, stages) => {
  const [first, ...rest] = stages;
  for (const stage of rest) {
    same(stage.metadata.frameId, first.metadata.frameId, `${id}: frame identity`);
    same(stage.metadata.deviceGeneration, first.metadata.deviceGeneration, `${id}: device identity`);
    same(stage.metadata.graphGeneration, first.metadata.graphGeneration, `${id}: graph identity`);
    same(stage.metadata.width, first.metadata.width, `${id}: width`);
    same(stage.metadata.height, first.metadata.height, `${id}: height`);
    if (!Number.isInteger(stage.metadata.bytesPerRow) || stage.metadata.bytesPerRow <= 0) {
      fail(`${id}: ${stage.domain} row pitch is invalid`);
    }
  }
  if (new Set(stages.map((stage) => stage.metadata.textureIdentity)).size !== stages.length) {
    fail(`${id}: stage texture identities are not distinct`);
  }
  if (new Set(stages.map((stage) => stage.metadata.readbackIdentity)).size !== stages.length) {
    fail(`${id}: stage readback identities are not distinct`);
  }
  if (new Set(stages.map((stage) => stage.readback.rawHash)).size !== stages.length) {
    fail(`${id}: HDR/LDR/sRGB raw readbacks are unexpectedly identical`);
  }
};

const checkLdrBounds = (id, stage) => {
  if (stage === undefined) return;
  const channels = Object.values(stage.summary.channels);
  for (const channel of channels) {
    if (channel.min < -0.01 || channel.max > 1.01) {
      fail(`${id}/${stage.domain}: normalized output escaped [0,1] (${channel.min}..${channel.max})`);
    }
  }
};

for (const id of caseIds) {
  const record = getRecord(id);
  const inspection = getInspection(id);
  if (record === undefined || inspection === undefined) continue;
  if (record.execution !== 'software-demo-only' || record.physicalGpu !== false) {
    fail(`${id}: demo must remain explicitly software-demo-only`);
  }
  if (record.errors?.console?.length > 0 || record.errors?.page?.length > 0) {
    fail(`${id}: browser/page errors were recorded`);
  }
  if (inspection.observationError !== null) fail(`${id}: observation error ${inspection.observationError}`);
  const hdr = checkStage(id, 'linear-HDR', 'rgba16float');
  const ldr = checkStage(id, 'linear-LDR', 'rgba16float');
  const srgb = checkStage(id, 'final-sRGB', inspection.observations?.find((stage) => stage.domain === 'final-sRGB')?.metadata?.format);
  checkSharedMetadata(id, [hdr, ldr, srgb].filter((stage) => stage !== undefined));
  checkLdrBounds(id, ldr);
  checkLdrBounds(id, srgb);
  if (hdr !== undefined && (hdr.summary.luminance.dynamicRange ?? 0) <= 2) {
    fail(`${id}/linear-HDR: bounded dynamic range is too small to prove the HDR chart`);
  }
  const growth = inspection.workload?.resourceGrowth;
  if (growth === null || growth === undefined) {
    fail(`${id}: missing resource-growth observation`);
  } else {
    if (growth.stableFrames < Math.max(60, Number(record.settleFrames ?? 60) - 1)) fail(`${id}: resource growth window is too short`);
    for (const key of ['byteLengthDelta', 'bindGroupDelta', 'resourceCountDelta', 'liveResourceDelta']) {
      if (growth[key] !== 0) fail(`${id}: resource ${key} drifted by ${growth[key]}`);
    }
  }
  const proof = inspection.visualProof;
  if (proof?.input?.colorSpace !== 'linear-HDR' || proof?.pipeline?.join('>') !== 'linear-HDR>linear-LDR>final-sRGB') {
    fail(`${id}: visual proof does not state the three-stage color pipeline`);
  }
  const expectedScale = expectedSceneScales[id];
  if (expectedScale !== undefined && Math.abs((proof?.sceneScale ?? 0) - expectedScale) > 1e-6) {
    fail(`${id}: scene scale receipt is not ${expectedScale}`);
  }
  if (hdr !== undefined && expectedScale !== undefined && hdr.summary.channels.r.max < 8 * expectedScale * 0.9) {
    fail(`${id}/linear-HDR: measured bright sample did not preserve the declared scene scale`);
  }
}

for (const id of ['exposure-adaptation-card', 'exposure-auto-dark', 'exposure-auto-bright']) {
  const autoExposure = getInspection(id)?.workload?.autoExposure;
  if (autoExposure?.requested?.kind !== 'auto') fail(`${id}: auto exposure request is absent`);
  if ((autoExposure?.targetGeneration ?? 0) < 1) fail(`${id}: auto exposure target generation did not commit`);
  if (autoExposure?.receipt?.committed !== true) fail(`${id}: auto exposure receipt is not committed`);
  if (autoExposure?.actualState === 'fallback') fail(`${id}: auto exposure fell back`);
  if (!hasPass(id, 'auto-exposure-meter')) fail(`${id}: meter pass is absent`);
  if (!hasPass(id, 'standard-exposure-white-balance')) fail(`${id}: standard output pass is absent`);
}

const manualInspection = getInspection('exposure-manual-reference');
if (manualInspection?.workload?.exposureMode !== 'manual') fail('exposure-manual-reference: manual oracle is not manual');
if (manualInspection?.visualProof?.whiteBalance?.temperature !== 6504) fail('exposure-manual-reference: D65 reference is not explicit');
for (const id of ['exposure-manual-dark', 'exposure-manual-bright']) {
  if (getInspection(id)?.workload?.exposureMode !== 'manual') fail(`${id}: manual exposure oracle is not manual`);
}

const wbInspection = getInspection('white-balance-card');
if (wbInspection?.visualProof?.whiteBalance?.temperature !== 3200) fail('white-balance-card: 3200K input is not preserved');
if (!hasPass('white-balance-card', 'standard-exposure-white-balance')) fail('white-balance-card: Bradford white-balance pass is absent');

const lutInspection = getInspection('lut-output-card');
const lutReceipt = lutInspection?.workload?.lutReceipt;
if (lutReceipt?.committed !== true || lutReceipt?.generation < 1 || lutReceipt?.sourceKey !== 'auto-exposure-positive-lut') {
  fail('lut-output-card: committed Catalog LUT receipt is absent');
}
if (!hasPass('lut-output-card', 'standard-color-lut')) fail('lut-output-card: standard LUT pass is absent');

const autoHdr = getStage('exposure-adaptation-card', 'linear-HDR');
for (const id of ['exposure-manual-reference', 'white-balance-card', 'lut-output-card']) {
  const hdr = getStage(id, 'linear-HDR');
  if (autoHdr !== undefined && hdr !== undefined) same(hdr.readback.rawHash, autoHdr.readback.rawHash, `${id}: input HDR oracle`);
}
if (autoHdr !== undefined) {
  for (const id of ['exposure-auto-dark', 'exposure-auto-bright', 'exposure-manual-dark', 'exposure-manual-bright']) {
    const hdr = getStage(id, 'linear-HDR');
    if (hdr?.readback.rawHash === autoHdr.readback.rawHash) fail(`${id}: scene-scale input did not change the HDR readback`);
  }
}

const autoDark = getStage('exposure-auto-dark', 'linear-LDR');
const autoBright = getStage('exposure-auto-bright', 'linear-LDR');
const manualDark = getStage('exposure-manual-dark', 'linear-LDR');
const manualBright = getStage('exposure-manual-bright', 'linear-LDR');
let autoExposureComparison = null;
if (autoDark !== undefined && autoBright !== undefined && manualDark !== undefined && manualBright !== undefined) {
  const autoRatio = autoBright.summary.luminance.mean / Math.max(autoDark.summary.luminance.mean, Number.EPSILON);
  const manualRatio = manualBright.summary.luminance.mean / Math.max(manualDark.summary.luminance.mean, Number.EPSILON);
  autoExposureComparison = {
    darkSceneScale: expectedSceneScales['exposure-auto-dark'],
    brightSceneScale: expectedSceneScales['exposure-auto-bright'],
    fixedExposureLuminanceRatio: manualRatio,
    autoExposureLuminanceRatio: autoRatio,
    adaptationObserved: manualRatio > autoRatio,
    metric: 'linear-LDR luminance.mean bright/dark',
  };
  if (!(manualRatio > autoRatio)) fail(`auto-exposure adaptation: fixed-exposure ratio ${manualRatio} was not reduced by auto ratio ${autoRatio}`);
}
if (getStage('white-balance-card', 'linear-LDR')?.readback.rawHash === getStage('exposure-adaptation-card', 'linear-LDR')?.readback.rawHash) {
  warn('white-balance-card: LDR hash did not change; inspect color-temperature range before admission');
}
if (getStage('lut-output-card', 'final-sRGB')?.readback.rawHash === getStage('exposure-adaptation-card', 'final-sRGB')?.readback.rawHash) {
  fail('lut-output-card: final-sRGB hash did not change under the non-identity LUT');
}

const report = {
  schemaVersion: 'forgeax-taa-color-grading-numeric-report/1',
  status: errors.length === 0 ? 'observation-pass' : 'failed',
  admission: 'not-acceptance',
  execution: 'software-demo-only',
  testedRevision: (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })(),
  oracle: {
    hdrInputRange: { baseMinimum: 0.018, baseMaximum: 8, sceneScales: expectedSceneScales },
    stageIdentity: 'frameId + deviceGeneration + graphGeneration + extent; format/rowPitch checked per stage',
    outputBounds: '[0,1] with 0.01 tolerance',
    source: 'inspection.observations.summary plus committed renderer receipts',
  },
  autoExposureComparison,
  cases: Object.fromEntries(caseIds.map((id) => [id, {
    frameId: getStage(id, 'linear-HDR')?.metadata?.frameId ?? null,
    domains: getInspection(id)?.observations?.map((stage) => stage.domain) ?? [],
    hashes: Object.fromEntries((getInspection(id)?.observations ?? []).map((stage) => [stage.domain, stage.readback.rawHash])),
  }])),
  errors,
  warnings,
};
const reportPath = resolve(outputDir, 'numeric-report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
