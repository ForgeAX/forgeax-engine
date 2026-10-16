import { execFileSync } from 'node:child_process';

export const PERFORMANCE_ADMISSION_SCHEMA_VERSION = 'hello-taa-performance-admission/1';
export const WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION = 'hello-taa-webgl2-performance-admission/1';

export const RESOLUTIONS = Object.freeze([
  Object.freeze({ name: '1080p', width: 1920, height: 1080 }),
  Object.freeze({ name: '1440p', width: 2560, height: 1440 }),
  Object.freeze({ name: '4K', width: 3840, height: 2160 }),
]);

export const PERFORMANCE_ADMISSION_THRESHOLDS = Object.freeze({
  native1080p: Object.freeze({ medianMs: 1.5, p95Ms: 2.5 }),
  cpuWebgl2: Object.freeze({ relativeMedian: 0.2 }),
});

export const ACCELERATION_ATTESTATION_KINDS = Object.freeze([
  'direct-device',
  'provider-backed-paravirtual',
]);

/**
 * Project renderer-owned active logical work from an inspection snapshot.
 * `perFramePassNames`/`passes` is the compiled topology and may retain an
 * optional pass while a feature is disabled, so it is evidence only for the
 * topology half of this projection. The temporal target and Motion Blur
 * state are the execution authorities used by the performance contract.
 */
export function activePassCountersFromInspection(inspection = {}) {
  const passes = Array.isArray(inspection?.perFramePassNames)
    ? inspection.perFramePassNames
    : Array.isArray(inspection?.passes)
      ? inspection.passes
      : [];
  const producer =
    passes.includes('standard-scene-data') && inspection?.temporalTarget?.targetCount === 1 ? 1 : 0;
  const motionBlur = inspection?.motionBlur;
  const blurActive =
    motionBlur?.enabled === true &&
    motionBlur?.status === 'active' &&
    motionBlur?.temporalDemand === 'scene-data-temporal-v1';
  return {
    producer,
    blur: blurActive ? passes.filter((pass) => pass === 'motion-blur').length : 0,
  };
}

function validAccelerationAttestation(attestation) {
  if (attestation?.kind === 'direct-device') return Object.keys(attestation).every((key) => key === 'kind');
  return (
    attestation?.kind === 'provider-backed-paravirtual' &&
    attestation.provider === 'github-hosted/macos-15-xlarge' &&
    attestation.deviceType === 'AppleParavirtGPU' &&
    attestation.driver === 'AppleParavirtGPUMetalIOGPUFamily' &&
    attestation.requestedBackend === 'metal' &&
    attestation.isFallbackAdapter === false &&
    Object.keys(attestation).every((key) =>
      ['kind', 'provider', 'deviceType', 'driver', 'requestedBackend', 'isFallbackAdapter'].includes(key),
    )
  );
}

export function qualifiedNativeFromAttestation(attestation, context = {}) {
  if (!validAccelerationAttestation(attestation)) return false;
  if (attestation.kind === 'direct-device') return context.physicalGpu === true;
  const facts = context.runnerFacts;
  return (
    context.physicalGpu === false &&
    context.provider === 'github-hosted/macos-15-xlarge' &&
    facts?.environment === 'github-hosted' &&
    facts.os === 'macOS' &&
    facts.arch === 'ARM64' &&
    context.requestedBackend === 'metal' &&
    context.isFallbackAdapter === false
  );
}

const RUNNER_CLASSES = Object.freeze({
  // CPU-WebGL2 may share the hosted physical-GPU provider because this lane
  // measures the browser's WebGL2 fallback contract, not native GPU timing.
  // The Linux heavy pool remains valid and proves bounded CPU capacity.
  cpuWebgl2: new Set([
    'self-hosted/Linux/X64/heavy',
    'github-hosted/macOS/ARM64/native-gpu',
    'github-hosted/macOS/X64/native-gpu',
  ]),
  // Native admission must use a provider that can prove a physical GPU. The
  // hosted macOS lane is the current provider; the explicit self-hosted slot
  // is reserved for a future GPU-labelled Linux runner, never ordinary
  // llvmpipe heavy capacity.
  native1080p: new Set([
    'github-hosted/macOS/ARM64/native-gpu',
    'github-hosted/macOS/X64/native-gpu',
    'self-hosted/Linux/X64/native-gpu',
  ]),
});

export function performanceIdentityFromEnv(environment = process.env, cwd = process.cwd()) {
  const checkoutRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  const testedRevision = environment.FORGEAX_TESTED_SHA ?? checkoutRevision;
  const sourceRevision = environment.FORGEAX_SOURCE_REVISION ?? checkoutRevision;
  return {
    checkoutRevision,
    testedRevision,
    sourceRevision,
    testedRevisionMatchesCheckout: testedRevision === checkoutRevision,
  };
}

