#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';
import jiti from 'jiti';
import { chromium } from 'playwright';
import UPNG from 'upng-js';
import waitOn from 'wait-on';
import { collectMissingPipelineIds } from './color-lighting-pipeline-coverage.mjs';
import {
  aggregateVertexColorReportStatus,
  readVertexColorVisualEvidenceInputs,
  runVertexColorProducerSchedule,
  vertexColorReportStatus,
} from './color-lighting-vertex-producers.mjs';

const root = resolve(new URL('..', import.meta.url).pathname, '..');
const packageName = '@forgeax/parity-color-lighting';
const port = 4176;
const browserReportPath = resolve(root, 'report/color-lighting-browser.json');
const invocationId = process.env.FORGEAX_PARITY_INVOCATION_ID ?? 'color-lighting-parity-local';
const reportDirectory = resolve(
  root,
  process.env.FORGEAX_PARITY_REPORT_DIR ?? 'report/color-lighting-parity/cases',
);
const urpArtifactPath =
  process.env.FORGEAX_PARITY_URP_ARTIFACT ??
  resolve(root, 'report/color-lighting-parity/pipeline-evidence/browser-urp.json');
const hdrpArtifactPath =
  process.env.FORGEAX_PARITY_HDRP_ARTIFACT ??
  resolve(root, 'report/color-lighting-parity/pipeline-evidence/dawn-hdrp.json');
const iblArtifactPath =
  process.env.FORGEAX_PARITY_IBL_ARTIFACT ??
  resolve(root, 'report/color-lighting-parity/pipeline-evidence/dawn-ibl.json');
const transparencyArtifactPath =
  process.env.FORGEAX_PARITY_TRANSPARENCY_ARTIFACT ??
  resolve(root, 'report/color-lighting-parity/pipeline-evidence/dawn-transparency.json');
