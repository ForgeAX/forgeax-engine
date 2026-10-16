import { createHash } from 'node:crypto';

export const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
export const WORKLOAD_KINDS = Object.freeze(['manual', 'auto', 'positive-lut']);
export const DOMAINS = Object.freeze(['linear-HDR', 'linear-LDR', 'final-sRGB']);
export const EXECUTION_MODES = Object.freeze(['physical', 'simulated']);
const EMPTY_SEQUENCE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SOFTWARE_PROVENANCE_PATTERN = /swiftshader|lavapipe|llvmpipe|software|fallback/i;

const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const error = (code, path, detail) => ({ code, path, detail });

function workloadRecord(kind, state) {
  const workload = state?.workload;
  const auto = workload?.autoExposure;
  return {
    kind,
    executed: workload?.executed === true && workload.kind === kind,
    exposureMode: workload?.exposureMode,
    strength: Number(workload?.colorLutStrength ?? 0),
    generation:
      kind === 'manual'
        ? 0
        : Number(kind === 'positive-lut' ? workload?.lutReceipt?.generation : auto?.targetGeneration),
    sourceKey: kind === 'positive-lut' ? state?.workload?.sourceKey ?? state?.lut?.sourceKey : undefined,
    receipt: kind === 'positive-lut' ? workload?.lutReceipt : auto?.receipt,
  };
}

function validatePhysicalBrowserProvenance(provenance) {
  const errors = [];
  const adapter = provenance?.adapter;
  const runner = provenance?.runner;
  if (adapter === null || typeof adapter !== 'object') {
    errors.push(error('physical-adapter-provenance-invalid', 'provenance.adapter', 'physical Browser evidence requires an observed adapter identity'));
  } else {
    const requiredStrings = ['vendor', 'device', 'architecture', 'description'];
    const missing = requiredStrings.filter((field) => typeof adapter[field] !== 'string' || adapter[field].length === 0);
    if (
      adapter.physicalGpu !== true ||
      (adapter.fallbackAdapter !== false && adapter.isFallbackAdapter !== false) ||
      !Number.isSafeInteger(adapter.vendorId) ||
      !Number.isSafeInteger(adapter.deviceId) ||
      missing.length > 0
    ) {
      errors.push(error('physical-adapter-provenance-invalid', 'provenance.adapter', 'physicalGpu=true, fallback=false, vendor/device IDs, and vendor/device/architecture/description identity are required'));
    }
    const adapterText = requiredStrings.map((field) => adapter[field]).filter((value) => typeof value === 'string').join(' ');
    if (SOFTWARE_PROVENANCE_PATTERN.test(adapterText)) {
      errors.push(error('physical-adapter-provenance-invalid', 'provenance.adapter', 'software, fallback, SwiftShader, Lavapipe, and llvmpipe adapter identities are ineligible'));
    }
  }
  if (
    runner === null ||
    typeof runner !== 'object' ||
    typeof runner.channel !== 'string' ||
    runner.channel.length === 0 ||
    typeof runner.version !== 'string' ||
    runner.version.length === 0 ||
    typeof runner.headless !== 'boolean' ||
    !Array.isArray(runner.launchArgs) ||
    runner.launchArgs.length === 0 ||
    runner.launchArgs.some((value) => typeof value !== 'string')
  ) {
    errors.push(error('launch-provenance-invalid', 'provenance.runner', 'Chrome channel, version, headless mode, and actual launch args are required'));
  } else if (runner.launchArgs.some((value) => SOFTWARE_PROVENANCE_PATTERN.test(value))) {
    errors.push(error('launch-provenance-invalid', 'provenance.runner.launchArgs', 'software, fallback, SwiftShader, Lavapipe, and llvmpipe launch args are ineligible'));
  }
  return errors;
}