export function runnerProvenanceFromEnv(environment = process.env) {
  const runnerFacts = {
    environment: environment.RUNNER_ENVIRONMENT,
    os: environment.RUNNER_OS,
    arch: environment.RUNNER_ARCH,
    queue: environment.RUNNER_QUEUE,
  };
  const runnerName = environment.RUNNER_NAME;
  const missing = Object.entries({ runnerName, ...runnerFacts })
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `runner provenance is unavailable: missing ${missing.join(',')}`,
      runnerName: runnerName ?? null,
      runnerFacts,
    };
  }
  const runnerClass = [
    runnerFacts.environment,
    runnerFacts.os,
    runnerFacts.arch,
    runnerFacts.queue,
  ].join('/');
  const lane = environment.FORGEAX_PERFORMANCE_LANE ?? 'cpuWebgl2';
  const allowedClasses = RUNNER_CLASSES[lane];
  if (!(allowedClasses instanceof Set) || !allowedClasses.has(runnerClass)) {
    const expected = allowedClasses instanceof Set ? [...allowedClasses].join(' or ') : 'a declared performance lane';
    return {
      ok: false,
      reason: `runner provenance is unavailable: expected ${expected}, got ${runnerClass}`,
      runnerName,
      runnerFacts,
      runnerClass,
    };
  }
  return { ok: true, runnerName, runnerClass, runnerFacts };
}

export function cpuAffinityFromEnv(environment = process.env) {
  const raw = environment.FORGEAX_RUNNER_CPU_AFFINITY;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'CPU affinity provenance is unavailable: missing FORGEAX_RUNNER_CPU_AFFINITY' };
  }
  let cpuAffinity;
  try {
    cpuAffinity = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'CPU affinity provenance is unavailable: malformed JSON' };
  }
  if (!validCpuAffinity(cpuAffinity)) {
    return { ok: false, reason: 'CPU affinity provenance is unavailable: malformed facts' };
  }
  return { ok: true, cpuAffinity };
}

export function temporalTargetBytes(width, height) {
  return width * height * 8;
}

function countPass(passes, name) {
  return passes.filter((pass) => pass === name).length;
}

export function createCorrectnessEvidence(summary, identity) {
  const passes = Array.isArray(summary.passes) ? summary.passes : [];
  const producerPassCount = countPass(passes, 'standard-scene-data');
  const motionBlurPassCount = countPass(passes, 'motion-blur');
  const rasterPassCount = producerPassCount + motionBlurPassCount;
  const target = summary.temporalTarget?.descriptor;
  const bytesPerPixel = target?.width > 0 && target?.height > 0 ? target.bytes / (target.width * target.height) : null;
  return {
    schemaVersion: PERFORMANCE_ADMISSION_SCHEMA_VERSION,
    lane: 'correctness-lavapipe',
    status: 'pass',
    acceptance: 'correctness-only',
    timingAdmission: 'not-admitted',
    resourceEvidence: {
      basis: 'active-logical-descriptor',
      resolutionProjection: 'scaled-estimate',
      lifecyclePeak: 'not-observed',
      driverAllocation: 'unavailable',
    },
    testedRevision: identity.testedRevision,
    sourceRevision: identity.sourceRevision,
    buildDigest: identity.buildDigest,
    runner: { class: 'self-hosted-heavy', queue: 'none', execution: 'structural-plus-readback' },
    backend: 'webgpu',
    gpuTimestamp: false,
    source: identity.source,
    build: identity.build,
    observed: {
      frames: summary.framesObserved,
      backend: summary.backend,
      temporal: summary.temporal,
      producerPassCount,
      motionBlurPassCount,
      rasterPassCount,
      temporalTargetCount: producerPassCount,
      temporalTarget: summary.temporalTarget,
      creation: summary.creation,
      passes,
    },
    resolutions: RESOLUTIONS.map((resolution) => ({
      ...resolution,
      temporalTarget: {
        format: 'rgba16float',
        sampleCount: 1,
        bytes: resolution.width * resolution.height * bytesPerPixel,
      },
    })),
  };
}

