import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { expectedNativeBackend, verifyReport } from '../scripts/verify-report.mjs';

const frame = {
  width: 32,
  height: 32,
  nonBlackPixelCount: 128,
  triangleVisible: true,
  barycentricVariation: true,
  centerPixel: [80, 90, 85, 255],
  cornerPixel: [0, 0, 0, 255],
};

function report(overrides = {}, backend = 'Vulkan') {
  return {
    schemaVersion: 2,
    verdict: 'ok',
    mode: 'packaged-tauri-smoke',
    wgpuVersion: '30.0.1',
    tauriVersion: '2.11.5',
    rustVersion: 'rustc 1.93.0',
    executable: '/fixture/app',
    capabilities: {
      backend,
      rayQuery: true,
      adapter: {
        name: 'fixture',
        vendor: 4318,
        device: 1,
        deviceType: 'DiscreteGpu',
        driver: 'fixture',
        driverInfo: 'fixture',
      },
    },
    scene: { blasCount: 1, tlasInstanceCount: 1, triangleCount: 1 },
    positive: frame,
    resized: { ...frame, width: 384, height: 320 },
    restored: frame,
    emptyTlas: {
      ...frame,
      nonBlackPixelCount: 0,
      triangleVisible: false,
      barycentricVariation: false,
      centerPixel: [0, 0, 0, 255],
    },
    emptyTlasVerdict: 'triangle-not-visible',
    coreCases: ['CREATE-01', 'RQ-01', 'TLAS-06', 'STAB-03', 'STAB-04'].map((id) => ({
      id,
      status: 'pass',
      detail: 'fixture passed',
    })),
    error: null,
    ...overrides,
  };
}

function writeFixture(payload, includeFrames = false) {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-ray-query-report-'));
  const path = resolve(directory, 'report.json');
  writeFileSync(path, JSON.stringify(payload));
  if (includeFrames) {
    for (const name of ['frame.png', 'frame-resized.png', 'frame-restored.png']) {
      writeFileSync(resolve(directory, name), 'fixture');
    }
  }
  return path;
}

test('accepts a strict hardware report', () => {
  const path = writeFixture(report(), true);
  assert.equal(verifyReport(path, { expectedBackend: 'Vulkan' }).verdict, 'ok');
});

test('accepts the same proof on Metal', () => {
  const path = writeFixture(report({}, 'Metal'), true);
  assert.equal(verifyReport(path, { expectedBackend: 'Metal' }).verdict, 'ok');
});

test('requires DX12 for the Windows hardware proof', () => {
  const expectedBackend = expectedNativeBackend('win32');
  const path = writeFixture(report({}, 'Dx12'), true);
  assert.equal(verifyReport(path, { expectedBackend }).verdict, 'ok');
  assert.throws(() => verifyReport(writeFixture(report(), true), { expectedBackend }));
});

test('derives the required backend from the host platform', () => {
  assert.equal(expectedNativeBackend('darwin'), 'Metal');
  assert.equal(expectedNativeBackend('linux'), 'Vulkan');
  assert.equal(expectedNativeBackend('win32'), 'Dx12');
  assert.throws(() => expectedNativeBackend('freebsd'));
});

test('rejects an ok report without Ray Query', () => {
  const invalid = report({ capabilities: { ...report().capabilities, rayQuery: false } });
  assert.throws(() =>
    verifyReport(writeFixture(invalid, true), { expectedBackend: 'Vulkan' }),
  );
});

test('accepts only the bounded unsupported contract', () => {
  const unsupported = report({
    verdict: 'unsupported',
    capabilities: null,
    positive: null,
    resized: null,
    restored: null,
    emptyTlas: null,
    emptyTlasVerdict: null,
    coreCases: [],
    error: { code: 'native-backend-unavailable', detail: 'fixture' },
  });
  assert.equal(
    verifyReport(writeFixture(unsupported), { allowUnsupported: true }).verdict,
    'unsupported',
  );
  assert.throws(() => verifyReport(writeFixture(unsupported)));
});
