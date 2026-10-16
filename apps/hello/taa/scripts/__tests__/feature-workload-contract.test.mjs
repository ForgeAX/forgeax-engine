import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY } from '@forgeax/apps-shared/auto-exposure-fixture';
import { createBrowserFeatureObservation, createDawnFeatureObservation } from '../feature-evidence-producer.mjs';

const autoResourceGrowth = { stableFrames: 300, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 3, peakLiveCount: 3, mapCount: 3, readbackCount: 3 };
const manualResourceGrowth = { stableFrames: 300, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 0, peakLiveCount: 0, mapCount: 0, readbackCount: 0 };

const workloadPath = fileURLToPath(new URL('../../fixtures/auto-exposure/workloads.json', import.meta.url));
const scenePath = fileURLToPath(new URL('../../fixtures/auto-exposure/scene-identity.json', import.meta.url));

test('declares independent manual, auto, and positive LUT workloads', () => {
  const workload = JSON.parse(readFileSync(workloadPath, 'utf8'));
  const scene = JSON.parse(readFileSync(scenePath, 'utf8'));
  assert.equal(workload.schemaVersion, 'hello-taa-auto-exposure-workloads/1');
  assert.deepEqual(workload.evidencePolicy, {
    kind: 'declarative-workload-definition',
    rawEvidence: false,
    identitySource: 'each Browser/Dawn producer must derive source, build, and testedRevision from its current exact checkout',
  });
  assert.equal('source' in workload, false);
  assert.equal('build' in workload, false);
  assert.equal('testedRevision' in workload, false);
  assert.deepEqual(workload.workloads.map((entry) => entry.kind), ['manual', 'auto', 'positive-lut']);
  assert.equal(workload.workloads[0].executed, true);
  assert.equal(workload.workloads[0].strength, 0);
  assert.equal(workload.workloads[1].executed, true);
  assert.equal(workload.workloads[1].generation > 0, true);
  assert.equal(workload.workloads[2].executed, true);
  assert.equal(workload.workloads[2].strength > 0, true);
  assert.equal(workload.workloads[2].generation > 0, true);
  assert.equal(typeof workload.workloads[2].sourceKey, 'string');
  assert.ok(workload.workloads[2].sourceKey.length > 0);
  assert.deepEqual(Object.keys(scene), ['asset', 'camera', 'light', 'input']);
  assert.deepEqual(scene, AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY);
  for (const identity of Object.values(scene)) {
    assert.equal(typeof identity.id, 'string');
    assert.equal(identity.id.length > 0, true);
    assert.match(identity.sha256, /^[a-f0-9]{64}$/);
  }
});

test('does not collapse positive LUT and auto observations into one identity', () => {
  const workload = JSON.parse(readFileSync(workloadPath, 'utf8'));
  const [manual, auto, positiveLut] = workload.workloads;
  assert.notEqual(auto.observationId, positiveLut.observationId);
  assert.notEqual(manual.observationId, auto.observationId);
  assert.notEqual(auto.captureSha256, positiveLut.captureSha256);
});

test('feature producer rejects a non-contiguous or incomplete three-domain window', () => {
  const metadata = (frame, textureIdentity, readbackIdentity) => ({
    frameId: frame,
    deviceGeneration: 1,
    graphGeneration: 2,
    textureIdentity,
    readbackIdentity,
    width: 1920,
    height: 1080,
    bytesPerRow: 7680,
    footprint: { resourceCount: 8, bindGroupCount: 4 },
  });
  const report = createBrowserFeatureObservation({
    workloadKind: 'auto',
    state: { workload: { kind: 'auto', executed: true, exposureMode: 'auto', autoExposure: { targetGeneration: 2, receipt: { committed: true } } } },
    frames: 300,
    frameIdentity: { first: 1, last: 300, count: 300, contiguous: false, sequenceSha256: 'd'.repeat(64) },
    stages: ['wrong', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: domain,
      domain,
      readback: { rawHash: String.fromCharCode(97 + index).repeat(64), frame: 300 },
      metadata: metadata(300, index + 1, index + 11),
    })),
    fixtureIdentity: { asset: { id: 'asset' }, camera: { id: 'camera' }, light: { id: 'light' }, input: { id: 'input' } },
    provenance: { source: {}, build: {}, fixture: {}, frame: {}, backend: 'browser-webgpu', adapter: {}, runner: {} },
    resourceGrowth: autoResourceGrowth,
  });
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'frame-identity-invalid'));
  assert.ok(report.errors.some((entry) => entry.code === 'domain-set-invalid'));
});

