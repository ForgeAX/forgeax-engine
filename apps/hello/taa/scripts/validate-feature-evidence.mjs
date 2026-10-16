import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const DOMAINS = ['linear-HDR', 'linear-LDR', 'final-sRGB'];
const REQUIRED_WORKLOADS = ['manual', 'auto', 'positive-lut'];
const REQUIRED_TIMING_PASSES = ['meter', 'lut'];
const REQUIRED_LOGICAL_STAGES = ['clear', 'histogram', 'adapt'];
const REQUIRED_PROVENANCE = ['source', 'build', 'fixture', 'frame', 'backend', 'adapter', 'runner'];
const WORKLOAD_KINDS = ['manual', 'auto', 'positive-lut'];
const EXECUTION_MODES = new Set(['physical', 'simulated']);
const HASH = /^[a-f0-9]{64}$/;
const schemaPath = fileURLToPath(new URL('../evidence/feature-evidence.schema.json', import.meta.url));

function error(code, detail) {
  return { code, detail };
}

function hasHash(value) {
  return typeof value === 'string' && HASH.test(value);
}

function workloadError(kind, code, detail) {
  return error(`workload-${kind}-${code}`, detail);
}

const CAPABILITY_BLOCK_ERROR = /^workload-(?:auto|positive-lut)-(?:physical-provenance-invalid|runner-provenance-invalid)$/;
const SOFTWARE_ADAPTER_PATTERN = /swiftshader|lavapipe|llvmpipe|software|fallback/i;

function hasCompleteBrowserProvenance(report) {
  const adapter = report?.provenance?.adapter;
  const runner = report?.provenance?.runner;
  const adapterFields = ['vendor', 'device', 'architecture', 'description'];
  const adapterText = adapterFields.map((field) => adapter?.[field] ?? '').join(' ');
  const adapterIdentity =
    adapter !== null &&
    typeof adapter === 'object' &&
    adapter.physicalGpu === false &&
    Number.isSafeInteger(adapter.vendorId) &&
    Number.isSafeInteger(adapter.deviceId) &&
    adapterFields.every((field) => typeof adapter[field] === 'string' && adapter[field].length > 0);
  const capabilityIdentity =
    adapter?.fallbackAdapter === true ||
    adapter?.isFallbackAdapter === true ||
    SOFTWARE_ADAPTER_PATTERN.test(adapterText);
  const runnerIdentity =
    runner !== null &&
    typeof runner === 'object' &&
    typeof runner.channel === 'string' &&
    runner.channel.length > 0 &&
    typeof runner.version === 'string' &&
    runner.version.length > 0 &&
    typeof runner.headless === 'boolean' &&
    Array.isArray(runner.launchArgs) &&
    runner.launchArgs.length > 0 &&
    runner.launchArgs.every((value) => typeof value === 'string');
  return adapterIdentity && capabilityIdentity && runnerIdentity;
}

function hasCompleteSimulationProvenance(report) {
  const adapter = report?.provenance?.adapter;
  const runner = report?.provenance?.runner;
  const adapterText = ['vendor', 'device', 'architecture', 'description']
    .map((field) => adapter?.[field] ?? '')
    .join(' ');
  return (
    report?.executionMode === 'simulated' &&
    adapter !== null &&
    typeof adapter === 'object' &&
    adapter.physicalGpu === false &&
    ['vendor', 'device', 'architecture', 'description'].every(
      (field) => typeof adapter[field] === 'string' && adapter[field].length > 0,
    ) &&
    SOFTWARE_ADAPTER_PATTERN.test(adapterText) &&
    runner !== null &&
    typeof runner === 'object' &&
    runner.kind === 'playwright' &&
    typeof runner.channel === 'string' &&
    runner.channel.length > 0 &&
    typeof runner.version === 'string' &&
    runner.version.length > 0 &&
    typeof runner.headless === 'boolean' &&
    Array.isArray(runner.launchArgs) &&
    runner.launchArgs.length > 0
  );
}

function validIdentity(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.id === 'string' && value.id.length > 0 && hasHash(value.sha256);
}

