import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBrowserFeatureObservation,
  createDawnFeatureObservation,
} from '../feature-evidence-producer.mjs';
import { validateFeatureEvidenceBundle } from '../validate-feature-evidence.mjs';

const hash = (letter) => letter.repeat(64);
const fixtureIdentity = {
  asset: { id: 'asset-v1', sha256: hash('a') },
  camera: { id: 'camera-v1', sha256: hash('b') },
  light: { id: 'light-v1', sha256: hash('c') },
  input: { id: 'input-v1', sha256: hash('d') },
};

function input(kind, backend = 'dawn-node') {
  const isAuto = kind === 'auto';
  const isLut = kind === 'positive-lut';
  const stages = kind === 'manual'
    ? []
    : ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
        id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
        domain,
        readback: { rawHash: hash(String(index + (isAuto ? 1 : 4))), frame: 60 },
        metadata: {
          frameId: 60,
          deviceGeneration: 1,
          graphGeneration: 2,
          textureIdentity: index + (isAuto ? 1 : 10),
          readbackIdentity: index + (isAuto ? 20 : 30),
          width: 200,
          height: 150,
          bytesPerRow: index < 2 ? 1600 : 800,
        },
      }));
  const workload = {
    kind,
    executed: true,
    exposureMode: isAuto ? 'auto' : 'manual',
    strength: isLut ? 0.75 : 0,
    generation: isAuto || isLut ? 2 : 0,
    sourceKey: isLut ? 'auto-exposure-positive-lut' : undefined,
    receipt: isAuto || isLut ? { committed: true, frameId: 60 } : undefined,
  };
  const state = {
    backend,
    workload: {
      kind,
      executed: true,
      exposureMode: workload.exposureMode,
      colorLutStrength: workload.strength,
      sourceKey: workload.sourceKey,
      autoExposure: isAuto ? { targetGeneration: 2, receipt: { committed: true, frameId: 60 } } : undefined,
      lutReceipt: isLut ? { generation: 2, committed: true, frameId: 60 } : undefined,
    },
  };
  return {
    workloadKind: kind,
    state,
    frames: 60,
    frameIdentity: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('e') },
    stages,
    fixtureIdentity: structuredClone(fixtureIdentity),
    source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('f') },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('0') },
    resolution: { width: 200, height: 150 },
    provenance: {
      source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('f') },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('0') },
      fixture: 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json',
      frame: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('e') },
      backend,
      adapter: backend === 'browser-webgpu'
        ? { physicalGpu: true, fallbackAdapter: false, vendorId: 1, deviceId: 2, vendor: 'Apple', device: 'M4 Pro', architecture: 'metal-3', description: 'Apple M4 Pro GPU' }
        : { physicalGpu: false, fallbackAdapter: false },
      runner: backend === 'browser-webgpu'
        ? { kind: 'playwright', id: 'chrome', channel: 'chrome', version: '152.0.0.0', headless: true, launchArgs: ['--headless'] }
        : { kind: 'dawn', id: 'smoke-dawn' },
    },
    resourceGrowth: isAuto || isLut
      ? { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 3, peakLiveCount: 3, mapCount: 3, readbackCount: 3 }
      : { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 0, peakLiveCount: 0, mapCount: 0, readbackCount: 0 },
  };
}

function bundle(backend = 'dawn-node') {
  const producer = backend === 'browser-webgpu' ? createBrowserFeatureObservation : createDawnFeatureObservation;
  return {
    schemaVersion: 'hello-taa-auto-exposure-evidence-bundle/1',
    featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
    backend,
    testedRevision: 'a'.repeat(40),
    workloads: Object.fromEntries(
      ['manual', 'auto', 'positive-lut'].map((kind) => [kind, { report: producer(input(kind, backend)) }]),
    ),
  };
}

test('bundle validator derives a pass from three independent workload observations', () => {
  const result = validateFeatureEvidenceBundle(bundle());
  assert.equal(result.status, 'pass');
  assert.equal(result.verdictSource, 'validator');
});

