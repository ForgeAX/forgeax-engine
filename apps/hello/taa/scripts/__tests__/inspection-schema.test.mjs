import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../evidence/inspection.schema.json', import.meta.url)), 'utf8'),
);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

function snapshot() {
  return {
    paused: false,
    antialias: 'taa',
    taa: {
      enabled: true,
      historyOwner: 'renderer-temporal',
      independentFromMotionBlur: true,
    },
    dynamicResolution: {
      enabled: false,
      contract: 'fixed-scale',
      scale: 1,
      output: { width: 200, height: 150 },
      internal: null,
      coverageProducer: false,
      status: 'off',
    },
    recovery: {
      state: 'alive',
      recoverable: false,
      phase: null,
      lastOutcome: 'none',
    },
    backend: 'webgpu',
    capabilities: {
      compute: true,
      storageBuffer: true,
      rgba16floatRenderable: true,
      timestampQuery: true,
      timestampPeriodNanoseconds: 1,
    },
    timing: null,
    frame: { frameId: 300, deviceGeneration: 1 },
    temporal: { status: 'stable', historyValid: true, historyAttempt: 'committed', epoch: 3 },
    temporalTarget: null,
    motionBlur: {
      enabled: true,
      status: 'active',
      shutterAngle: 180,
      maxRadiusPixels: 24,
      sampleCount: 12,
      targetFps: 60,
      effectiveSampleCount: 8,
      demoMotionSpeed: '7.2 world units/s (dt-based)',
      temporalDemand: 'scene-data-temporal-v1',
      historyWrites: 0,
    },
    workload: {
      kind: 'auto',
      executed: true,
      exposureMode: 'auto',
      colorLutStrength: 0,
      sourceKey: null,
      catalogProvenance: null,
      autoExposure: {
        requested: {
          kind: 'auto',
          fallback: 1,
          compensationEv: 0,
          rangeEv: [-8, 8],
          rates: [3, 1],
        },
        actual: 1,
        actualState: 'accepted',
        fallback: 1,
        lastKnownGood: 1,
        targetGeneration: 1,
        reset: [],
        cost: { histogramBytes: 1024, passCount: 3, physicalPassCount: 1 },
        receipt: { frameId: 300, committed: true },
      },
      lutReceipt: null,
      frameGeneration: 300,
      frameIdentity: {
        first: 1,
        last: 300,
        count: 300,
        sequenceSha256: 'a'.repeat(64),
        contiguous: true,
      },
      resourceGrowth: null,
    },
    observations: [],
    observationError: null,
    scene: {
      fullRebuilds: 1,
      deltaFrames: 299,
      transformUpdates: 299,
      projectionRecords: 1,
      lastResyncReason: null,
    },
    passes: ['auto-exposure-meter', 'standard-exposure-white-balance'],
  };
}

test('inspection schema admits the exact bounded main.ts projection', () => {
  const value = snapshot();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
});

test('inspection schema rejects state-only or unbounded extensions', () => {
  const value = snapshot();
  value.state = 'alive';
  assert.equal(validate(value), false);
});