function validateSimulatedBrowserProvenance(provenance) {
  const errors = [];
  const adapter = provenance?.adapter;
  const runner = provenance?.runner;
  const adapterFields = ['vendor', 'device', 'architecture', 'description'];
  const adapterText = adapterFields.map((field) => adapter?.[field] ?? '').join(' ');
  if (
    adapter === null ||
    typeof adapter !== 'object' ||
    adapter.physicalGpu !== false ||
    adapterFields.some((field) => typeof adapter[field] !== 'string' || adapter[field].length === 0) ||
    !SOFTWARE_PROVENANCE_PATTERN.test(adapterText)
  ) {
    errors.push(error('simulation-adapter-provenance-invalid', 'provenance.adapter', 'simulated Browser evidence must retain physicalGpu=false and an observed software adapter identity'));
  }
  if (
    runner === null ||
    typeof runner !== 'object' ||
    runner.kind !== 'playwright' ||
    typeof runner.channel !== 'string' ||
    runner.channel.length === 0 ||
    typeof runner.version !== 'string' ||
    runner.version.length === 0 ||
    typeof runner.headless !== 'boolean' ||
    !Array.isArray(runner.launchArgs) ||
    runner.launchArgs.length === 0
  ) {
    errors.push(error('simulation-runner-provenance-invalid', 'provenance.runner', 'simulated Browser evidence must retain Chrome channel/version/headless and launch provenance'));
  }
  return errors;
}

function validateResourceGrowth(input, workload) {
  const growth = input.resourceGrowth;
  if (growth === null || typeof growth !== 'object') {
    return [error('resource-growth', 'resourceGrowth', 'renderer-owned resource lifecycle evidence is required for the complete frame window')];
  }
  const errors = [];
  const lifecycleFields = ['resourceCountDelta', 'liveResourceDelta', 'allocationCount', 'peakLiveCount', 'mapCount', 'readbackCount'];
  if (
    !Number.isSafeInteger(growth.stableFrames) ||
    growth.stableFrames < input.frames ||
    growth.byteLengthDelta !== 0 ||
    growth.bindGroupDelta !== 0 ||
    growth.resourceCountDelta !== 0 ||
    growth.liveResourceDelta !== 0
  ) {
    errors.push(error('resource-growth', 'resourceGrowth', 'the complete frame window must provide zero live resource and payload growth'));
  }
  for (const field of lifecycleFields) {
    if (!Number.isSafeInteger(growth[field]) || growth[field] < 0) {
      errors.push(error('resource-lifecycle-invalid', `resourceGrowth.${field}`, 'renderer-owned allocation, live, map, and readback counters must be non-negative safe integers'));
    }
  }
  if (
    Number.isSafeInteger(growth.allocationCount) &&
    Number.isSafeInteger(growth.mapCount) &&
    Number.isSafeInteger(growth.readbackCount) &&
    Number.isSafeInteger(growth.peakLiveCount)
  ) {
    if (workload.kind === 'manual') {
      if (growth.allocationCount !== 0 || growth.mapCount !== 0 || growth.readbackCount !== 0 || growth.peakLiveCount !== 0) {
        errors.push(error('manual-zero-cost-resource-growth', 'resourceGrowth', 'manual/D65/no-LUT control must allocate, map, and read back zero observation resources'));
      }
    } else if (
      growth.allocationCount !== DOMAINS.length ||
      growth.mapCount !== DOMAINS.length ||
      growth.readbackCount !== DOMAINS.length ||
      growth.peakLiveCount !== DOMAINS.length
    ) {
      errors.push(error('observation-resource-count', 'resourceGrowth', 'one explicit final-frame observation resource is required for each of the three domains, with no per-frame growth'));
    }
  }
  return errors;
}