export function validateCorrectnessEvidence(evidence) {
  const errors = [];
  if (evidence?.schemaVersion !== PERFORMANCE_ADMISSION_SCHEMA_VERSION)
    errors.push('schemaVersion');
  if (evidence?.lane !== 'correctness-lavapipe' || evidence?.status !== 'pass')
    errors.push('status');
  if (evidence?.timingAdmission !== 'not-admitted') errors.push('timingAdmission');
  if (typeof evidence?.sourceRevision !== 'string' || evidence.sourceRevision.length === 0) errors.push('sourceRevision');
  if (evidence?.backend !== 'webgpu' || evidence?.gpuTimestamp !== false) errors.push('backend');
  if (evidence?.observed?.frames < 60) errors.push('frames');
  if (evidence?.observed?.temporal?.status !== 'stable') errors.push('temporal.status');
  if (evidence?.observed?.temporal?.historyValid !== true) errors.push('historyValid');
  if (evidence?.observed?.producerPassCount !== 1) errors.push('producerPassCount');
  if (evidence?.observed?.motionBlurPassCount !== 1) errors.push('motionBlurPassCount');
  if (evidence?.observed?.rasterPassCount !== 2) errors.push('rasterPassCount');
  if (evidence?.observed?.temporalTargetCount !== evidence?.observed?.producerPassCount) errors.push('temporalTargetCount');
  const target = evidence?.observed?.temporalTarget;
  if (
    target?.identity !== 'standard-scene-temporal' ||
    target?.producerId !== 'forgeax::standard::scene-data' ||
    target?.schema !== 'forgeax::scene-data::temporal-v1' ||
    target?.targetCount !== 1 ||
    target?.descriptor === undefined ||
    target.descriptor.format !== 'rgba16float' ||
    target.descriptor.sampleCount !== 1 ||
    target.descriptor.width <= 0 ||
    target.descriptor.height <= 0 ||
    target.descriptor.bytes !== target.descriptor.width * target.descriptor.height * 8
  ) errors.push('temporalTarget');
  if (
    evidence?.observed?.creation?.texture !== 0 ||
    evidence?.observed?.creation?.buffer !== 0 ||
    evidence?.observed?.creation?.pipeline !== 0
  )
    errors.push('creation');
  const bytesPerPixel =
    target?.descriptor?.width > 0 && target?.descriptor?.height > 0
      ? target.descriptor.bytes / (target.descriptor.width * target.descriptor.height)
      : null;
  const expected = RESOLUTIONS.map((resolution) => ({
    ...resolution,
    temporalTarget: {
      format: 'rgba16float',
      sampleCount: 1,
      bytes: resolution.width * resolution.height * bytesPerPixel,
    },
  }));
  if (JSON.stringify(evidence?.resolutions) !== JSON.stringify(expected)) errors.push('resolutions');
  return { ok: errors.length === 0, errors };
}

export function quantile(samples, q) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function validExactSamples(samples, sampleCount) {
  return Array.isArray(samples) && samples.length === sampleCount && validSamples(samples);
}

function validPassCounters(counters, blur) {
  return counters?.producer === 1 && counters?.blur === blur;
}

function validNativeAccelerationFacts(adapterFacts, runnerFacts) {
  const attestation = adapterFacts?.accelerationAttestation;
  if (!validAccelerationAttestation(attestation)) return false;
  if (
    !qualifiedNativeFromAttestation(attestation, {
      physicalGpu: adapterFacts?.physicalGpu,
      provider: adapterFacts?.provider,
      requestedBackend: adapterFacts?.requestedBackend,
      isFallbackAdapter: adapterFacts?.isFallbackAdapter,
      runnerFacts,
    })
  ) return false;
  if (attestation.kind === 'direct-device') {
    return (
      adapterFacts.physicalGpu === true &&
      validLabel(adapterFacts.vendor) &&
      validLabel(adapterFacts.device) &&
      validLabel(adapterFacts.driver) &&
      validLabel(adapterFacts.deviceType)
    );
  }
  // Provider-backed paravirtual devices intentionally have no direct-device
  // identity. Their exact service pair is carried by the attestation itself;
  // empty top-level vendor/device/driver/deviceType fields must remain valid.
  return adapterFacts.physicalGpu === false;
}

function validBuildArtifact(artifact) {
  const validSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  return (
    artifact?.root === 'apps/hello/taa/dist' &&
    validSha256(artifact.indexSha256) &&
    validSha256(artifact.shaderManifestSha256) &&
    artifact.sourcePayload === 'apps/hello/taa/index.html+src'
  );
}

function validSamples(samples) {
  return Array.isArray(samples) && samples.length >= 10 && samples.every((value) => Number.isFinite(value) && value >= 0);
}

function validLabel(value) {
  return typeof value === 'string' && value.length > 0;
}

function validCpuList(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.split(',').every((part) => /^(\d+)(?:-(\d+))?$/.test(part) && (() => {
      const [start, end = start] = part.split('-').map(Number);
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start;
    })())
  );
}

