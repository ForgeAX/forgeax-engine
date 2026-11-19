import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCloudRequestTracker, createCloudSnapshotHistory, readWorldReadyCloudFrame } from '../cloud-inspection.ts';
import type { CloudSnapshotV1 } from '../cloud-controls.ts';

function snapshot(thicknessMeters = 5200, worldIdentity = 'world-a') {
  return {
    version: 1, preset: 'clear',
    config: {
      materialMode: 'shape', enabled: true, parameters: { thicknessMeters },
      clock: { referenceTimeSeconds: 12, elapsedSeconds: 2, paused: true, windOffsetMeters: [17, 5, -11] },
      camera: { pose: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 }, cameraView: 'ground',
        routeTime: null, fixtureVisible: true, viewMode: 'normal' },
      assets: { materialGuid: 'shape', instanceGuid: null, cookIdentity: 'cook',
        instanceCookIdentity: null, programIdentity: 'detail' },
    },
    frame: { frameId: 7, deviceGeneration: 2, worldIdentity },
  } satisfies CloudSnapshotV1;
}

it('keeps separate immutable captures with stable World-scoped IDs and no effect on the current configuration', () => {
  const history = createCloudSnapshotHistory('world-a');
  const running = snapshot();
  history.capture(running, 'initial');
  const initial = history.read().entries[0];
  running.config.parameters.thicknessMeters = 4200;
  running.config.camera.pose.x = 9;
  running.config.clock.windOffsetMeters[0] = 0;
  running.frame.frameId = 8;
  history.capture(running, 'saved');

  const { entries } = history.read();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ kind, frame, config }) => [kind, frame?.frameId, config.parameters.thicknessMeters]),
    [['saved', 8, 4200], ['initial', 7, 5200]]);
  assert.equal(entries[1].id, initial.id);
  assert.notEqual(entries[0].id, initial.id);
  assert.deepEqual(entries[1].config, snapshot().config);
  assert.ok(Object.isFrozen(entries));
  assert.ok(Object.isFrozen(entries[1].config.clock.windOffsetMeters));
  assert.throws(() => { entries[1].config.camera.pose.x = 22; }, TypeError);
  assert.equal(running.config.camera.pose.x, 9);
  assert.equal(running.config.parameters.thicknessMeters, 4200);
});

it('bounds retention and cannot attach a previous World’s capture frame to a local history entry', () => {
  const first = createCloudSnapshotHistory('world-a');
  first.capture(snapshot(), 'initial');
  const initialId = first.read().entries[0].id;
  for (let i = 1; i <= 17; ++i) first.capture(snapshot(5200 + i), 'saved');
  assert.equal(first.read().entries.length, 16);
  assert.equal(first.read().entries[0].config.parameters.thicknessMeters, 5217);
  assert.ok(first.read().entries.every(entry => entry.id !== initialId));

  const rebuilt = createCloudSnapshotHistory('world-b');
  assert.deepEqual(rebuilt.read().entries, []);
  rebuilt.capture(snapshot(), 'saved');
  assert.equal(rebuilt.read().entries[0].frame, null);
  assert.notEqual(rebuilt.read().entries[0].id, initialId);
  assert.equal(readWorldReadyCloudFrame(snapshot().frame, 'world-b'), null);
  assert.deepEqual(readWorldReadyCloudFrame(snapshot().frame, 'world-a'), snapshot().frame);
  assert.equal(readWorldReadyCloudFrame({ ...snapshot().frame, deviceGeneration: -1 }, 'world-a'), null);
});

it('publishes a request revision after a successful change and preserves it after rejection or a failed write', () => {
  const events: string[] = [];
  let writeFailed = false;
  const tracker = createCloudRequestTracker<{ id: number }>(revision => {
    if (writeFailed) throw new Error('ECS write failed');
    events.push(`write:${revision}`);
  });
  assert.equal(tracker.read(), null);
  assert.equal(tracker.apply({ id: 1 }, () => 'missing Cook variant'), 'missing Cook variant');
  assert.equal(tracker.read(), null);
  tracker.apply({ id: 2 }, () => { events.push('accepted:2'); });
  assert.deepEqual(events, ['accepted:2', 'write:1']);
  assert.deepEqual(tracker.read(), { id: 2, requestRevision: 1 });
  assert.equal(tracker.apply({ id: 3 }, () => 'invalid thickness'), 'invalid thickness');
  writeFailed = true;
  assert.throws(() => tracker.apply({ id: 4 }, () => {}), /ECS write failed/);
  assert.deepEqual(tracker.read(), { id: 2, requestRevision: 1 });
  writeFailed = false;
  tracker.apply({ id: 5 }, () => { events.push('accepted:5'); });
  assert.deepEqual(events, ['accepted:2', 'write:1', 'accepted:5', 'write:2']);
  assert.deepEqual(tracker.read(), { id: 5, requestRevision: 2 });
});