test('feature producer rejects payload-only zero growth when renderer allocations repeat', () => {
  const report = createBrowserFeatureObservation({
    workloadKind: 'auto',
    state: { workload: { kind: 'auto', executed: true, exposureMode: 'auto', autoExposure: { targetGeneration: 2, receipt: { committed: true } } } },
    frames: 300,
    frameIdentity: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'd'.repeat(64) },
    stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: String.fromCharCode(97 + index).repeat(64), frame: 300 },
      metadata: {
        frameId: 300,
        deviceGeneration: 1,
        graphGeneration: 2,
        textureIdentity: index + 1,
        readbackIdentity: index + 11,
        width: 1920,
        height: 1080,
        bytesPerRow: index < 2 ? 15360 : 7680,
      },
    })),
    fixtureIdentity: {
      asset: { id: 'asset', sha256: 'a'.repeat(64) },
      camera: { id: 'camera', sha256: 'b'.repeat(64) },
      light: { id: 'light', sha256: 'c'.repeat(64) },
      input: { id: 'input', sha256: 'd'.repeat(64) },
    },
    provenance: {
      source: { path: 'src/main.ts', sha256: 'e'.repeat(64) },
      build: { path: 'dist/index.html', sha256: 'f'.repeat(64) },
      fixture: 'fixture.json',
      frame: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'd'.repeat(64) },
      backend: 'browser-webgpu',
      adapter: {
        physicalGpu: true,
        fallbackAdapter: false,
        vendorId: 1,
        deviceId: 2,
        vendor: 'Apple',
        device: 'M4 Pro',
        architecture: 'metal-3',
        description: 'Apple M4 Pro GPU',
      },
      runner: {
        kind: 'playwright',
        id: 'chrome',
        channel: 'chrome',
        version: '140.0.0.0',
        headless: true,
        launchArgs: ['--headless'],
      },
    },
    source: { path: 'src/main.ts', sha256: 'e'.repeat(64) },
    build: { path: 'dist/index.html', sha256: 'f'.repeat(64) },
    resolution: { width: 1920, height: 1080 },
    resourceGrowth: { ...autoResourceGrowth, allocationCount: 301, mapCount: 301, readbackCount: 301 },
  });
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'observation-resource-count'));
});

test('feature producer rejects incomplete nested provenance instead of accepting shape-only identity', () => {
  const report = createBrowserFeatureObservation({
    workloadKind: 'auto',
    state: { workload: { kind: 'auto', executed: true, exposureMode: 'auto', autoExposure: { targetGeneration: 2, receipt: { committed: true } } } },
    frames: 300,
    frameIdentity: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'd'.repeat(64) },
    fixtureIdentity: { asset: { id: 'asset' }, camera: { id: 'camera' }, light: { id: 'light' }, input: { id: 'input' } },
    provenance: { source: {}, build: {}, fixture: {}, frame: { first: 1, last: 300, count: 300, contiguous: true }, backend: 'browser-webgpu', adapter: {}, runner: { kind: 'playwright', id: 'chrome' } },
    source: {},
    build: {},
    resolution: { width: 1920, height: 1080 },
    resourceGrowth: autoResourceGrowth,
  });
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'fixture-identity-invalid' && entry.path === 'fixtureIdentity.asset'));
  assert.ok(report.errors.some((entry) => entry.code === 'provenance-identity-invalid' && entry.path === 'provenance.source'));
  assert.ok(report.errors.some((entry) => entry.code === 'source-identity-invalid' && entry.path === 'source'));
});