function collectErrors(input, workload, { requirePhysicalBrowser = true, executionMode = 'physical' } = {}) {
  const errors = [];
  if (!WORKLOAD_KINDS.includes(workload.kind)) errors.push(error('workload-kind-invalid', 'workload.kind', 'manual, auto, or positive-lut is required'));
  if (workload.executed !== true) errors.push(error('workload-not-executed', 'workload.executed', 'the Browser must report an executed workload'));
  if (workload.kind === 'auto') {
    if (workload.exposureMode !== 'auto') errors.push(error('auto-mode-missing', 'workload.exposureMode', 'auto exposure must be active'));
    if (!Number.isInteger(workload.generation) || workload.generation <= 0) errors.push(error('exposure-generation-missing', 'workload.generation', 'renderer inspection must report a non-zero target generation'));
    if (workload.receipt?.committed !== true) errors.push(error('exposure-receipt-missing', 'workload.receipt.committed', 'a committed renderer receipt is required'));
  }
  if (workload.kind === 'positive-lut') {
    if (!(workload.strength > 0)) errors.push(error('lut-strength-missing', 'workload.strength', 'positive LUT strength must be greater than zero'));
    if (typeof workload.sourceKey !== 'string' || workload.sourceKey.length === 0) errors.push(error('lut-source-missing', 'workload.sourceKey', 'the producer must observe a source key'));
    if (!Number.isInteger(workload.generation) || workload.generation <= 0) errors.push(error('lut-generation-missing', 'workload.generation', 'the LUT receipt must have a non-zero generation'));
    if (workload.receipt?.committed !== true) errors.push(error('lut-receipt-missing', 'workload.receipt.committed', 'a committed renderer LUT receipt is required'));
  }
  if (input.frames < 60) errors.push(error('frame-window-short', 'frames', 'a stable 60-frame window is required'));
  const frameIdentity = input.frameIdentity;
  if (
    !frameIdentity ||
    frameIdentity.count !== input.frames ||
    !Number.isSafeInteger(frameIdentity.first) ||
    !Number.isSafeInteger(frameIdentity.last) ||
    typeof frameIdentity.sequenceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(frameIdentity.sequenceSha256) ||
    frameIdentity.sequenceSha256 === EMPTY_SEQUENCE_SHA256 ||
    frameIdentity.last - frameIdentity.first + 1 !== frameIdentity.count ||
    frameIdentity.contiguous !== true
  ) {
    errors.push(error('frame-identity-invalid', 'frameIdentity', 'first, last, count, and contiguous receipt IDs must identify the capture window'));
  }
  const fixtureParts = ['asset', 'camera', 'light', 'input'];
  if (!input.fixtureIdentity) {
    errors.push(error('fixture-identity-missing', 'fixtureIdentity', 'asset, camera, light, and input identities are required'));
  } else {
    for (const part of fixtureParts) {
      const identity = input.fixtureIdentity[part];
      if (
        identity === null ||
        typeof identity !== 'object' ||
        typeof identity.id !== 'string' ||
        identity.id.length === 0 ||
        typeof identity.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(identity.sha256)
      ) {
        errors.push(error('fixture-identity-invalid', `fixtureIdentity.${part}`, 'each fixture participant needs a stable id and SHA-256 digest'));
      }
    }
  }
  const provenance = input.provenance;
  if (provenance === null || typeof provenance !== 'object') {
    errors.push(error('provenance-missing', 'provenance', 'source/build/backend/adapter/runner provenance is required'));
  } else {
    for (const [name, value] of [['source', provenance.source], ['build', provenance.build]]) {
      if (
        value === null ||
        typeof value !== 'object' ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
      ) {
        errors.push(error('provenance-identity-invalid', `provenance.${name}`, 'source and build provenance require a path and SHA-256 digest'));
      }
    }
    if (typeof provenance.fixture !== 'string' || provenance.fixture.length === 0) {
      errors.push(error('provenance-identity-invalid', 'provenance.fixture', 'the fixture source path is required'));
    }
    if (typeof provenance.backend !== 'string' || provenance.backend.length === 0) {
      errors.push(error('provenance-identity-invalid', 'provenance.backend', 'backend identity is required'));
    }
    if (provenance.adapter === null || typeof provenance.adapter !== 'object') {
      errors.push(error('provenance-identity-invalid', 'provenance.adapter', 'adapter capabilities are required'));
    }
    if (
      provenance.runner === null ||
      typeof provenance.runner !== 'object' ||
      typeof provenance.runner.kind !== 'string' ||
      provenance.runner.kind.length === 0 ||
      typeof provenance.runner.id !== 'string' ||
      provenance.runner.id.length === 0
    ) {
      errors.push(error('provenance-identity-invalid', 'provenance.runner', 'runner kind and id are required'));
    }
    if (
      provenance.frame === null ||
      typeof provenance.frame !== 'object' ||
      provenance.frame.first !== input.frameIdentity?.first ||
      provenance.frame.last !== input.frameIdentity?.last ||
      provenance.frame.count !== input.frameIdentity?.count ||
      provenance.frame.contiguous !== true ||
      provenance.frame.sequenceSha256 !== input.frameIdentity?.sequenceSha256
    ) {
      errors.push(error('provenance-identity-invalid', 'provenance.frame', 'provenance frame identity must equal the receipt window'));
    }
    if (workload.kind !== 'manual' && requirePhysicalBrowser) {
      errors.push(
        ...(executionMode === 'simulated'
          ? validateSimulatedBrowserProvenance(provenance)
          : validatePhysicalBrowserProvenance(provenance)),
      );
    }
  }
  errors.push(...validateResourceGrowth(input, workload));
  if (
    input.source === null ||
    typeof input.source !== 'object' ||
    typeof input.source.path !== 'string' ||
    input.source.path.length === 0 ||
    typeof input.source.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.source.sha256)
  ) {
    errors.push(error('source-identity-invalid', 'source', 'source path and SHA-256 digest are required'));
  }
  if (
    input.build === null ||
    typeof input.build !== 'object' ||
    typeof input.build.path !== 'string' ||
    input.build.path.length === 0 ||
    typeof input.build.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.build.sha256)
  ) {
    errors.push(error('build-identity-invalid', 'build', 'build path and SHA-256 digest are required'));
  }
  if (
    input.resolution === null ||
    typeof input.resolution !== 'object' ||
    !Number.isSafeInteger(input.resolution.width) ||
    input.resolution.width <= 0 ||
    !Number.isSafeInteger(input.resolution.height) ||
    input.resolution.height <= 0
  ) {
    errors.push(error('resolution-invalid', 'resolution', 'positive output dimensions are required'));
  }
  const stages = Array.isArray(input.stages) ? input.stages : [];
  if (workload.kind !== 'manual') {
    if (stages.length !== DOMAINS.length) errors.push(error('domain-readback-missing', 'stages', 'three independent raw GPU readbacks are required'));
    const domains = stages.map((stage) => stage?.domain);
    if (DOMAINS.some((domain) => !domains.includes(domain)) || new Set(domains).size !== DOMAINS.length) {
      errors.push(error('domain-set-invalid', 'stages.*.domain', 'the exact linear-HDR, linear-LDR, and final-sRGB domain set is required'));
    }
    const expectedIds = ['linear-hdr', 'linear-ldr', 'final-display'];
    for (const [index, stage] of stages.entries()) {
      if (stage?.id !== expectedIds[index] || stage?.domain !== DOMAINS[index]) {
        errors.push(error('domain-pairing-invalid', `stages[${index}]`, 'stage id and domain must be the canonical one-to-one pair'));
      }
    }
    const hashes = stages.map((stage) => stage?.readback?.rawHash);
    if (hashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) errors.push(error('domain-readback-invalid', 'stages.*.readback.rawHash', 'raw stage hashes must be 64-character digests'));
    if (new Set(hashes).size !== hashes.length) errors.push(error('domain-readback-not-distinct', 'stages.*.readback.rawHash', 'linear HDR, linear LDR, and final sRGB must be distinct captures'));
    const metadataFields = ['frameId', 'deviceGeneration', 'graphGeneration', 'textureIdentity', 'readbackIdentity', 'width', 'height', 'bytesPerRow'];
    for (const [index, stage] of stages.entries()) {
      for (const field of metadataFields) {
        if (!Number.isSafeInteger(stage?.metadata?.[field]) || stage.metadata[field] < 0) {
          errors.push(error('domain-metadata-missing', `stages[${index}].metadata.${field}`, 'each raw capture must retain renderer frame, graph, resource, and readback identity'));
        }
      }
    }
    // Bytes-per-row belongs to each capture's format and may legitimately
    // differ between the rgba16float linear targets and the rgba8 final
    // sRGB target. Frame/device/graph/extent identity is the cross-domain
    // invariant; validate each row's stride above without conflating it with
    // shared resource identity.
    const sharedFields = ['deviceGeneration', 'graphGeneration', 'width', 'height'];
    const sharedMetadata = stages[0]?.metadata;
    for (const field of sharedFields) {
      if (stages.some((stage) => stage?.metadata?.[field] !== sharedMetadata?.[field])) {
        errors.push(error('domain-metadata-mismatch', `stages.*.metadata.${field}`, 'all domain captures must share one frame device, graph, and extent identity'));
      }
    }
    const textureIdentities = stages.map((stage) => stage?.metadata?.textureIdentity);
    const readbackIdentities = stages.map((stage) => stage?.metadata?.readbackIdentity);
    if (new Set(textureIdentities).size !== textureIdentities.length) errors.push(error('texture-identity-reused', 'stages.*.metadata.textureIdentity', 'domain captures must not reuse the source texture identity'));
    if (new Set(readbackIdentities).size !== readbackIdentities.length) errors.push(error('readback-identity-reused', 'stages.*.metadata.readbackIdentity', 'domain captures must not reuse the readback identity'));
    if (frameIdentity && stages.some((stage) => stage?.metadata?.frameId !== frameIdentity.last)) {
      errors.push(error('domain-frame-mismatch', 'stages.*.metadata.frameId', 'all domain captures must bind the final receipt frame of the window'));
    }
  }
  return errors;
}