const statusIndexPath = resolve(root, 'report/color-lighting-parity/status-index.json');
const visualRoot = resolve(
  root,
  process.env.FORGEAX_PARITY_VISUAL_DIR ?? `report/color-lighting-parity/visual/${invocationId}`,
);
const fallbackStatusPath = resolve(
  root,
  process.env.FORGEAX_PARITY_FALLBACK_STATUS ??
    process.env.FORGEAX_PARITY_WEBKIT_STATUS ??
    'report/color-lighting-parity/chromium-status.json',
);
const browserHeadless = !['0', 'false'].includes(
  (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
);
const requiredFallbackCaseIds = [
  'default-srgb-texture',
  'material-alpha-mask-default',
  'material-alpha-blend',
  'tone-aces-filmic-2',
  'direct-directional-urp',
  'transparent-ldr-urp',
];
const vertexColorRequiredCaseIds = [
  'vertex-color-vec3',
  'vertex-color-vec4',
  'vertex-color-normalized',
  'vertex-color-skinning',
  'vertex-color-mixed-primitives',
  'vertex-color-mask-taa',
  'vertex-color-no-color-baseline',
];
const vertexColorReportRoot = resolve(root, 'report/color-lighting-parity/vertex-color');
const auxiliaryCaseIds = new Set([
  'ibl-constant-environment',
  'transparent-ldr-urp',
  'transparent-hdr-hdrp',
]);
const auxiliaryFixturePaths = new Map([
  [
    'ibl-constant-environment',
    resolve(root, 'apps/parity/color-lighting/cases/ibl/constant-environment.json'),
  ],
  [
    'transparent-ldr-urp',
    resolve(root, 'apps/parity/color-lighting/cases/transparency-post/transparent-ldr-urp.json'),
  ],
  [
    'transparent-hdr-hdrp',
    resolve(root, 'apps/parity/color-lighting/cases/transparency-post/transparent-hdr-hdrp.json'),
  ],
]);
const loadTypeScript = jiti(import.meta.url);
const caseReportSchema = JSON.parse(
  readFileSync(resolve(root, 'apps/parity/color-lighting/schemas/case-report.schema.json'), 'utf8'),
);
const validateCaseReportSchema = new Ajv2020({ allErrors: true, strict: false }).compile(
  caseReportSchema,
);
let publicStatusModule;
let auxiliaryReportModule;
let visualEvidenceModule;
let directCaseIds = [];
let requiredVisualCaseIds = [];
const caseStatuses = {};
const caseBackendStatuses = {};
let missingPipelineIds = ['standard'];
let requiredPipelineIds = ['standard'];
const backendStatuses = {
  'browser-webgpu': 'not-executed',
  dawn: 'not-executed',
  'chromium-webgl2': 'not-executed',
};

function producerArtifactPath(basePath, caseId) {
  return basePath.endsWith('.json')
    ? `${basePath.slice(0, -'.json'.length)}-${caseId}.json`
    : `${basePath}-${caseId}.json`;
}

function projectVertexColorReportStatuses() {
  for (const caseId of vertexColorRequiredCaseIds) {
    const statuses = [];
    for (const backend of ['browser-webgpu', 'dawn']) {
      const path = resolve(vertexColorReportRoot, backend, `${caseId}.json`);
      let status = 'not-executed';
      if (existsSync(path)) {
        try {
          status = vertexColorReportStatus(JSON.parse(readFileSync(path, 'utf8')));
        } catch {
          status = 'failed';
        }
      }
      statuses.push(status);
      caseBackendStatuses[caseId] = {
        ...(caseBackendStatuses[caseId] ?? {}),
        [backend]: status,
      };
    }
    caseStatuses[caseId] = aggregateVertexColorReportStatus(statuses);
  }
}

function requireVertexColorReports() {
  projectVertexColorReportStatuses();
  const missing = [];
  const invalid = [];
  for (const backend of ['browser-webgpu', 'dawn']) {
    for (const caseId of vertexColorRequiredCaseIds) {
      const path = resolve(vertexColorReportRoot, backend, `${caseId}.json`);
      if (!existsSync(path)) {
        missing.push(`${backend}/${caseId}`);
        continue;
      }
      try {
        const report = JSON.parse(readFileSync(path, 'utf8'));
        if (
          !validateCaseReportSchema(report) ||
          report.kind !== 'vertex-color' ||
          report.frameCount !== 60 ||
          report.status !== 'complete' ||
          report.verdict !== 'passed'
        ) {
          invalid.push(`${backend}/${caseId}`);
        }
      } catch {
        invalid.push(`${backend}/${caseId}`);
      }
    }
  }
  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(
      `vertex-color parity is fail-closed: missing=${missing.join(',') || 'none'} invalid=${invalid.join(',') || 'none'}`,
    );
  }
}

function currentSourceSha() {
  return (
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  );
}

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function timedStage(name, operation) {
  const startedAt = process.hrtime.bigint();
  try {
    return await operation();
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.warn(`[bench:color-lighting-parity] stage=${name} elapsedMs=${Math.round(elapsedMs)}`);
  }
}

function reportStatus(caseId) {
  const path = resolve(reportDirectory, `${caseId}.json`);
  if (!existsSync(path)) return 'not-executed';
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (
      (report?.status === 'complete' && report?.verdict === 'passed') ||
      (report?.attachmentEvidence?.executionStatus === 'complete' &&
        report?.attachmentEvidence?.verdict === 'passed' &&
        report?.attachmentEvidence?.missingPipelineIds?.length === 0)
    )
      return 'pass';
    return report?.status === 'failed' || report?.verdict === 'failed' ? 'failed' : 'partial';
  } catch {
    return 'failed';
  }
}