function parseCpuList(value) {
  if (!validCpuList(value)) return undefined;
  const cpus = [];
  for (const part of value.split(',')) {
    const [start, end = start] = part.split('-').map(Number);
    for (let cpu = start; cpu <= end; cpu += 1) cpus.push(cpu);
  }
  return [...new Set(cpus)];
}

function validCpuAffinity(affinity) {
  if (
    affinity?.ok !== true ||
    !['none', 'taskset'].includes(affinity.mode) ||
    !validLabel(affinity.reason) ||
    !Number.isInteger(affinity.runnerCpus) ||
    affinity.runnerCpus < 1 ||
    typeof affinity.containerized !== 'boolean' ||
    !Number.isInteger(affinity.allowedCpuCount) ||
    affinity.allowedCpuCount < 0 ||
    typeof affinity.allowedCpuList !== 'string'
  ) return false;
  if (affinity.mode === 'none') return true;
  const allowedCpus = parseCpuList(affinity.allowedCpuList);
  const selectedCpus = parseCpuList(affinity.selectedCpuList);
  if (allowedCpus === undefined || selectedCpus === undefined) return false;
  return (
    Number.isInteger(affinity.selectedCpuCount) &&
    affinity.selectedCpuCount > 0 &&
    affinity.allowedCpuCount > 0 &&
    affinity.allowedCpuCount === allowedCpus.length &&
    affinity.selectedCpuCount === selectedCpus.length &&
    selectedCpus.every((cpu) => allowedCpus.includes(cpu))
  );
}

function validRunnerProvenance(provenance) {
  const facts = provenance?.runnerFacts;
  if (!validLabel(provenance?.runnerName)) return false;
  if (!validLabel(provenance?.queue)) return false;
  if (!validLabel(facts?.environment) || !validLabel(facts?.os) || !validLabel(facts?.arch) || !validLabel(facts?.queue)) return false;
  return (
    provenance.queue === facts.queue &&
    [facts.environment, facts.os, facts.arch, facts.queue].join('/') === provenance.runnerClass &&
    [...RUNNER_CLASSES.cpuWebgl2, ...RUNNER_CLASSES.native1080p].includes(provenance.runnerClass)
  );
}

function validRunnerProvenanceForLane(provenance, lane) {
  return validRunnerProvenance(provenance) && RUNNER_CLASSES[lane] instanceof Set && RUNNER_CLASSES[lane].has(provenance.runnerClass);
}

function validLaneProvenance(name, lane) {
  const allowedBackends = {
    native1080p: new Set(['webgpu-native', 'webgpu']),
    cpuWebgl2: new Set(['webgl2', 'wgpu-webgl2']),
  };
  if (!allowedBackends[name]?.has(lane?.backend)) return false;
  if (!validRunnerProvenanceForLane(lane, name)) return false;
  if (name === 'native1080p') {
    const adapterFacts = lane.adapterFacts;
    return (
      lane.capabilities?.rgba16floatRenderable === true &&
      typeof lane.capabilities?.timestampQuery === 'boolean' &&
      lane.timing?.source === 'wall-time' &&
      lane.timing?.unit === 'ms' &&
      validNativeAccelerationFacts(adapterFacts, lane.runnerFacts)
    );
  }
  return (
    lane.capabilities?.compute === false &&
    lane.capabilities?.storageBuffer === false &&
    lane.capabilities?.rgba16floatRenderable === true &&
    lane.timing?.source === 'page-rAF' &&
    lane.timing?.unit === 'ms/frame'
  );
}

function validSamplePair(samples, sampleCount) {
  return validSamples(samples) && samples.length === sampleCount;
}

function expectedStats(samples) {
  return { median: quantile(samples, 0.5), p95: quantile(samples, 0.95) };
}

function pairDelta(off, on) {
  if (off.length !== on.length) return null;
  const deltas = on.map((value, index) => value - off[index]);
  return { median: quantile(deltas, 0.5), p95: quantile(deltas, 0.95) };
}