function validateBundleIdentity(report, kind, errors) {
  if (report?.schemaVersion !== 'hello-taa-auto-exposure-evidence/2') {
    errors.push(workloadError(kind, 'schema-invalid', 'raw workload evidence schema must be hello-taa-auto-exposure-evidence/2'));
  }
  if (report?.featureId !== FEATURE_ID) {
    errors.push(workloadError(kind, 'feature-identity-mismatch', 'featureId must identify the auto-exposure feature'));
  }
  if (!EXECUTION_MODES.has(report?.executionMode)) {
    errors.push(workloadError(kind, 'execution-mode-invalid', 'executionMode must explicitly identify physical or simulated execution'));
  }
  if (!['observation', 'blocked'].includes(report?.status) || report?.verdictSource !== undefined) {
    errors.push(workloadError(kind, 'producer-verdict-invalid', 'raw producer evidence must remain observation-only'));
  }
  if (!report?.source || !hasHash(report.source.sha256) || typeof report.source.path !== 'string' || report.source.path.length === 0) {
    errors.push(workloadError(kind, 'source-invalid', 'source path and SHA-256 digest are required'));
  }
  if (!report?.build || !hasHash(report.build.sha256) || typeof report.build.path !== 'string' || report.build.path.length === 0) {
    errors.push(workloadError(kind, 'build-invalid', 'build path and SHA-256 digest are required'));
  }
  const fixture = report?.fixtureIdentity;
  if (fixture === null || typeof fixture !== 'object' ||
      !['asset', 'camera', 'light', 'input'].every((part) => validIdentity(fixture?.[part]))) {
    errors.push(workloadError(kind, 'fixture-invalid', 'asset, camera, light, and input identities are required'));
  }
  const frame = report?.frameIdentity;
  if (report?.frames < 60 || frame === null || typeof frame !== 'object' ||
      !Number.isSafeInteger(frame.first) || !Number.isSafeInteger(frame.last) ||
      !Number.isSafeInteger(frame.count) || frame.count < 60 ||
      frame.last - frame.first + 1 !== frame.count || frame.contiguous !== true ||
      !hasHash(frame.sequenceSha256)) {
    errors.push(workloadError(kind, 'frame-invalid', 'one contiguous 60-frame receipt window and sequence digest are required'));
  }
  const provenance = report?.provenance;
  if (provenance === null || typeof provenance !== 'object') {
    errors.push(workloadError(kind, 'provenance-missing', 'source/build/fixture/frame/backend/adapter/runner provenance is required'));
  } else {
    for (const key of REQUIRED_PROVENANCE) {
      if (provenance[key] === undefined || provenance[key] === null) {
        errors.push(workloadError(kind, 'provenance-incomplete', `provenance.${key} is required`));
      }
    }
    if (provenance.source?.sha256 !== report.source?.sha256 || provenance.build?.sha256 !== report.build?.sha256) {
      errors.push(workloadError(kind, 'provenance-drift', 'provenance source/build must match the raw report identities'));
    }
    if (JSON.stringify(provenance.frame) !== JSON.stringify(frame)) {
      errors.push(workloadError(kind, 'frame-provenance-drift', 'provenance.frame must preserve the raw receipt window'));
    }
  }
}

function validateBundleResourceGrowth(report, kind, errors) {
  const growth = report?.resourceGrowth;
  if (growth === null || typeof growth !== 'object') {
    errors.push(workloadError(kind, 'resource-growth-invalid', 'renderer-owned resource lifecycle evidence is required'));
    return;
  }
  const commonValid = Number.isSafeInteger(growth.stableFrames) && growth.stableFrames >= report.frames &&
    growth.byteLengthDelta === 0 && growth.bindGroupDelta === 0 &&
    growth.resourceCountDelta === 0 && growth.liveResourceDelta === 0;
  const countersValid = ['resourceCountDelta', 'liveResourceDelta', 'allocationCount', 'peakLiveCount', 'mapCount', 'readbackCount']
    .every((field) => Number.isSafeInteger(growth[field]) && growth[field] >= 0);
  if (!commonValid || !countersValid) {
    errors.push(workloadError(kind, 'resource-growth-invalid', 'resource growth must remain stable with non-negative lifecycle counters'));
    return;
  }
  const expected = kind === 'manual' ? 0 : DOMAINS.length;
  for (const field of ['allocationCount', 'peakLiveCount', 'mapCount', 'readbackCount']) {
    if (growth[field] !== expected) {
      errors.push(workloadError(kind, 'resource-count-invalid', `${kind} resourceGrowth.${field} must equal ${expected}`));
    }
  }
}