async function writeStatusIndex() {
  if (publicStatusModule === undefined) {
    publicStatusModule = await loadTypeScript.import(
      resolve(root, 'apps/parity/color-lighting/src/coverage/public-status.ts'),
    );
    const { PARITY_CASE_AUTHORITY } = await loadTypeScript.import(
      resolve(root, 'apps/parity/color-lighting/src/coverage/required-cases.ts'),
    );
    const { PARITY_REQUIRED_PIPELINE_IDS } = await loadTypeScript.import(
      resolve(root, 'apps/parity/color-lighting/src/coverage/required-cases.ts'),
    );
    const { PARITY_REQUIRED_CASE_IDS } = await loadTypeScript.import(
      resolve(root, 'apps/parity/color-lighting/src/coverage/required-cases.ts'),
    );
    requiredPipelineIds = [...PARITY_REQUIRED_PIPELINE_IDS];
    missingPipelineIds = [...requiredPipelineIds];
    directCaseIds = PARITY_CASE_AUTHORITY.filter(
      (entry) => entry.owner === 'm4' && entry.caseId.endsWith('-urp'),
    ).map((entry) => entry.caseId);
    requiredVisualCaseIds = [...PARITY_REQUIRED_CASE_IDS];
  }
  const statusIndex = publicStatusModule.buildPublicParityStatusIndex({
    caseStatuses,
    caseBackendStatuses,
    backends: backendStatuses,
    missingPipelineIds,
  });
  mkdirSync(resolve(root, 'report/color-lighting-parity'), { recursive: true });
  writeFileSync(
    statusIndexPath,
    `${JSON.stringify({ ...statusIndex, backends: backendStatuses }, null, 2)}\n`,
  );
  return statusIndex;
}

function applyBrowserResult(result) {
  if (result?.caseStatuses !== undefined && typeof result.caseStatuses === 'object') {
    for (const [caseId, status] of Object.entries(result.caseStatuses)) {
      if (auxiliaryCaseIds.has(caseId)) continue;
      if (typeof status === 'string') {
        caseStatuses[caseId] = status;
        caseBackendStatuses[caseId] = {
          ...(caseBackendStatuses[caseId] ?? {}),
          'browser-webgpu': status,
        };
      }
    }
  }
  if (result?.caseBackendStatuses !== undefined && typeof result.caseBackendStatuses === 'object') {
    for (const [caseId, backendStatusesForCase] of Object.entries(result.caseBackendStatuses)) {
      if (auxiliaryCaseIds.has(caseId)) continue;
      if (backendStatusesForCase === null || typeof backendStatusesForCase !== 'object') continue;
      caseBackendStatuses[caseId] = {
        ...(caseBackendStatuses[caseId] ?? {}),
        ...backendStatusesForCase,
      };
    }
  }
  if (Array.isArray(result?.missingPipelineIds)) {
    missingPipelineIds = [...new Set(result.missingPipelineIds)];
  }
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashBytes(bytes) {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

function encodePng(bytes, width, height) {
  const pixels = Uint8Array.from(bytes);
  return Buffer.from(
    UPNG.encode(
      [pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength)],
      width,
      height,
      0,
    ),
  );
}

function visualCapture(input, side) {
  const capture = input?.captures?.[side];
  if (
    capture === undefined ||
    !Array.isArray(capture.final) ||
    capture.final.length !== input.width * input.height * 4
  ) {
    throw new Error(
      `${input?.caseId ?? 'unknown'}: ${side} visual final capture is missing or has the wrong size`,
    );
  }
  return capture.final;
}

function buildDiffPixels(left, right) {
  if (left.length !== right.length) throw new Error('visual final captures have different lengths');
  let maxDelta = 0;
  for (let index = 0; index < left.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(left[index] - right[index]));
  }
  const scale = maxDelta === 0 ? 1 : 255 / maxDelta;
  const diff = new Uint8Array(left.length);
  for (let index = 0; index < left.length; index += 4) {
    const delta = Math.max(
      Math.abs(left[index] - right[index]),
      Math.abs(left[index + 1] - right[index + 1]),
      Math.abs(left[index + 2] - right[index + 2]),
      Math.abs(left[index + 3] - right[index + 3]),
    );
    diff[index] = Math.min(255, Math.round(delta * scale));
    diff[index + 1] = delta === 0 ? 64 : 0;
    diff[index + 2] = 0;
    diff[index + 3] = 255;
  }
  return diff;
}