function performanceAdmissionMissingFacts(nativeSummary, cpuProducer, identity) {
  const protocol = cpuProducer?.protocol;
  const sampleCount = protocol?.sampleCount;
  const nativeTiming = nativeSummary?.timing;
  const nativeMeta = nativeSummary?.performanceAdmission;
  const cpuPass = cpuProducer?.rawPassSamplesMs;
  const nativePass = nativeTiming?.rawPassSamplesMs;
  const missing = [];
  if (nativeSummary?.backend !== 'webgpu') missing.push('native.backend');
  if (!Number.isInteger(nativeSummary?.framesObserved) || nativeSummary.framesObserved < 60)
    missing.push('native.frames');
  if (!Array.isArray(nativeSummary?.errors) || nativeSummary.errors.length !== 0)
    missing.push('native.errors');
  if (!Array.isArray(nativeSummary?.drawErrors) || nativeSummary.drawErrors.length !== 0)
    missing.push('native.drawErrors');
  if (nativeSummary?.buildDigest !== identity.buildDigest) missing.push('native.buildDigest');
  if (nativeSummary?.testedRevision !== identity.testedRevision) missing.push('native.testedRevision');
  if (nativeSummary?.sourceRevision !== identity.sourceRevision) missing.push('native.sourceRevision');
  if (!validBuildArtifact(nativeSummary?.buildArtifact)) missing.push('native.buildArtifact');
  if (!validBuildArtifact(cpuProducer?.buildArtifact)) missing.push('cpu.buildArtifact');
  if (JSON.stringify(nativeSummary?.buildArtifact) !== JSON.stringify(cpuProducer?.buildArtifact)) missing.push('buildArtifact.match');
  if (nativeMeta === undefined) missing.push('native.performance-admission-provenance');
  if (nativeMeta?.status === 'unavailable') missing.push(`native.unavailable:${nativeMeta.reason}`);
  if (!validRunnerProvenanceForLane(nativeMeta, 'native1080p')) missing.push('native.runner-provenance');
  if (nativeMeta?.execution !== 'frame-receipt-complete') missing.push('native.frame-receipt');
  const nativeAdapterFacts = nativeMeta?.adapterFacts;
  if (!validNativeAccelerationFacts(nativeAdapterFacts, nativeMeta?.runnerFacts))
    missing.push('native.acceleration-attestation');
  if (!validCpuAffinity(nativeMeta?.cpuAffinity)) missing.push('native.cpu-affinity');
  if (
    nativeTiming?.source !== 'wall-time' ||
    nativeTiming?.unit !== 'ms' ||
    nativeTiming?.gpuTimestamp !== false
  ) missing.push('native.timing');
  if (!Number.isInteger(nativeTiming?.warmupCount) || nativeTiming.warmupCount < 0)
    missing.push('native.warmupCount');
  if (
    !Number.isInteger(sampleCount) ||
    sampleCount < 10 ||
    JSON.stringify(protocol?.order) !== JSON.stringify(['off', 'on'])
  ) missing.push('protocol');
  if (nativeSummary?.resolution?.width !== 1920 || nativeSummary?.resolution?.height !== 1080)
    missing.push('native.resolution');
  if (nativeSummary?.performanceAdmission?.capabilities?.rgba16floatRenderable !== true)
    missing.push('native.rgba16floatRenderable');
  if (nativeTiming?.sampleCount !== sampleCount) missing.push('native.sampleCount');
  if (
    JSON.stringify(nativeTiming?.order) !== JSON.stringify(['off', 'on'])
  ) missing.push('native.protocol');
  if (
    !validExactSamples(nativeTiming?.offMs, sampleCount) ||
    !validExactSamples(nativeTiming?.onMs, sampleCount)
  ) missing.push('native.rawSamplesMs');
  if (!validPassCounters(nativeTiming?.passCounters?.off, 0) || !validPassCounters(nativeTiming?.passCounters?.on, 1))
    missing.push('native.passCounters');
  if (cpuProducer?.schemaVersion !== WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION) missing.push('cpu.schemaVersion');
  if (cpuProducer?.status !== 'observed') missing.push('cpu.status');
  if (!validRunnerProvenanceForLane(cpuProducer, 'cpuWebgl2')) missing.push('cpu.runner-provenance');
  if (!validCpuAffinity(cpuProducer?.cpuAffinity)) missing.push('cpu.cpu-affinity');
  if (cpuProducer?.testedRevision !== identity.testedRevision) missing.push('cpu.testedRevision');
  if (cpuProducer?.sourceRevision !== identity.sourceRevision) missing.push('cpu.sourceRevision');
  if (cpuProducer?.buildDigest !== identity.buildDigest) missing.push('cpu.buildDigest');
  if (cpuProducer?.backend !== 'wgpu-webgl2') missing.push('cpu.backend');
  if (cpuProducer?.timing?.source !== 'page-rAF' || cpuProducer?.timing?.unit !== 'ms/frame')
    missing.push('cpu.timing');
  if (!Number.isInteger(cpuProducer?.protocol?.warmupCount) || cpuProducer.protocol.warmupCount < 0)
    missing.push('cpu.warmupCount');
  if (cpuProducer?.protocol?.sampleCount !== sampleCount) missing.push('cpu.sampleCount');
  if (
    !validExactSamples(cpuProducer?.rawSamplesMs?.off, sampleCount) ||
    !validExactSamples(cpuProducer?.rawSamplesMs?.on, sampleCount)
  ) missing.push('cpu.rawSamplesMs');
  if (!validPassCounters(cpuProducer?.passCounters?.off, 0) || !validPassCounters(cpuProducer?.passCounters?.on, 1))
    missing.push('cpu.passCounters');
  if (
    cpuProducer?.resolution?.width !== 1920 ||
    cpuProducer?.resolution?.height !== 1080
  ) missing.push('cpu.resolution');
  return { missing, protocol, sampleCount, nativeTiming, nativeMeta, nativePass, cpuPass };
}