test('feature producer rejects cross-graph or incorrectly paired domain captures', () => {
  const domains = ['linear-HDR', 'linear-LDR', 'final-sRGB'];
  const identity = (id) => ({ id, sha256: 'a'.repeat(64) });
  const stages = domains.map((domain, index) => ({
    id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
    domain,
    readback: { rawHash: String.fromCharCode(98 + index).repeat(64), frame: 300 },
    metadata: {
      frameId: 300,
      deviceGeneration: 1,
      graphGeneration: index === 1 ? 3 : 2,
      textureIdentity: index + 1,
      readbackIdentity: index + 11,
      width: 1920,
      height: 1080,
      bytesPerRow: 7680,
      footprint: { resourceCount: 8, bindGroupCount: 4 },
    },
  }));
  stages[2].id = 'linear-ldr';
  // Linear captures are rgba16float while final-sRGB is rgba8; their row
  // strides differ without violating the shared frame/graph/extent identity.
  stages[0].metadata.bytesPerRow = 15360;
  stages[1].metadata.bytesPerRow = 15360;
  const report = createBrowserFeatureObservation({
    workloadKind: 'auto',
    state: { workload: { kind: 'auto', executed: true, exposureMode: 'auto', autoExposure: { targetGeneration: 2, receipt: { committed: true } } } },
    frames: 300,
    frameIdentity: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'c'.repeat(64) },
    stages,
    fixtureIdentity: { asset: identity('asset'), camera: identity('camera'), light: identity('light'), input: identity('input') },
    provenance: {
      source: { path: 'src/main.ts', sha256: 'd'.repeat(64) },
      build: { path: 'dist/index.html', sha256: 'e'.repeat(64) },
      fixture: 'fixture.json',
      frame: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'c'.repeat(64) },
      backend: 'browser-webgpu',
      adapter: { physicalGpu: true },
      runner: { kind: 'playwright', id: 'chrome' },
    },
    source: { path: 'src/main.ts', sha256: 'd'.repeat(64) },
    build: { path: 'dist/index.html', sha256: 'e'.repeat(64) },
    resolution: { width: 1920, height: 1080 },
    resourceGrowth: autoResourceGrowth,
  });
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'domain-pairing-invalid' && entry.path === 'stages[2]'));
  assert.ok(report.errors.some((entry) => entry.code === 'domain-metadata-mismatch' && entry.path === 'stages.*.metadata.graphGeneration'));
  assert.equal(report.errors.some((entry) => entry.code === 'domain-metadata-mismatch' && entry.path === 'stages.*.metadata.bytesPerRow'), false);
});