async function persistVisualEvidence(result) {
  if (visualEvidenceModule === undefined) {
    visualEvidenceModule = await loadTypeScript.import(
      resolve(root, 'apps/parity/color-lighting/src/coverage/build-status-index.ts'),
    );
  }
  if (!Array.isArray(result?.visualEvidenceInputs) || result.visualEvidenceErrors?.length > 0) {
    throw new Error(
      `visual evidence inputs are incomplete: ${(result?.visualEvidenceErrors ?? ['missing visualEvidenceInputs']).join('; ')}`,
    );
  }
  const inputs = new Map(result.visualEvidenceInputs.map((input) => [input?.caseId, input]));
  mkdirSync(visualRoot, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    invocationId,
    requiredCaseIds: requiredVisualCaseIds,
    indices: [],
  };
  for (const caseId of requiredVisualCaseIds) {
    const input = inputs.get(caseId);
    if (input === undefined)
      throw new Error(`${caseId}: required visual evidence input is missing`);
    if (!Array.isArray(input.background) || input.background.length !== 4) {
      throw new Error(`${caseId}: visual background provenance is missing`);
    }
    if (
      input.provenance?.forgeax?.implementation === undefined ||
      input.provenance?.three?.implementation === undefined ||
      input.provenance.forgeax.implementation === input.provenance.three.implementation ||
      input.provenance.three.renderer !== 'webgpu'
    ) {
      throw new Error(
        `${caseId}: visual provenance is not an independent ForgeAX/Three WebGPU pair`,
      );
    }
    const width = input.width;
    const height = input.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`${caseId}: visual dimensions are invalid`);
    }
    const forgeax = visualCapture(input, 'forgeax');
    const three = visualCapture(input, 'three');
    const diff = buildDiffPixels(forgeax, three);
    const caseRoot = resolve(visualRoot, caseId);
    mkdirSync(caseRoot, { recursive: true });
    const relativeRoot = visualRoot.startsWith(root)
      ? visualRoot.slice(root.length + 1)
      : visualRoot;
    const relativeCaseRoot = `${relativeRoot}/${caseId}`;
    const artifacts = [
      {
        kind: 'forgeax-final',
        pixels: forgeax,
        expected: 'ForgeAX final color capture uses this SceneCase framing, size, and background.',
        observed: `ForgeAX final PNG retained; raw RGBA hash=${hashBytes(forgeax)}.`,
        verdict: input.status === 'complete' && input.verdict === 'passed' ? 'pass' : 'unknown',
      },
      {
        kind: 'three-primary-final',
        pixels: three,
        expected:
          'Three r184 WebGPU is the independent primary final-color oracle for this SceneCase.',
        observed: `Three WebGPU final PNG retained; raw RGBA hash=${hashBytes(three)}.`,
        verdict: input.status === 'complete' && input.verdict === 'passed' ? 'pass' : 'unknown',
      },
      {
        kind: 'diff-roi',
        pixels: diff,
        expected:
          'The diagnostic diff uses the same case framing and marks per-channel final-capture deltas.',
        observed: `Diff PNG retained; raw RGBA hash=${hashBytes(diff)}; analyticMax=${input.metrics?.analyticMax ?? 'unknown'}.`,
        verdict: input.status === 'complete' && input.verdict === 'passed' ? 'pass' : 'unknown',
      },
    ];
    for (const artifact of artifacts) {
      const fileName = `${artifact.kind}.png`;
      writeFileSync(resolve(caseRoot, fileName), encodePng(artifact.pixels, width, height));
    }
    const visualIndex = {
      schemaVersion: 1,
      invocationId,
      caseId,
      caseReportPath: `report/color-lighting-parity/cases/${caseId}.json`,
      width,
      height,
      background: input.background,
      framing: input.framing,
      artifacts: artifacts.map((artifact) => ({
        kind: artifact.kind,
        url: `artifact://color-lighting-parity/${invocationId}/${caseId}/${artifact.kind}.png`,
        path: `${relativeCaseRoot}/${artifact.kind}.png`,
        caseId,
        width,
        height,
        background: input.background,
        frameId: input.frameId ?? 0,
        rawHash: hashBytes(artifact.pixels),
        expected: artifact.expected,
        observed: artifact.observed,
        verdict: artifact.verdict,
        confidence: 'medium',
      })),
    };
    const validation = visualEvidenceModule.validateVisualEvidence(visualIndex);
    if (!validation.ok) throw new Error(`${caseId}: visual evidence invalid: ${validation.reason}`);
    const indexPath = resolve(caseRoot, 'visual-index.json');
    writeFileSync(indexPath, `${JSON.stringify(visualIndex, null, 2)}\n`);
    manifest.indices.push(`${relativeCaseRoot}/visual-index.json`);
  }
  writeFileSync(
    resolve(visualRoot, 'visual-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function sceneCaseIdentity(caseId) {
  const path = auxiliaryFixturePaths.get(caseId);
  if (path === undefined) throw new Error(`missing auxiliary fixture path for ${caseId}`);
  const sceneCase = JSON.parse(readFileSync(path, 'utf8'));
  const semanticCase = { ...sceneCase };
  delete semanticCase.caseId;
  delete semanticCase.pipeline;
  return { sourceHash: hashJson(sceneCase), semanticHash: hashJson(semanticCase) };
}

function readArtifact(path, label) {
  if (!existsSync(path)) throw new Error(`${label} artifact is missing: ${path}`);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  if (artifact?.invocationId !== invocationId)
    throw new Error(`${label} artifact invocation mismatch`);
  return artifact;
}

function writeAuxiliaryReport(caseId, report) {
  if (!validateCaseReportSchema(report)) {
    throw new Error(
      `${caseId}: auxiliary CaseReport schema invalid: ${JSON.stringify(validateCaseReportSchema.errors)}`,
    );
  }
  const path = resolve(reportDirectory, `${caseId}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function iblProducerStatus(producer) {
  return (
    producer?.capability?.capabilityStatus === 'supported' &&
    producer?.capability?.executionStatus === 'complete' &&
    producer?.capability?.verdict === 'passed' &&
    producer?.evidence?.status === 'ready' &&
    Array.isArray(producer?.evidence?.bytes) &&
    typeof producer?.evidence?.rawHash === 'string' &&
    producer?.finalDisplay?.status === 'ready' &&
    Array.isArray(producer?.finalDisplay?.bytes) &&
    typeof producer?.finalDisplay?.rawHash === 'string' &&
    producer?.analytic?.maxError <= 1e-7
  );
}

async function persistAuxiliaryReports(result) {
  if (auxiliaryReportModule === undefined) {
    auxiliaryReportModule = await loadTypeScript.import(
      resolve(root, 'apps/parity/color-lighting/src/report/auxiliary-case-report.ts'),
    );
  }
  const browserTransparency = result?.auxiliaryEvidence?.transparency;
  const dawnTransparency = readArtifact(transparencyArtifactPath, 'transparency Dawn');
  for (const caseId of ['transparent-ldr-urp', 'transparent-hdr-hdrp']) {
    const browserCase = browserTransparency?.cases?.find((entry) => entry?.caseId === caseId);
    const dawnObservation = dawnTransparency?.cases?.find((entry) => entry?.caseId === caseId);
    if (browserCase === undefined || dawnObservation === undefined) {
      throw new Error(`auxiliary transparency evidence is incomplete for ${caseId}`);
    }
    const report = auxiliaryReportModule.createAuxiliaryCaptureCaseReport({
      caseId,
      required: true,
      invocationId,
      ...sceneCaseIdentity(caseId),
      forgeax: {
        provenance: browserCase.report.provenance.forgeax,
        captures: browserCase.report.captures.forgeax,
      },
      three: {
        provenance: browserCase.report.provenance.three,
        captures: browserCase.report.captures.three,
      },
      metrics: browserCase.report.metrics,
      primaryStatus: browserCase.passed === true ? 'pass' : 'failed',
      dawn: {
        status:
          Array.isArray(dawnObservation.bytes) && dawnObservation.bytes.length > 0
            ? 'pass'
            : 'failed',
        observations: [dawnObservation],
      },
    });
    writeAuxiliaryReport(caseId, report);
    caseStatuses[caseId] = report.status === 'complete' ? 'pass' : 'failed';
    caseBackendStatuses[caseId] = {
      'browser-webgpu': report.primary.status,
      dawn: report.dawn.status,
    };
  }

  const browserIbl = result?.auxiliaryEvidence?.ibl;
  const dawnIbl = readArtifact(iblArtifactPath, 'IBL Dawn')?.producer;
  if (browserIbl === null || browserIbl === undefined || dawnIbl === undefined) {
    throw new Error('auxiliary IBL evidence is incomplete');
  }
  const iblReport = auxiliaryReportModule.createIblCaseReport({
    caseId: 'ibl-constant-environment',
    required: true,
    invocationId,
    browser: browserIbl,
    dawn: dawnIbl,
  });
  writeAuxiliaryReport('ibl-constant-environment', iblReport);
  caseStatuses['ibl-constant-environment'] = iblReport.status === 'complete' ? 'pass' : 'failed';
  caseBackendStatuses['ibl-constant-environment'] = {
    'browser-webgpu': iblProducerStatus(browserIbl) ? 'pass' : 'failed',
    dawn: iblProducerStatus(dawnIbl) ? 'pass' : 'failed',
  };
}

function applyFallbackStatus() {
  if (!existsSync(fallbackStatusPath)) return;
  try {
    const status = JSON.parse(readFileSync(fallbackStatusPath, 'utf8'));
    if (!isValidFallbackStatus(status)) {
      backendStatuses['chromium-webgl2'] = 'failed';
      return;
    }
    const backendStatus = status?.status;
    backendStatuses['chromium-webgl2'] =
      backendStatus === 'pass' || backendStatus === 'failed' || backendStatus === 'degraded'
        ? backendStatus
        : 'not-executed';
    for (const [caseId, caseStatus] of Object.entries(status?.caseBackendStatuses ?? {})) {
      if (caseStatus === null || typeof caseStatus !== 'object') continue;
      const fallbackCaseStatus = caseStatus['chromium-webgl2'];
      if (typeof fallbackCaseStatus !== 'string') continue;
      caseBackendStatuses[caseId] = {
        ...(caseBackendStatuses[caseId] ?? {}),
        'chromium-webgl2': fallbackCaseStatus,
      };
    }
  } catch {
    backendStatuses['chromium-webgl2'] = 'failed';
  }
}

function isValidFallbackStatus(status) {
  if (
    status?.backendId !== 'chromium-webgl2' ||
    status?.executionStatus !== 'complete' ||
    status?.status !== 'pass' ||
    status?.execution?.browser !== 'chromium' ||
    !['absent', 'unavailable'].includes(status?.execution?.channelProof?.webgpuAdapterStatus) ||
    status?.execution?.channelProof?.webgl2 !== true ||
    !status?.provenance?.forgeax?.implementation ||
    !status?.provenance?.three?.implementation ||
    status.provenance.forgeax.implementation === status.provenance.three.implementation ||
    !Array.isArray(status.cases)
  )
    return false;
  for (const caseId of requiredFallbackCaseIds) {
    const result = status.cases.find((entry) => entry?.caseId === caseId);
    const caseStatus = status.caseStatuses?.[caseId];
    const backendStatus = status.caseBackendStatuses?.[caseId]?.['chromium-webgl2'];
    if (
      result?.passed !== true ||
      caseStatus !== 'pass' ||
      backendStatus !== 'pass' ||
      result.report?.verdict !== 'passed' ||
      result.report?.status !== 'complete' ||
      !result.report?.provenance?.forgeax?.implementation ||
      !result.report?.provenance?.three?.implementation ||
      result.report.provenance.forgeax.implementation ===
        result.report.provenance.three.implementation ||
      !result.report?.captures?.forgeax?.hash ||
      !result.report?.captures?.three?.hash ||
      !result.report?.metrics
    )
      return false;
  }
  return true;
}

function collectPipelineIds() {
  const reports = [];
  for (const caseId of directCaseIds) {
    const path = resolve(reportDirectory, `${caseId}.json`);
    if (!existsSync(path)) continue;
    try {
      reports.push(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // The final status remains missing until a valid CaseReport is written.
    }
  }
  return collectMissingPipelineIds({
    reports,
    requiredPipelineIds,
    validateReport: validateCaseReportSchema,
  });
}

const preview = async () => {
  await timedStage('vite-build', () => run('pnpm', ['--filter', packageName, 'build']));
  // The bench owns this child and terminates it in `finally`. Avoid a nested
  // pnpm workspace runner: pnpm turns the expected cleanup SIGTERM into
  // ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL and makes a passing matrix fail CI.
  return spawn(
    process.execPath,
    [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1'],
    { cwd: resolve(root, 'apps/parity/color-lighting'), stdio: 'inherit', env: process.env },
  );
};

let server;
let browser;
try {
  applyFallbackStatus();
  await writeStatusIndex();
  const vertexColorSchedule = await timedStage('vertex-color-producers', () =>
    runVertexColorProducerSchedule({
      root,
      reportRoot: vertexColorReportRoot,
      invocationId,
      sourceSha: currentSourceSha(),
    }),
  );
  projectVertexColorReportStatuses();
  if (!vertexColorSchedule.ok) {
    throw new Error(
      `vertex-color producer schedule is fail-closed: blocked=${vertexColorSchedule.blocked.length}/14, failed=${vertexColorSchedule.failures.length}/14; inspect ${resolve(vertexColorReportRoot, 'dispatch-receipt.json')}`,
    );
  }
  const vertexColorVisualEvidenceInputs = readVertexColorVisualEvidenceInputs({
    reportRoot: vertexColorReportRoot,
    sourceSha: currentSourceSha(),
    invocationId,
  });
  server = await preview();
  await waitOn({ resources: [`http://127.0.0.1:${port}`], timeout: 30_000 });
  browser = await chromium.launch({
    headless: browserHeadless,
    channel: 'chrome-beta',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    ],
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.__colorLightingParity === 'function', null, {
    timeout: 30_000,
  });
  rmSync(urpArtifactPath, { force: true });
  rmSync(hdrpArtifactPath, { force: true });
  rmSync(iblArtifactPath, { force: true });
  rmSync(transparencyArtifactPath, { force: true });
  rmSync(resolve(root, 'report/color-lighting-parity.json'), { force: true });
  rmSync(visualRoot, { recursive: true, force: true });
  for (const caseId of directCaseIds) {
    rmSync(producerArtifactPath(urpArtifactPath, caseId), { force: true });
    rmSync(producerArtifactPath(hdrpArtifactPath, caseId), { force: true });
    rmSync(resolve(reportDirectory, `${caseId}.json`), { force: true });
  }
  for (const caseId of auxiliaryCaseIds) {
    rmSync(resolve(reportDirectory, `${caseId}.json`), { force: true });
  }
  const result = await timedStage('browser-matrix', () =>
    page.evaluate(({ id, vertexInputs }) => window.__colorLightingParity?.(id, vertexInputs), {
      id: invocationId,
      vertexInputs: vertexColorVisualEvidenceInputs,
    }),
  );
  mkdirSync(resolve(root, 'report'), { recursive: true });
  writeFileSync(browserReportPath, `${JSON.stringify(result, null, 2)}\n`);
  applyBrowserResult(result);
  backendStatuses['browser-webgpu'] =
    result?.browserStageOk === true ? 'pass' : result?.status === 'failed' ? 'failed' : 'degraded';
  await writeStatusIndex();
  const { mergePipelineEvidenceFromPaths } = await import(
    new URL(
      '../../apps/parity/color-lighting/src/report/merge-pipeline-evidence.ts',
      import.meta.url,
    )
  );
  const { createPipelineEvidenceArtifact, writePipelineEvidence } = await import(
    new URL(
      '../../apps/parity/color-lighting/src/report/write-pipeline-evidence.ts',
      import.meta.url,
    )
  );
  const { writeCrossRuntimeCaseReport } = await import(
    new URL('../../apps/parity/color-lighting/src/report/write-case-report.ts', import.meta.url)
  );
  const browserInputs = new Map(
    (result?.pipelineEvidenceInputs ?? []).map((entry) => [entry.sceneCase?.caseId, entry]),
  );
  for (const caseId of directCaseIds) {
    const browserInput = browserInputs.get(caseId);
    if (browserInput === undefined)
      throw new Error(`browser URP producer artifact input is missing for ${caseId}`);
    const browserArtifact = await createPipelineEvidenceArtifact(browserInput);
    await writePipelineEvidence(producerArtifactPath(urpArtifactPath, caseId), browserArtifact);
  }
  await timedStage('direct-light-dawn', () =>
    run(process.execPath, ['scripts/ci/run-direct-light-dawn.mjs'], {
      ...process.env,
      FORGEAX_PARITY_INVOCATION_ID: invocationId,
      FORGEAX_PARITY_HDRP_ARTIFACT: hdrpArtifactPath,
      // Metrics owns these HDRP captures and joins their artifacts with Browser
      // URP. The disjoint regression scope belongs to vitest-dawn.
      FORGEAX_DAWN_PARTITION_SCOPE: 'producer',
    }),
  );
  for (const caseId of directCaseIds) {
    const merged = await mergePipelineEvidenceFromPaths(invocationId, [
      producerArtifactPath(urpArtifactPath, caseId),
      producerArtifactPath(hdrpArtifactPath, caseId),
    ]);
    if (!merged.ok) throw new Error(`${caseId}: ${merged.error.code}: ${merged.error.hint}`);
    await writeCrossRuntimeCaseReport(
      resolve(reportDirectory, `${caseId}.json`),
      merged.value.report,
    );
    caseStatuses[caseId] = reportStatus(caseId);
    caseBackendStatuses[caseId] = {
      ...(caseBackendStatuses[caseId] ?? {}),
      dawn: caseStatuses[caseId],
    };
  }
  await timedStage('auxiliary-dawn', () =>
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--project=dawn',
        'apps/parity/color-lighting/cases/ibl/__tests__/ibl.dawn.test.ts',
        'apps/parity/color-lighting/cases/transparency-post/__tests__/transparency-post.dawn.test.ts',
        '--maxWorkers=1',
      ],
      {
        ...process.env,
        // The ordinary Dawn roster intentionally excludes this compact
        // transparency carrier. Re-enable the bounded roster only for the
        // explicitly selected auxiliary files so both required artifacts are
        // produced without replaying the whole Dawn suite.
        FORGEAX_DAWN_COMPACT: '1',
        FORGEAX_PARITY_REQUIRED: '1',
        FORGEAX_PARITY_INVOCATION_ID: invocationId,
        FORGEAX_PARITY_IBL_ARTIFACT: iblArtifactPath,
        FORGEAX_PARITY_TRANSPARENCY_ARTIFACT: transparencyArtifactPath,
      },
    ),
  );
  await persistAuxiliaryReports(result);
  await persistVisualEvidence(result);
  backendStatuses.dawn =
    auxiliaryCaseIds.size === 0 ||
    [...auxiliaryCaseIds].every((caseId) => caseBackendStatuses[caseId]?.dawn === 'pass')
      ? 'pass'
      : 'failed';
  applyFallbackStatus();
  missingPipelineIds = collectPipelineIds();
  await timedStage('m4-closure', () =>
    run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        // This file belongs to Vitest's `parity` project. Selecting it
        // explicitly avoids root-project discovery and its unrelated
        // typecheck startup before the one closure assertion runs.
        '--project=parity',
        '--typecheck.enabled=false',
        'apps/parity/color-lighting/src/integration/__tests__/m4-closure.test.ts',
        '--maxWorkers=1',
      ],
      {
        ...process.env,
        FORGEAX_PARITY_RUN_CLOSURE: '1',
        FORGEAX_PARITY_INVOCATION_ID: invocationId,
      },
    ),
  );
  requireVertexColorReports();
  const finalStatusIndex = await writeStatusIndex();
  const exitCode = publicStatusModule.parityCommandExitCode({
    browserStageOk: result?.browserStageOk === true,
    statusIndex: finalStatusIndex,
  });
  if (exitCode !== 0) {
    throw new Error(
      `parity matrix is incomplete: missing cases=${finalStatusIndex.missingCaseIds.join(',') || 'none'} matrix=${finalStatusIndex.missingMatrixCaseIds.join(',') || 'none'} backends=${finalStatusIndex.missingBackendIds.join(',') || 'none'} pipelines=${finalStatusIndex.missingPipelineIds.join(',') || 'none'}`,
    );
  }
  console.log(`[bench:color-lighting-parity] PASS reports=${reportDirectory}`);
} catch (error) {
  if (backendStatuses['browser-webgpu'] === 'not-executed')
    backendStatuses['browser-webgpu'] = 'failed';
  else if (backendStatuses.dawn === 'not-executed') backendStatuses.dawn = 'failed';
  await writeStatusIndex();
  console.error(
    '[bench:color-lighting-parity] FAIL',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server?.pid !== undefined) server.kill('SIGTERM');
}
