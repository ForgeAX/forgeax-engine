import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { verifyConformanceReport } from '../verify-conformance-report.mjs';

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-conformance-report-'));
  mkdirSync(resolve(directory, 'frames'));
  mkdirSync(resolve(directory, 'benchmarks'));
  const cases = Array.from({ length: 54 }, (_, index) => ({
    id: `FIXTURE-${String(index + 1).padStart(2, '0')}`,
    name: 'fixture',
    profile: 'core',
    stage: 'query',
    status: 'pass',
    durationMs: 0,
    detail: 'fixture passed',
    observations: {},
  }));
  const report = {
    schemaVersion: 1,
    runId: 'fixture-run',
    startedAtUnixMs: 0,
    durationMs: 1,
    requestedProfiles: ['core'],
    environment: {
      wgpuVersion: '30.0.1',
      wgpuTag: 'v30.0.1',
      wgpuTagCommit: '40f4a34ebaf56f9a046231f54125ad046239d3f3',
      engineCommit: 'fixture',
      rustc: 'rustc fixture',
      os: 'macos',
      architecture: 'aarch64',
      capabilities: {
        backend: 'Metal',
        rayQuery: true,
        adapter: {
          name: 'fixture', vendor: 0, device: 0, deviceType: 'IntegratedGpu', driver: '', driverInfo: '',
        },
      },
      features: {
        names: ['EXPERIMENTAL_RAY_QUERY'],
        experimentalRayQuery: true,
        experimentalRayHitVertexReturn: false,
        extendedAccelerationStructureVertexFormats: false,
        accelerationStructureBindingArray: false,
        experimentalRayTracingPipelines: false,
        timestampQuery: true,
      },
      limits: {
        maxBlasPrimitiveCount: 1,
        maxBlasGeometryCount: 1,
        maxTlasInstanceCount: 1,
        maxAccelerationStructuresPerShaderStage: 1,
        maxBuffersAndAccelerationStructuresPerShaderStage: 1,
        maxBindingArrayAccelerationStructureElementsPerShaderStage: 0,
      },
    },
    routeVerdict: 'incomplete',
    apiConformanceVerdict: 'ok',
    performanceVerdict: 'not-run',
    completenessValid: true,
    countsByProfile: { core: { pass: 54, fail: 0, unsupported: 0, notRun: 0 } },
    firstFailure: null,
    packagedExecutableIdentity: null,
    caseCount: 54,
  };
  const reportPath = resolve(directory, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(resolve(directory, 'cases.jsonl'), `${cases.map(JSON.stringify).join('\n')}\n`);
  return { reportPath, report, cases };
}

test('accepts a complete report and exact terminal counts', () => {
  const { reportPath } = fixture();
  assert.equal(verifyConformanceReport(reportPath).cases.length, 54);
});

test('accepts DX12 observations from the Windows conformance runner', () => {
  const { reportPath, report } = fixture();
  report.environment.os = 'windows';
  report.environment.architecture = 'x86_64';
  report.environment.capabilities.backend = 'Dx12';
  writeFileSync(reportPath, JSON.stringify(report));
  assert.equal(verifyConformanceReport(reportPath).report.environment.capabilities.backend, 'Dx12');
});

test('rejects duplicate case identities', () => {
  const { reportPath, cases } = fixture();
  cases[1].id = cases[0].id;
  writeFileSync(resolve(reportPath, '../cases.jsonl'), `${cases.map(JSON.stringify).join('\n')}\n`);
  assert.throws(() => verifyConformanceReport(reportPath), /unique/);
});
