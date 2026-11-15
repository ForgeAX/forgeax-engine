import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readCloudSnapshot, unavailableParameter, validateCloudEdit, type CloudSnapshotV1 } from '../cloud-controls.ts';
import { cloudParameterLabels } from '../parameter-labels.ts';

it('validates sparse requests without clamping, coercion or accepting unknown fields', () => {
  assert.deepEqual(validateCloudEdit({ thicknessMeters: 5200, useDetail: false }), {
    edit: { thicknessMeters: 5200, useDetail: false },
  });
  for (const [field, value] of [
    ['thicknessMeters', 0], ['thicknessMeters', Infinity], ['thicknessMeters', NaN], ['thicknessMeters', null],
    ['thicknessMeters', '5200'], ['shadowMapSamples', 64.5], ['shadowResolution', 2049],
    ['referenceTimeSeconds', -1], ['useDetail', 1], ['windOffsetMeters', [0, 0, 0]],
  ]) {
    assert.deepEqual(validateCloudEdit({ [String(field)]: value }), { field });
  }
});

it('distinguishes the secondary light path from Beer map and external consumers', () => {
  const ray = { selfShadow: true, shadowMode: 0 };
  assert.equal(unavailableParameter('shadowSamples', 'shape', ray), undefined);
  assert.ok(unavailableParameter('shadowMapSamples', 'shape', ray));
  const beer = { ...ray, shadowMode: 1 };
  assert.equal(unavailableParameter('shadowMapSamples', 'shape', beer), undefined);
  assert.ok(unavailableParameter('shadowSamples', 'shape', beer));
  assert.ok(unavailableParameter('surfaceShadowStrength', 'shape', beer));
  assert.equal(unavailableParameter('shadowMapSamples', 'band', { groundShadowEnabled: true }), undefined);
  assert.ok(unavailableParameter('useDetail', 'band-wide', {}));
  assert.ok(unavailableParameter('phaseG', 'uniform', {}));
  assert.equal(unavailableParameter('sunIlluminanceLux', 'off', {}), undefined);
});

const snapshot: CloudSnapshotV1 = {
  version: 1, preset: 'reference',
  config: {
    materialMode: 'shape', enabled: true, parameters: { thicknessMeters: 5200, useDetail: true },
    clock: { referenceTimeSeconds: 12, elapsedSeconds: 2, paused: true, windOffsetMeters: [17, 5, -11] },
    camera: { pose: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 }, cameraView: 'ground',
      routeTime: null, fixtureVisible: true, viewMode: 'normal' },
    assets: { materialGuid: 'shape', instanceGuid: null, cookIdentity: 'cook',
      instanceCookIdentity: null, programIdentity: 'detail' },
  },
  frame: { frameId: 7, deviceGeneration: 2, worldIdentity: 'world-a' },
};

it('round-trips versioned snapshots without sharing the caller input', () => {
  const raw = JSON.parse(JSON.stringify(snapshot));
  const read = readCloudSnapshot(raw);
  assert.deepEqual(read, snapshot);
  raw.config.clock.windOffsetMeters[0] = 90;
  raw.config.parameters.thicknessMeters = 3000;
  raw.config.camera.pose.x = 400;
  assert.deepEqual(read, snapshot);
  assert.equal(readCloudSnapshot({ ...raw, version: 2 }), undefined);
  assert.equal(readCloudSnapshot({ ...raw, preset: 'x'.repeat(129) }), undefined);
  assert.equal(readCloudSnapshot({ ...raw, frame: { ...snapshot.frame, deviceGeneration: -1 } }), undefined);
  assert.equal(readCloudSnapshot({ ...raw, config: { ...raw.config, parameters: { referenceTimeSeconds: 12 } } }), undefined);
  raw.config.clock.windOffsetMeters[1] = Infinity;
  assert.equal(readCloudSnapshot(raw), undefined);
});

it('declares each control once and identifies UseNoise3 as a Cook variant', () => {
  const labels = Object.values(cloudParameterLabels);
  assert.equal(new Set(labels.map(meta => meta.part)).size, labels.length);
  assert.ok(labels.every(meta => meta.ue.trim().length > 0));
  assert.deepEqual(labels.filter(meta => meta.update === 'cooked-static').map(meta => meta.ue), ['UseNoise3']);
});