function validateBundleStages(report, kind, errors) {
  if (kind === 'manual') {
    if (!Array.isArray(report?.stages) || report.stages.length !== 0) {
      errors.push(workloadError(kind, 'domain-observation-invalid', 'manual zero-cost control must not publish feature domain readbacks'));
    }
    return;
  }
  const stages = report?.stages;
  if (!Array.isArray(stages) || stages.length !== DOMAINS.length) {
    errors.push(workloadError(kind, 'domain-observation-missing', 'auto and positive-LUT require exactly three domain readbacks'));
    return;
  }
  const expectedIds = ['linear-hdr', 'linear-ldr', 'final-display'];
  const hashes = stages.map((stage) => stage?.readback?.rawHash);
  if (stages.some((stage, index) => stage?.id !== expectedIds[index] || stage?.domain !== DOMAINS[index])) {
    errors.push(workloadError(kind, 'domain-set-invalid', 'domain IDs must be the canonical linear-HDR, linear-LDR, final-sRGB order'));
  }
  if (hashes.some((hash) => !hasHash(hash)) || new Set(hashes).size !== hashes.length) {
    errors.push(workloadError(kind, 'domain-capture-not-distinct', 'each domain must retain a distinct raw capture hash'));
  }
  const frame = report.frameIdentity;
  for (const [index, stage] of stages.entries()) {
    const metadata = stage?.metadata;
    const fields = ['frameId', 'deviceGeneration', 'graphGeneration', 'textureIdentity', 'readbackIdentity', 'width', 'height', 'bytesPerRow'];
    if (fields.some((field) => !Number.isSafeInteger(metadata?.[field]) || metadata[field] < 0)) {
      errors.push(workloadError(kind, 'domain-metadata-invalid', `stages[${index}] must preserve frame/device/graph/resource/readback metadata`));
    }
    if (metadata?.frameId !== frame?.last) {
      errors.push(workloadError(kind, 'domain-frame-mismatch', 'all domain captures must bind the final receipt frame'));
    }
  }
  const sharedFields = ['deviceGeneration', 'graphGeneration', 'width', 'height'];
  for (const field of sharedFields) {
    if (stages.some((stage) => stage?.metadata?.[field] !== stages[0]?.metadata?.[field])) {
      errors.push(workloadError(kind, 'domain-metadata-mismatch', 'domain captures must share device, graph, and extent identity'));
    }
  }
  const textureIds = stages.map((stage) => stage?.metadata?.textureIdentity);
  const readbackIds = stages.map((stage) => stage?.metadata?.readbackIdentity);
  if (new Set(textureIds).size !== textureIds.length || new Set(readbackIds).size !== readbackIds.length) {
    errors.push(workloadError(kind, 'domain-resource-reused', 'domain captures must retain distinct texture and readback identities'));
  }
}