/**
 * Build only raw Browser observations. This producer never emits a feature
 * pass; missing renderer-owned receipts/readbacks remain explicitly blocked.
 */
function createFeatureObservation(input = {}, { requirePhysicalBrowser = true } = {}) {
  const executionMode = input.executionMode ??
    (process.env.FORGEAX_AUTO_EXPOSURE_EXECUTION_MODE === 'simulated' ? 'simulated' : 'physical');
  const workload = workloadRecord(input.workloadKind, input.state);
  const report = {
    schemaVersion: 'hello-taa-auto-exposure-evidence/2',
    featureId: FEATURE_ID,
    source: input.source ?? { path: 'apps/hello/taa/src/main.ts', sha256: digest('missing-source') },
    build: input.build ?? { path: 'apps/hello/taa/dist/index.html', sha256: digest('missing-build') },
    backend: input.backend ?? input.state?.backend ?? 'browser-webgpu',
    executionMode,
    runner: input.runner ?? { kind: 'playwright', id: 'unknown' },
    resolution: input.resolution ?? { width: 0, height: 0 },
    frames: input.frames ?? 0,
    frameIdentity: input.frameIdentity,
    stages: input.stages ?? [],
    workloads: [workload],
    fixtureIdentity: input.fixtureIdentity,
    ...(input.scene === undefined ? {} : { scene: input.scene }),
    provenance: input.provenance,
    resourceGrowth: input.resourceGrowth,
    visualEvidence: input.visualEvidence ?? [],
    timing: input.timing,
    status: 'blocked',
  };
  report.errors = collectErrors(input, workload, {
    requirePhysicalBrowser,
    executionMode,
  });
  if (!EXECUTION_MODES.includes(executionMode)) {
    report.errors.push(error('execution-mode-invalid', 'executionMode', 'executionMode must be physical or simulated'));
  }
  if (report.errors.length === 0) report.status = 'observation';
  return report;
}

export function createBrowserFeatureObservation(input = {}) {
  return createFeatureObservation(input, {
    requirePhysicalBrowser: true,
  });
}

/**
 * Build Dawn raw observations without applying the Browser-only Chrome
 * physical-launch contract. Dawn still carries explicit adapter/runner
 * provenance; physical qualification remains a separate validator gate.
 */
export function createDawnFeatureObservation(input = {}) {
  return createFeatureObservation(input, { requirePhysicalBrowser: false });
}

export function validateBrowserFeatureObservation(input) {
  const report = createBrowserFeatureObservation(input);
  return { ok: report.status === 'observation', status: report.status, errors: report.errors, report };
}