test('feature producer rejects shape-only and software Browser adapter provenance', () => {
  const base = {
    workloadKind: 'auto',
    state: { workload: { kind: 'auto', executed: true, exposureMode: 'auto', autoExposure: { targetGeneration: 2, receipt: { committed: true } } } },
    frames: 300,
    frameIdentity: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'c'.repeat(64) },
    stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: String.fromCharCode(98 + index).repeat(64), frame: 300 },
      metadata: {
        frameId: 300,
        deviceGeneration: 1,
        graphGeneration: 2,
        textureIdentity: index + 1,
        readbackIdentity: index + 11,
        width: 1920,
        height: 1080,
        bytesPerRow: index < 2 ? 15360 : 7680,
      },
    })),
    fixtureIdentity: { asset: { id: 'asset', sha256: 'a'.repeat(64) }, camera: { id: 'camera', sha256: 'b'.repeat(64) }, light: { id: 'light', sha256: 'c'.repeat(64) }, input: { id: 'input', sha256: 'd'.repeat(64) } },
    source: { path: 'src/main.ts', sha256: 'd'.repeat(64) },
    build: { path: 'dist/index.html', sha256: 'e'.repeat(64) },
    resolution: { width: 1920, height: 1080 },
    resourceGrowth: autoResourceGrowth,
  };
  const shapeOnly = createBrowserFeatureObservation({
    ...base,
    provenance: {
      source: base.source,
      build: base.build,
      fixture: 'fixture.json',
      frame: base.frameIdentity,
      backend: 'browser-webgpu',
      adapter: { physicalGpu: true },
      runner: { kind: 'playwright', id: 'chrome' },
    },
  });
  assert.equal(shapeOnly.status, 'blocked');
  assert.ok(shapeOnly.errors.some((entry) => entry.code === 'physical-adapter-provenance-invalid'));
  assert.ok(shapeOnly.errors.some((entry) => entry.code === 'launch-provenance-invalid'));

  const software = createBrowserFeatureObservation({
    ...base,
    provenance: {
      source: base.source,
      build: base.build,
      fixture: 'fixture.json',
      frame: base.frameIdentity,
      backend: 'browser-webgpu',
      adapter: {
        physicalGpu: true,
        fallbackAdapter: false,
        vendorId: 1,
        deviceId: 2,
        vendor: 'SwiftShader Inc.',
        device: 'SwiftShader Device',
        architecture: 'software',
        description: 'SwiftShader Vulkan',
      },
      runner: {
        kind: 'playwright',
        id: 'chrome',
        channel: 'chrome',
        version: '1.0.0',
        headless: true,
        launchArgs: ['--use-vulkan=swiftshader'],
      },
    },
  });
  assert.equal(software.status, 'blocked');
  assert.ok(software.errors.some((entry) => entry.code === 'physical-adapter-provenance-invalid'));
  assert.ok(software.errors.some((entry) => entry.code === 'launch-provenance-invalid'));
});

test('Dawn raw observations keep adapter provenance without borrowing the Browser physical gate', () => {
  const base = {
    workloadKind: 'auto',
    state: { workload: { kind: 'auto', executed: true, exposureMode: 'auto', autoExposure: { targetGeneration: 2, receipt: { committed: true } } } },
    frames: 300,
    frameIdentity: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'c'.repeat(64) },
    stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: String.fromCharCode(98 + index).repeat(64), frame: 300 },
      metadata: {
        frameId: 300,
        deviceGeneration: 1,
        graphGeneration: 2,
        textureIdentity: index + 1,
        readbackIdentity: index + 11,
        width: 200,
        height: 150,
        bytesPerRow: index < 2 ? 1600 : 800,
      },
    })),
    fixtureIdentity: { asset: { id: 'asset', sha256: 'a'.repeat(64) }, camera: { id: 'camera', sha256: 'b'.repeat(64) }, light: { id: 'light', sha256: 'c'.repeat(64) }, input: { id: 'input', sha256: 'd'.repeat(64) } },
    source: { path: 'src/main.ts', sha256: 'd'.repeat(64) },
    build: { path: 'dist/index.html', sha256: 'e'.repeat(64) },
    resolution: { width: 200, height: 150 },
    provenance: {
      source: { path: 'src/main.ts', sha256: 'd'.repeat(64) },
      build: { path: 'dist/index.html', sha256: 'e'.repeat(64) },
      fixture: 'fixture.json',
      frame: { first: 1, last: 300, count: 300, contiguous: true, sequenceSha256: 'c'.repeat(64) },
      backend: 'dawn-node',
      adapter: { physicalGpu: false, fallbackAdapter: false },
      runner: { kind: 'dawn', id: 'smoke-dawn' },
    },
    resourceGrowth: autoResourceGrowth,
  };
  const report = createDawnFeatureObservation(base);
  assert.equal(report.status, 'observation');
  assert.deepEqual(report.errors, []);
});