function validateBundleWorkload(report, kind, { browser = false } = {}) {
  const errors = [];
  validateBundleIdentity(report, kind, errors);
  const workloads = Array.isArray(report?.workloads) ? report.workloads.filter((entry) => entry?.executed === true) : [];
  if (workloads.length !== 1 || workloads[0]?.kind !== kind) {
    errors.push(workloadError(kind, 'workload-set-invalid', `exactly one executed ${kind} workload is required`));
  }
  const workload = workloads[0];
  if (kind === 'manual') {
    if (workload?.generation !== 0 || workload?.strength !== 0) {
      errors.push(workloadError(kind, 'control-invalid', 'manual control must keep generation and LUT strength at zero'));
    }
  } else if (kind === 'auto') {
    if (workload?.exposureMode !== 'auto' || !Number.isSafeInteger(workload?.generation) || workload.generation <= 0 || workload.receipt?.committed !== true) {
      errors.push(workloadError(kind, 'exposure-invalid', 'auto workload requires auto mode, non-zero generation, and committed receipt'));
    }
  } else if (kind === 'positive-lut') {
    if (!(workload?.strength > 0) || typeof workload?.sourceKey !== 'string' || workload.sourceKey.length === 0 || !Number.isSafeInteger(workload?.generation) || workload.generation <= 0 || workload.receipt?.committed !== true) {
      errors.push(workloadError(kind, 'lut-invalid', 'positive-LUT requires strength, sourceKey, non-zero generation, and committed receipt'));
    }
  }
  if (browser && kind !== 'manual') {
    const adapter = report?.provenance?.adapter;
    const runner = report?.provenance?.runner;
    const adapterText = ['vendor', 'device', 'architecture', 'description'].map((field) => adapter?.[field] ?? '').join(' ');
    const launchArgs = Array.isArray(runner?.launchArgs) ? runner.launchArgs : [];
    if (report?.executionMode === 'simulated') {
      if (!hasCompleteSimulationProvenance(report)) {
        errors.push(workloadError(kind, 'simulation-provenance-invalid', 'simulated Browser workload must retain physicalGpu=false and observed software adapter provenance'));
      }
    } else {
      if (adapter?.physicalGpu !== true || (adapter?.fallbackAdapter !== false && adapter?.isFallbackAdapter !== false) ||
          !Number.isSafeInteger(adapter?.vendorId) || !Number.isSafeInteger(adapter?.deviceId) ||
          ['vendor', 'device', 'architecture', 'description'].some((field) => typeof adapter?.[field] !== 'string' || adapter[field].length === 0) ||
          /swiftshader|lavapipe|llvmpipe|software|fallback/i.test(adapterText)) {
        errors.push(workloadError(kind, 'physical-provenance-invalid', 'Browser workload must retain observed physical non-fallback adapter identity'));
      }
      if (runner?.kind !== 'playwright' || typeof runner?.channel !== 'string' || runner.channel.length === 0 || typeof runner?.version !== 'string' || runner.version.length === 0 || typeof runner?.headless !== 'boolean' || launchArgs.length === 0 || launchArgs.some((arg) => /swiftshader|lavapipe|llvmpipe|software|fallback/i.test(arg))) {
        errors.push(workloadError(kind, 'runner-provenance-invalid', 'Browser workload must retain Chrome channel/version/headless and actual non-software launch args'));
      }
    }
  }
  validateBundleStages(report, kind, errors);
  validateBundleResourceGrowth(report, kind, errors);
  return errors;
}

/**
 * Validate a workload-local Browser/Dawn bundle without flattening resource
 * counters or frame identity. Producers stay observation-only; this function
 * is the sole owner allowed to derive a feature verdict.
 */
export function validateFeatureEvidenceBundle(bundle) {
  const errors = [];
  let missing = false;
  const capabilityBlockedKinds = new Set();
  let rawBlocked = false;
  if (bundle?.schemaVersion !== 'hello-taa-auto-exposure-evidence-bundle/1') errors.push(error('bundle-schema-invalid', 'bundle schema must be hello-taa-auto-exposure-evidence-bundle/1'));
  if (bundle?.featureId !== FEATURE_ID) errors.push(error('feature-identity-mismatch', 'bundle featureId must identify the auto-exposure feature'));
  const backend = bundle?.backend;
  if (backend !== 'browser-webgpu' && backend !== 'dawn-node') errors.push(error('bundle-backend-invalid', 'bundle backend must be browser-webgpu or dawn-node'));
  const workloads = bundle?.workloads;
  if (workloads === null || typeof workloads !== 'object' || Array.isArray(workloads)) {
    errors.push(error('workload-bundle-missing', 'manual, auto, and positive-lut workload reports are required'));
    missing = true;
  }
  const reports = {};
  for (const kind of WORKLOAD_KINDS) {
    const entry = workloads?.[kind];
    const report = entry?.report?.featureEvidence ?? entry?.report ?? entry?.featureEvidence;
    if (report === undefined) {
      errors.push(error('workload-missing', `${kind} workload report is required`));
      missing = true;
      continue;
    }
    reports[kind] = report;
    if (report?.status === 'blocked') rawBlocked = true;
    if (
      backend === 'browser-webgpu' &&
      kind !== 'manual' &&
      report?.status === 'blocked' &&
      ((report?.executionMode === 'simulated' && hasCompleteSimulationProvenance(report)) ||
        (report?.executionMode !== 'simulated' && hasCompleteBrowserProvenance(report)))
    ) {
      capabilityBlockedKinds.add(kind);
    }
    errors.push(...validateBundleWorkload(report, kind, { browser: backend === 'browser-webgpu' }));
  }
  const baseline = reports.auto ?? reports['positive-lut'] ?? reports.manual;
  if (baseline !== undefined) {
    for (const kind of WORKLOAD_KINDS) {
      const report = reports[kind];
      if (report !== undefined && report.executionMode !== baseline.executionMode) {
        errors.push(error('execution-mode-mismatch', `${kind}.executionMode`, 'all workload observations in one backend bundle must use one execution mode'));
      }
    }
    for (const kind of WORKLOAD_KINDS) {
      const report = reports[kind];
      if (report === undefined) continue;
      if (JSON.stringify(report.source) !== JSON.stringify(baseline.source) || JSON.stringify(report.build) !== JSON.stringify(baseline.build) || JSON.stringify(report.fixtureIdentity) !== JSON.stringify(baseline.fixtureIdentity)) {
        errors.push(error('workload-identity-mismatch', `${kind} source/build/fixture identity differs from the bundle baseline`));
      }
    }
  }
  const capabilityBlocked =
    capabilityBlockedKinds.size > 0 &&
    errors.length > 0 &&
    errors.every((entry) => CAPABILITY_BLOCK_ERROR.test(entry?.code ?? ''));
  const status =
    errors.length === 0
      ? rawBlocked && capabilityBlockedKinds.size > 0
        ? 'blocked'
        : rawBlocked
          ? 'failed'
          : 'pass'
      : missing || capabilityBlocked
        ? 'blocked'
        : 'failed';
  return {
    status,
    errors,
    ...(status === 'pass' ? { verdictSource: 'validator', featureId: FEATURE_ID } : {}),
  };
}