export function assemblePerformanceAdmissionEvidence(nativeSummary, cpuProducer, identity) {
  const { missing, protocol, sampleCount, nativeTiming, nativeMeta, nativePass, cpuPass } =
    performanceAdmissionMissingFacts(nativeSummary, cpuProducer, identity);
  if (missing.length > 0) return { evidence: undefined, reason: `performance-admission producer facts unavailable: ${missing.join(',')}` };
  const nativeRaw = { off: nativeTiming.offMs, on: nativeTiming.onMs };
  const cpuRaw = { off: cpuProducer.rawSamplesMs.off, on: cpuProducer.rawSamplesMs.on };
  const nativeDelta = pairDelta(nativeRaw.off, nativeRaw.on);
  const cpuOffMedian = quantile(cpuRaw.off, 0.5);
  const cpuOnMedian = quantile(cpuRaw.on, 0.5);
  const cpuRelative = cpuOffMedian > 0 ? (cpuOnMedian - cpuOffMedian) / cpuOffMedian : null;
  if (nativeDelta === null || cpuRelative === null) return { evidence: undefined, reason: 'performance-admission paired samples cannot be derived' };
  const nativeLane = {
    ...nativeMeta,
    testedRevision: identity.testedRevision,
    sourceRevision: identity.sourceRevision,
    buildDigest: identity.buildDigest,
    warmupCount: nativeTiming.warmupCount,
    resolution: nativeSummary.resolution,
    timing: { source: 'wall-time', unit: 'ms', gpuTimestamp: false },
    rawSamplesMs: nativeRaw,
    ...(nativePass === undefined ? {} : { rawPassSamplesMs: nativePass }),
    ...(nativePass === undefined
      ? {}
      : { passStatsMs: { producer: expectedStats(nativePass.producer), blur: expectedStats(nativePass.blur) } }),
    passCounters: nativeTiming.passCounters,
    deltaMs: nativeDelta,
  };
  const cpuLane = {
    testedRevision: identity.testedRevision,
    sourceRevision: identity.sourceRevision,
    buildDigest: identity.buildDigest,
    warmupCount: cpuProducer.protocol.warmupCount,
    runnerName: cpuProducer.runnerName,
    runnerClass: cpuProducer.runnerClass,
    runnerFacts: cpuProducer.runnerFacts,
    queue: cpuProducer.queue,
    execution: cpuProducer.execution,
    backend: cpuProducer.backend,
    adapter: cpuProducer.adapterId,
    capabilities: cpuProducer.capabilities,
    resolution: { width: 1920, height: 1080 },
    timing: cpuProducer.timing,
    rawSamplesMs: cpuRaw,
    ...(cpuPass === undefined ? {} : { rawPassSamplesMs: cpuPass }),
    ...(cpuPass === undefined
      ? {}
      : { passStatsMs: { producer: expectedStats(cpuPass.producer), blur: expectedStats(cpuPass.blur) } }),
    passCounters: cpuProducer.passCounters,
    cpuAffinity: cpuProducer.cpuAffinity,
    relativeMedian: cpuRelative,
  };
  const verdict = {
    native1080p:
      nativeDelta.median <= PERFORMANCE_ADMISSION_THRESHOLDS.native1080p.medianMs &&
      nativeDelta.p95 <= PERFORMANCE_ADMISSION_THRESHOLDS.native1080p.p95Ms
        ? 'pass'
        : 'fail',
    cpuWebgl2: cpuRelative <= PERFORMANCE_ADMISSION_THRESHOLDS.cpuWebgl2.relativeMedian ? 'pass' : 'fail',
  };
  return {
    evidence: {
      schemaVersion: PERFORMANCE_ADMISSION_SCHEMA_VERSION,
      lane: 'performance-admission',
      status: 'pass',
      testedRevision: identity.testedRevision,
      sourceRevision: identity.sourceRevision,
      buildDigest: identity.buildDigest,
      buildArtifact: nativeSummary.buildArtifact,
      protocol: { sampleCount: protocol.sampleCount, order: protocol.order },
      native1080p: nativeLane,
      cpuWebgl2: cpuLane,
      verdict: { ...verdict, overall: verdict.native1080p === 'pass' && verdict.cpuWebgl2 === 'pass' ? 'pass' : 'fail' },
    },
    reason: undefined,
  };
}

