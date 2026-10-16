import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cameraPoseForRestore,
  materialPreviewShouldCapture,
  rememberInitialPreviewCamera,
  restorePreviewCamera,
} from '../packages/view-plugin-material/src/preview-navigation.ts';
import {
  cameraPoseWithPivot,
  commitPreviewCameraPivot,
  meshAabbCenter,
} from '../packages/view-workspace-core/src/preview-camera.ts';

const target = { targetId: 'material-1', generation: 3 };
const initial = {
  transform: { pos: [0, 0, 8], quat: [0, 0, 0, 1] },
  lens: { fov: Math.PI / 4, aspect: 1, near: 0.01, far: 40, projection: 'perspective' },
  pivot: null,
};

describe('material preview navigation', () => {
  it('keeps the first camera pose and commits it without aspect', async () => {
    const calls = [];
    let reads = 0;
    const api = {
      async getCamera(value) {
        reads += 1;
        calls.push(['get', value.targetId, reads]);
        return { version: reads === 1 ? 2 : 5, camera: reads === 1 ? initial : { transform: { pos: [4, 1, 1] } } };
      },
      async beginCamera(value) {
        calls.push(['begin', value.targetId, value.baseVersion, value.interactionId]);
        return { version: value.baseVersion };
      },
      async commitCamera(value) {
        calls.push(['commit', value.targetId, value.expectedVersion, value.camera]);
      },
    };
    const snapshots = new Map();
    const first = await rememberInitialPreviewCamera(api, target, { snapshots });
    const again = await rememberInitialPreviewCamera(api, target, { snapshots });
    assert.equal(again, first);
    assert.equal(reads, 1);
    await restorePreviewCamera(api, target, first);
    const commit = calls.find((entry) => entry[0] === 'commit');
    assert.equal(commit[1], 'material-1');
    assert.equal(commit[2], 5);
    assert.equal(commit[3].lens.fov, initial.lens.fov);
    assert.equal(Object.hasOwn(commit[3].lens, 'aspect'), false);
    assert.deepEqual(commit[3].transform, initial.transform);
    assert.equal(Object.hasOwn(initial.lens, 'aspect'), true);
  });

  it('ignores keys until the preview surface is focused and ignores the restore button', () => {
    const button = { closest: (selector) => (selector.includes('button') ? button : null) };
    const surface = {
      contains: (node) => node === surface || node === child,
      ownerDocument: {
        activeElement: null,
        documentElement: { dataset: { forgeaxViewActivePage: 'material' } },
      },
    };
    const child = { closest: () => null };
    assert.equal(materialPreviewShouldCapture({ type: 'keydown', key: 'w', target: surface }, surface), false);
    surface.ownerDocument.activeElement = surface;
    assert.equal(materialPreviewShouldCapture({ type: 'keydown', key: 'w', target: surface }, surface), true);
    assert.equal(materialPreviewShouldCapture({ type: 'pointerdown', button: 0, target: child }, surface), true);
    assert.equal(materialPreviewShouldCapture({ type: 'pointerdown', button: 0, target: button }, surface), false);
    surface.ownerDocument.documentElement.dataset.forgeaxViewActivePage = 'editor';
    assert.equal(materialPreviewShouldCapture({ type: 'keydown', key: 'w', target: surface }, surface), false);
  });

  it('strips aspect without dropping the rest of the pose', () => {
    const pose = cameraPoseForRestore(initial);
    assert.equal(Object.hasOwn(pose.lens, 'aspect'), false);
    assert.equal(pose.lens.near, 0.01);
    assert.equal(pose.pivot, null);
  });

  it('uses a finite binding AABB midpoint as the orbit pivot', async () => {
    assert.deepEqual(meshAabbCenter({ meta: { aabb: [-2, 0, 1, 2, 4, 3] } }), [0, 2, 2]);
    assert.deepEqual(meshAabbCenter({ aabb: [0, 0, 0, 2, 2, 2] }), [1, 1, 1]);
    assert.equal(meshAabbCenter({ meta: { aabb: [-1, 0, 0, 1, Number.NaN, 1] } }), undefined);
    assert.equal(meshAabbCenter({ meta: { aabb: [-1, 0, 0, 1] } }), undefined);
    assert.equal(meshAabbCenter(null), undefined);

    const calls = [];
    const api = {
      async getCamera() {
        return { version: 4, camera: initial };
      },
      async beginCamera(value) {
        calls.push(['begin', value.baseVersion]);
      },
      async commitCamera(value) {
        calls.push(['commit', value.expectedVersion, value.camera]);
      },
    };
    await commitPreviewCameraPivot(api, target, [0, 2, 2]);
    const camera = calls[1][2];
    assert.deepEqual(camera.pivot, [0, 2, 2]);
    assert.equal(Object.hasOwn(camera.lens, 'aspect'), false);
    assert.deepEqual(camera.transform, initial.transform);
    assert.deepEqual(cameraPoseWithPivot(initial, [1, 2, 3]).pivot, [1, 2, 3]);
  });

  it('aborts pivot seeding when its preview observation ends after camera.begin', async () => {
    const controller = new AbortController();
    const calls = [];
    const api = {
      async getCamera(options) {
        calls.push(['get', options]);
        return { version: 4, camera: initial };
      },
      async beginCamera(options) {
        calls.push(['begin', options]);
        controller.abort();
      },
      async commitCamera(options) {
        calls.push(['commit', options]);
      },
      async abortCamera(options) {
        calls.push(['abort', options]);
      },
    };
    await commitPreviewCameraPivot(api, target, [0, 2, 2], {
      signal: controller.signal, reportError: false,
    });
    assert.deepEqual(calls.map(([operation]) => operation), ['get', 'begin', 'abort']);
    assert.equal(calls[0][1].signal, controller.signal);
    assert.equal(calls[1][1].reportError, false);
    assert.equal(calls[2][1].reportError, false);
  });

  it('preserves a current pivot failure after cleaning up its camera transaction', async () => {
    const calls = [];
    const failure = new Error('camera commit failed');
    const api = {
      async getCamera() { return { version: 4, camera: initial }; },
      async beginCamera() { calls.push('begin'); },
      async commitCamera() { calls.push('commit'); throw failure; },
      async abortCamera() { calls.push('abort'); },
    };
    await assert.rejects(commitPreviewCameraPivot(api, target, [0, 2, 2]), failure);
    assert.deepEqual(calls, ['begin', 'commit', 'abort']);
  });

  it('cleans up a commit rejected after its preview observation ends', async () => {
    const controller = new AbortController();
    const calls = [];
    const api = {
      async getCamera() { return { version: 4, camera: initial }; },
      async beginCamera() { calls.push('begin'); },
      async commitCamera(options) {
        calls.push(['commit', options]);
        controller.abort();
        throw new Error('preview closed');
      },
      async abortCamera(options) { calls.push(['abort', options]); },
    };
    await assert.rejects(
      commitPreviewCameraPivot(api, target, [0, 2, 2], { signal: controller.signal, reportError: false }),
      /preview closed/,
    );
    assert.equal(calls[1][1].signal.aborted, true);
    assert.equal(calls[1][1].reportError, false);
    assert.equal(calls[2][0], 'abort');
    assert.equal(calls[2][1].reportError, false);
  });
});