function validateResourceGrowth(report) {
  const growth = report?.resourceGrowth;
  if (growth === null || typeof growth !== 'object') {
    return [error('resource-growth-invalid', 'renderer-owned resource lifecycle evidence is required')];
  }
  const errors = [];
  if (
    !Number.isSafeInteger(growth.stableFrames) ||
    growth.stableFrames < report.frames ||
    growth.byteLengthDelta !== 0 ||
    growth.bindGroupDelta !== 0 ||
    growth.resourceCountDelta !== 0 ||
    growth.liveResourceDelta !== 0
  ) {
    errors.push(error('resource-growth-invalid', 'resourceGrowth must prove zero live resource and payload growth across the frame window'));
  }
  for (const field of ['resourceCountDelta', 'liveResourceDelta', 'allocationCount', 'peakLiveCount', 'mapCount', 'readbackCount']) {
    if (!Number.isSafeInteger(growth[field]) || growth[field] < 0) {
      errors.push(error('resource-lifecycle-invalid', `resourceGrowth.${field} must be a non-negative safe integer`));
    }
  }
  const workloads = Array.isArray(report.workloads) ? report.workloads : [];
  const manual = workloads.find((workload) => workload?.kind === 'manual' && workload.executed === true);
  if (
    manual &&
    (growth.allocationCount !== 0 ||
      growth.mapCount !== 0 ||
      growth.readbackCount !== 0 ||
      growth.peakLiveCount !== 0)
  ) {
    errors.push(error('manual-zero-cost-resource-growth', 'manual workload resourceGrowth must have zero allocation, map, readback, and peak-live counters'));
  }
  const featureWorkload = workloads.find((workload) => (workload?.kind === 'auto' || workload?.kind === 'positive-lut') && workload.executed === true);
  if (
    featureWorkload &&
    (growth.allocationCount !== 3 || growth.mapCount !== 3 || growth.readbackCount !== 3 || growth.peakLiveCount !== 3)
  ) {
    errors.push(error('observation-resource-count', 'auto/LUT resourceGrowth must contain exactly one explicit final-frame resource per domain'));
  }
  return errors;
}

