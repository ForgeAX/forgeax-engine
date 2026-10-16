import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKLOAD_KINDS, createBrowserFeatureObservation, createDawnFeatureObservation } from '../feature-evidence-producer.mjs';

const hash = (letter) => letter.repeat(64);
const revision = 'a'.repeat(40);
const fixtureIdentity = {
  asset: { id: 'asset-v1', sha256: hash('d') },
  camera: { id: 'camera-v1', sha256: hash('e') },
  light: { id: 'light-v1', sha256: hash('f') },
  input: { id: 'input-v1', sha256: hash('0') },
};

function rawInput(workloadKind) {
  const auto = workloadKind === 'auto';
  const lut = workloadKind === 'positive-lut';
  const stages = workloadKind === 'manual'
    ? []
    : ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: hash(String(index + 1)), frame: 60 },
      metadata: {
        frameId: 60,
        deviceGeneration: 1,
        graphGeneration: 2,
        textureIdentity: index + 1,
        readbackIdentity: index + 11,
        width: 200,
        height: 150,
        bytesPerRow: index < 2 ? 1600 : 800,
      },
    }));
  return {
    workloadKind,
    state: {
      backend: 'dawn-node',
      workload: {
        kind: workloadKind,
        executed: true,
        exposureMode: auto ? 'auto' : 'manual',
        colorLutStrength: lut ? 0.75 : 0,
        sourceKey: lut ? 'auto-exposure-positive-lut' : undefined,
        autoExposure: auto ? { targetGeneration: 2, receipt: { committed: true } } : undefined,
        lutReceipt: lut ? { generation: 2, committed: true } : undefined,
      },
    },
    frames: 60,
    frameIdentity: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('9') },
    stages,
    fixtureIdentity: structuredClone(fixtureIdentity),
    source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') },
    resolution: { width: 200, height: 150 },
    provenance: {
      source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') },
      fixture: 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json',
      frame: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('9') },
      backend: 'dawn-node',
      adapter: { physicalGpu: false, fallbackAdapter: false },
      runner: { kind: 'dawn', id: 'smoke-dawn' },
    },
    resourceGrowth: lut || auto
      ? { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 3, peakLiveCount: 3, mapCount: 3, readbackCount: 3 }
      : { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 0, peakLiveCount: 0, mapCount: 0, readbackCount: 0 },
  };
}

function browserInput(workloadKind) {
  const input = rawInput(workloadKind);
  input.backend = 'browser-webgpu';
  input.state.backend = 'browser-webgpu';
  input.provenance.backend = 'browser-webgpu';
  input.provenance.adapter = {
    physicalGpu: true,
    fallbackAdapter: false,
    vendorId: 1,
    deviceId: 2,
    vendor: 'Apple',
    device: 'M4 Pro',
    architecture: 'metal-3',
    description: 'Apple M4 Pro GPU',
  };
  input.provenance.runner = {
    kind: 'playwright',
    id: 'chrome',
    channel: 'chrome',
    version: '152.0.0.0',
    headless: true,
    launchArgs: ['--headless'],
  };
  return input;
}

test('Browser and Dawn each emit workload-local raw observations without borrowing ownership', () => {
  for (const workloadKind of WORKLOAD_KINDS) {
    const browser = createBrowserFeatureObservation(browserInput(workloadKind));
    const dawn = createDawnFeatureObservation(rawInput(workloadKind));
    assert.equal(browser.status, 'observation');
    assert.equal(dawn.status, 'observation');
    assert.equal(browser.workloads[0].kind, workloadKind);
    assert.equal(dawn.workloads[0].kind, workloadKind);
    assert.notEqual(browser.provenance.backend, dawn.provenance.backend);
  }
});

test('generation zero and missing receipt never become a feature observation', () => {
  const auto = rawInput('auto');
  auto.state.workload.autoExposure.targetGeneration = 0;
  auto.state.workload.autoExposure.receipt = undefined;
  const report = createDawnFeatureObservation(auto);
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'exposure-generation-missing'));
  assert.ok(report.errors.some((entry) => entry.code === 'exposure-receipt-missing'));
});

test('manual/LUT0 remains a zero-cost control and cannot become a feature pass', () => {
  const report = createDawnFeatureObservation(rawInput('manual'));
  assert.equal(report.status, 'observation');
  assert.equal(report.workloads[0].generation, 0);
  assert.equal(report.workloads[0].strength, 0);
  assert.equal(report.resourceGrowth.allocationCount, 0);
  assert.equal(report.resourceGrowth.readbackCount, 0);
});