export function validatePerformanceAdmissionEvidence(evidence) {
  const errors = [];
  if (evidence?.schemaVersion !== PERFORMANCE_ADMISSION_SCHEMA_VERSION) errors.push('schemaVersion');
  if (evidence?.lane !== 'performance-admission') errors.push('lane');
  if (evidence?.status !== 'pass') errors.push('status');
  if (typeof evidence?.testedRevision !== 'string' || evidence.testedRevision.length === 0) errors.push('testedRevision');
  if (typeof evidence?.sourceRevision !== 'string' || evidence.sourceRevision.length === 0) errors.push('sourceRevision');
  if (typeof evidence?.buildDigest !== 'string' || evidence.buildDigest.length === 0) errors.push('buildDigest');
  if (!validBuildArtifact(evidence?.buildArtifact)) errors.push('buildArtifact');
  const protocol = evidence?.protocol;
  if (
    !Number.isInteger(protocol?.sampleCount) ||
    protocol.sampleCount < 10 ||
    !Array.isArray(protocol?.order) ||
    JSON.stringify(protocol.order) !== JSON.stringify(['off', 'on'])
  ) errors.push('protocol');
  const sampleCount = protocol?.sampleCount;
  for (const name of ['native1080p', 'cpuWebgl2']) {
    const lane = evidence?.[name];
    if (
      !validLabel(lane?.runnerClass) ||
      !validLabel(lane.queue) ||
      !validLabel(lane.execution) ||
      !validLabel(lane.backend) ||
      !validLabel(lane.adapter) ||
      !validRunnerProvenance(lane) ||
      !validCpuAffinity(lane?.cpuAffinity) ||
      !validLaneProvenance(name, lane) ||
      !Number.isInteger(lane?.warmupCount) ||
      lane.warmupCount < 0 ||
      lane.resolution?.width !== 1920 ||
      lane.resolution?.height !== 1080 ||
      lane.timing?.gpuTimestamp !== false
    )
      errors.push(`${name}.provenance`);
    if (
      lane?.testedRevision !== evidence.testedRevision ||
      lane?.sourceRevision !== evidence.sourceRevision ||
      lane?.buildDigest !== evidence.buildDigest
    )
      errors.push(`${name}.identity`);
    if (!validSamplePair(lane?.rawSamplesMs?.off, sampleCount) || !validSamplePair(lane?.rawSamplesMs?.on, sampleCount))
      errors.push(`${name}.rawSamplesMs`);
    if (!validPassCounters(lane?.passCounters?.off, 0) || !validPassCounters(lane?.passCounters?.on, 1))
      errors.push(`${name}.passCounters`);
    const passStats = lane?.passStatsMs;
    const hasRawPassTiming = lane?.rawPassSamplesMs !== undefined;
    if (hasRawPassTiming && lane?.timing?.gpuTimestamp !== true) errors.push(`${name}.rawPassTiming`);
    if (hasRawPassTiming && (
      !validSamplePair(lane.rawPassSamplesMs.producer, sampleCount) ||
      !validSamplePair(lane.rawPassSamplesMs.blur, sampleCount) ||
      !Number.isFinite(passStats?.producer?.median) ||
      !Number.isFinite(passStats?.producer?.p95) ||
      !Number.isFinite(passStats?.blur?.median) ||
      !Number.isFinite(passStats?.blur?.p95)
    )) errors.push(`${name}.rawPassSamplesMs`);
    if (
      hasRawPassTiming &&
      validSamplePair(lane?.rawPassSamplesMs?.producer, sampleCount) &&
      validSamplePair(lane?.rawPassSamplesMs?.blur, sampleCount) &&
      validSamplePair(lane?.rawSamplesMs?.on, sampleCount)
    ) {
      const expectedProducer = expectedStats(lane.rawPassSamplesMs.producer);
      const expectedBlur = expectedStats(lane.rawPassSamplesMs.blur);
      if (
        !Number.isFinite(passStats?.producer?.median) ||
        Math.abs(expectedProducer.median - passStats.producer.median) > 1e-9 ||
        Math.abs(expectedProducer.p95 - passStats.producer.p95) > 1e-9 ||
        Math.abs(expectedBlur.median - passStats.blur.median) > 1e-9 ||
        Math.abs(expectedBlur.p95 - passStats.blur.p95) > 1e-9
      ) errors.push(`${name}.passStatsMismatch`);
      if (lane.rawPassSamplesMs.producer.some((value, index) => value + lane.rawPassSamplesMs.blur[index] > lane.rawSamplesMs.on[index]))
        errors.push(`${name}.passStatsRelation`);
    }
    if (
      validSamplePair(lane?.rawSamplesMs?.off, sampleCount) &&
      validSamplePair(lane?.rawSamplesMs?.on, sampleCount) &&
      pairDelta(lane.rawSamplesMs.off, lane.rawSamplesMs.on) === null
    )
      errors.push(`${name}.pairedSamples`);
  }
  const nativeLane = evidence?.native1080p;
  const cpuLane = evidence?.cpuWebgl2;
  const nativeDelta = evidence?.native1080p?.deltaMs;
  const cpuDelta = evidence?.cpuWebgl2?.relativeMedian;
  if (!Number.isFinite(nativeDelta?.median) || !Number.isFinite(nativeDelta?.p95)) errors.push('native1080p.deltaMs');
  if (!Number.isFinite(cpuDelta)) errors.push('cpuWebgl2.relativeMedian');
  const nativeSamples = evidence?.native1080p?.rawSamplesMs;
  if (validSamplePair(nativeSamples?.off, sampleCount) && validSamplePair(nativeSamples?.on, sampleCount)) {
    const expected = pairDelta(nativeSamples.off, nativeSamples.on);
    if (
      expected === null ||
      Math.abs(expected.median - nativeDelta.median) > 1e-9 ||
      Math.abs(expected.p95 - nativeDelta.p95) > 1e-9
    )
      errors.push('native1080p.deltaMismatch');
  }
  const cpuSamples = evidence?.cpuWebgl2?.rawSamplesMs;
  if (validSamplePair(cpuSamples?.off, sampleCount) && validSamplePair(cpuSamples?.on, sampleCount)) {
    const offMedian = quantile(cpuSamples.off, 0.5);
    const onMedian = quantile(cpuSamples.on, 0.5);
    const expected = offMedian > 0 ? (onMedian - offMedian) / offMedian : null;
    if (expected === null || Math.abs(expected - cpuDelta) > 1e-9) errors.push('cpuWebgl2.deltaMismatch');
  }
  if (Number.isFinite(nativeDelta?.median) && nativeDelta.median > PERFORMANCE_ADMISSION_THRESHOLDS.native1080p.medianMs)
    errors.push('native1080p.medianThreshold');
  if (Number.isFinite(nativeDelta?.p95) && nativeDelta.p95 > PERFORMANCE_ADMISSION_THRESHOLDS.native1080p.p95Ms)
    errors.push('native1080p.p95Threshold');
  if (Number.isFinite(cpuDelta) && cpuDelta > PERFORMANCE_ADMISSION_THRESHOLDS.cpuWebgl2.relativeMedian)
    errors.push('cpuWebgl2.threshold');
  const computedVerdict = {
    native1080p:
      Number.isFinite(nativeDelta?.median) &&
      Number.isFinite(nativeDelta?.p95) &&
      nativeDelta.median <= PERFORMANCE_ADMISSION_THRESHOLDS.native1080p.medianMs &&
      nativeDelta.p95 <= PERFORMANCE_ADMISSION_THRESHOLDS.native1080p.p95Ms
        ? 'pass'
        : 'fail',
    cpuWebgl2: Number.isFinite(cpuDelta) && cpuDelta <= PERFORMANCE_ADMISSION_THRESHOLDS.cpuWebgl2.relativeMedian ? 'pass' : 'fail',
  };
  computedVerdict.overall = computedVerdict.native1080p === 'pass' && computedVerdict.cpuWebgl2 === 'pass' ? 'pass' : 'fail';
  if (evidence?.verdict?.native1080p !== computedVerdict.native1080p) errors.push('verdict.native1080p');
  if (evidence?.verdict?.cpuWebgl2 !== computedVerdict.cpuWebgl2) errors.push('verdict.cpuWebgl2');
  if (evidence?.verdict?.overall !== computedVerdict.overall) errors.push('verdict.overall');
  return { ok: errors.length === 0, errors };
}

export function performanceAdmissionUnavailable(reason) {
  return {
    schemaVersion: PERFORMANCE_ADMISSION_SCHEMA_VERSION,
    lane: 'performance-admission',
    status: 'unavailable',
    acceptance: 'fail-closed',
    exitPolicy: 'fail-closed',
    runner: { class: 'unknown', queue: 'unknown', execution: 'wall-time' },
    backend: 'unavailable',
    gpuTimestamp: false,
    reason,
    thresholds: PERFORMANCE_ADMISSION_THRESHOLDS,
  };
}