function validateFeatureEvidence(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return { status: 'blocked', errors: [error('report-missing', 'raw feature evidence must be an object')] };
  if (report.featureId !== FEATURE_ID) errors.push(error('feature-identity-mismatch', 'featureId must identify the auto-exposure feature'));
  if (report.executionMode !== undefined && !EXECUTION_MODES.has(report.executionMode)) {
    errors.push(error('execution-mode-invalid', 'executionMode must identify physical or simulated execution'));
  }
  if (report.status === 'pass' && report.verdictSource !== 'validator') errors.push(error('producer-pass-not-derived', 'raw producers cannot publish a pass verdict'));
  if (!report.source || !report.build || !report.frameIdentity || !report.fixtureIdentity || !report.provenance) errors.push(error('provenance-missing', 'source, build, fixture, frame, and provenance are required'));
  if (!report.workloads || !Array.isArray(report.workloads)) {
    errors.push(error('auto-workload-missing', 'auto workload observation is absent'));
    errors.push(error('positive-lut-workload-missing', 'positive-lut workload observation is absent'));
  } else {
    const kinds = new Set(report.workloads.filter((workload) => workload?.executed === true).map((workload) => workload.kind));
    if (!kinds.has('auto')) errors.push(error('auto-workload-missing', 'auto workload must be executed by this backend'));
    if (!kinds.has('positive-lut')) errors.push(error('positive-lut-workload-missing', 'positive-lut workload must be executed by this backend'));
    if (!kinds.has('manual')) errors.push(error('manual-control-missing', 'manual zero-cost control must be recorded'));
  }
  if (!report.stages || !Array.isArray(report.stages)) errors.push(error('domain-observation-missing', 'three independent domain observations are required'));
  else {
    const domains = report.stages.map((stage) => stage?.domain);
    if (DOMAINS.some((domain) => !domains.includes(domain))) errors.push(error('domain-observation-missing', 'linear-HDR, linear-LDR, and final-sRGB are all required'));
    const hashes = report.stages.map((stage) => stage?.readback?.rawHash);
    if (new Set(hashes).size !== hashes.length || hashes.some((hash) => !hasHash(hash))) errors.push(error('domain-capture-not-distinct', 'each domain must have a distinct raw capture hash'));
  }
  const auto = report.workloads?.find((workload) => workload?.kind === 'auto');
  if (!auto || auto.generation <= 0) errors.push(error('exposure-generation-invalid', 'auto exposure must have a non-zero generation'));
  const positiveLut = report.workloads?.find((workload) => workload?.kind === 'positive-lut');
  if (!positiveLut || positiveLut.strength <= 0 || positiveLut.generation <= 0 || typeof positiveLut.sourceKey !== 'string' || positiveLut.sourceKey.length === 0) {
    errors.push(error('lut-observation-invalid', 'positive LUT requires strength, generation, and sourceKey'));
  }
  const provenanceKeys = report.provenance && typeof report.provenance === 'object' ? REQUIRED_PROVENANCE.filter((key) => report.provenance[key] === undefined) : REQUIRED_PROVENANCE;
  if (provenanceKeys.length > 0) errors.push(error('provenance-incomplete', `missing provenance fields: ${provenanceKeys.join(',')}`));
  errors.push(...validateResourceGrowth(report));
  if (report.executionMode === 'simulated') {
    if (
      report.timing?.status !== 'blocked' ||
      report.timing?.physicalGpu !== false ||
      report.timing?.timestampQuery !== false ||
      report.timing?.source !== 'renderer-gpu-pass-timing-deferred'
    ) {
      errors.push(error('timing-source-invalid', 'simulated evidence must retain an explicit deferred physical timing record'));
    }
  } else if (
    !report.timing ||
    report.timing.source !== 'renderer-gpu-pass-timing' ||
    !Array.isArray(report.timing.passes) ||
    !REQUIRED_TIMING_PASSES.every((pass) => report.timing.passes.includes(pass)) ||
    !Array.isArray(report.timing.logicalStages) ||
    JSON.stringify(report.timing.logicalStages) !== JSON.stringify(REQUIRED_LOGICAL_STAGES)
  ) {
    errors.push(error('timing-source-invalid', 'feature timing must come from the renderer fused meter and independent LUT pass observations'));
  }
  const status = errors.length === 0 && report.status === 'pass' && report.verdictSource === 'validator' ? 'pass' : 'blocked';
  return { status, errors };
}

export { validateFeatureEvidence };

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  const report = input ? JSON.parse(readFileSync(input, 'utf8')) : JSON.parse(await new Promise((resolve) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
  }));
  const result = report?.schemaVersion === 'hello-taa-auto-exposure-evidence-bundle/1'
    ? validateFeatureEvidenceBundle(report)
    : validateFeatureEvidence(report);
  console.log(JSON.stringify(result, null, 2));
  // A blocked bundle is a valid fail-closed observation result for CI: it is
  // uploaded for the final join, which remains blocked until every gate passes.
  process.exitCode = result.status === 'failed' ? 1 : 0;
}