test('bundle validator blocks missing workload and fails observed resource drift', () => {
  const missing = bundle();
  delete missing.workloads['positive-lut'];
  assert.equal(validateFeatureEvidenceBundle(missing).status, 'blocked');

  const invalid = bundle();
  invalid.workloads.manual.report.resourceGrowth.allocationCount = 1;
  const result = validateFeatureEvidenceBundle(invalid);
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some((entry) => entry.code === 'workload-manual-resource-count-invalid'));
});

test('Browser bundle keeps the physical adapter and launch provenance gate', () => {
  const invalid = bundle('browser-webgpu');
  invalid.workloads.auto.report.provenance.adapter.physicalGpu = false;
  const result = validateFeatureEvidenceBundle(invalid);
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some((entry) => entry.code === 'workload-auto-physical-provenance-invalid'));
});

test('Browser software simulation is admitted only with explicit mode and adapter identity', () => {
  const simulated = bundle('browser-webgpu');
  for (const kind of ['manual', 'auto', 'positive-lut']) {
    const report = simulated.workloads[kind].report;
    report.executionMode = 'simulated';
    report.provenance.adapter = {
      physicalGpu: false,
      fallbackAdapter: false,
      vendorId: 0,
      deviceId: 0,
      vendor: 'Mesa',
      device: 'llvmpipe',
      architecture: 'software',
      description: 'llvmpipe software Vulkan adapter',
    };
  }
  const result = validateFeatureEvidenceBundle(simulated);
  assert.equal(result.status, 'pass');
  assert.equal(result.verdictSource, 'validator');
});

test('A simulated capability-blocked observation stays blocked without synthetic errors', () => {
  const blocked = bundle('browser-webgpu');
  for (const kind of ['manual', 'auto', 'positive-lut']) {
    const report = blocked.workloads[kind].report;
    report.executionMode = 'simulated';
    report.provenance.adapter = {
      physicalGpu: false,
      fallbackAdapter: true,
      vendor: 'Mesa',
      device: 'llvmpipe',
      architecture: 'software',
      description: 'Lavapipe software adapter',
    };
  }
  for (const kind of ['auto', 'positive-lut']) {
    blocked.workloads[kind].report.status = 'blocked';
  }
  const result = validateFeatureEvidenceBundle(blocked);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.errors, []);
});

test('Browser software capability blocks remain blocked and retain observation-only errors', () => {
  const blocked = bundle('browser-webgpu');
  for (const kind of ['auto', 'positive-lut']) {
    const report = blocked.workloads[kind].report;
    report.status = 'blocked';
    report.provenance.adapter.physicalGpu = false;
    report.provenance.adapter.fallbackAdapter = true;
    report.provenance.adapter.isFallbackAdapter = true;
    report.provenance.adapter.vendor = 'Google Inc.';
    report.provenance.adapter.device = 'llvmpipe';
    report.provenance.adapter.architecture = 'swiftshader';
    report.provenance.adapter.description = 'SwiftShader software adapter';
    report.provenance.runner.channel = 'chrome-beta';
    report.provenance.runner.version = '152.0.0.0';
  }
  const result = validateFeatureEvidenceBundle(blocked);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.every((entry) => /(?:physical|runner)-provenance-invalid$/.test(entry.code)));
  assert.ok(!result.errors.some((entry) => entry.code.endsWith('producer-verdict-invalid')));
});

test('Malformed capability provenance remains failed rather than becoming blocked', () => {
  const malformed = bundle('browser-webgpu');
  for (const kind of ['auto', 'positive-lut']) {
    const report = malformed.workloads[kind].report;
    report.status = 'blocked';
    report.provenance.adapter.physicalGpu = false;
    report.provenance.adapter.fallbackAdapter = true;
    report.provenance.adapter.isFallbackAdapter = true;
    delete report.provenance.adapter.vendorId;
    report.resourceGrowth.allocationCount = 99;
  }
  const result = validateFeatureEvidenceBundle(malformed);
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some((entry) => entry.code.endsWith('physical-provenance-invalid')));
  assert.ok(result.errors.some((entry) => entry.code.endsWith('resource-count-invalid')));
});
