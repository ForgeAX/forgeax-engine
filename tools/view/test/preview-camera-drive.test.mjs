import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ViewWorkspaceError } from '../packages/view-workspace-core/src/contract.ts';
import {
  beginPreviewCameraDrive,
  openMeshPreviewCamera,
  selectMeshPreviewCameraTarget,
} from '../packages/view-workspace-core/src/preview-camera.ts';

const scene = {
  asset: { guid: 'scene-guid', kind: 'scene' },
  target: { targetId: 'scene-target', generation: 2 },
};
const mesh = {
  asset: { guid: 'mesh-guid', kind: 'mesh' },
  target: { targetId: 'mesh-target', generation: 7 },
};

function state() {
  return {
    scenePreview: scene,
    preview: scene,
    previews: [scene, mesh],
    resourceOpens: {
      mesh: { asset: mesh.asset, preview: mesh },
    },
  };
}

function cameraApi(stateValue = state()) {
  const calls = [];
  const api = {
    async getState() {
      calls.push('tabs.get');
      return stateValue;
    },
    async getCamera(value) {
      calls.push(['get', value.targetId, value.targetGeneration]);
      return { version: 4, camera: { transform: { pos: [0, 1, 6] } } };
    },
    async beginCamera(value) {
      calls.push(['begin', value.targetId, value.targetGeneration, value.baseVersion, value.interactionId]);
      return { version: value.baseVersion, interactionId: value.interactionId };
    },
    async updateCamera(value) {
      calls.push(['update', value.targetId, value.targetGeneration, value.interactionId, value.input, value.camera]);
      return { version: value.baseVersion };
    },
    async commitCamera(value) {
      calls.push(['commit', value.targetId, value.targetGeneration, value.interactionId, value.expectedVersion]);
      return { version: value.expectedVersion + 1 };
    },
    async abortCamera(value) {
      calls.push(['abort', value.targetId, value.reason]);
    },
  };
  return { api, calls };
}

describe('mesh preview camera drive', () => {
  it('selects the open mesh preview instead of the scene', () => {
    const target = selectMeshPreviewCameraTarget(state());
    assert.equal(target.targetId, 'mesh-target');
    assert.equal(target.generation, 7);
    assert.equal(selectMeshPreviewCameraTarget({ scenePreview: scene, previews: [scene] }), undefined);
  });

  it('drives the mesh camera through get, begin, update, and commit', async () => {
    const { api, calls } = cameraApi();
    const drive = await openMeshPreviewCamera(api, {
      type: 'move',
      velocity: [0, 0, -4],
    });
    assert.equal(drive.targetId, 'mesh-target');
    assert.equal(drive.targetGeneration, 7);
    assert.deepEqual(calls.map((entry) => (Array.isArray(entry) ? entry[0] : entry)), [
      'tabs.get',
      'get',
      'begin',
      'update',
    ]);
    assert.deepEqual(calls[3][4], { type: 'move', velocity: [0, 0, -4] });
    assert.equal(calls[1][1], 'mesh-target');
    assert.equal(calls[2][1], 'mesh-target');
    assert.equal(calls[3][1], 'mesh-target');
    await drive.update({ type: 'look', yaw: 0.2, pitch: -0.1, distance: 5 });
    await drive.commit();
    assert.equal(calls.at(-1)[0], 'commit');
    assert.equal(calls.at(-1)[1], 'mesh-target');
    assert.equal(calls.at(-1)[2], 7);
    assert.equal(calls.at(-1)[3], drive.interactionId);
    assert.equal(calls.at(-1)[4], 4);
  });

  it('aborts a failed update and refuses a second commit', async () => {
    const { api, calls } = cameraApi();
    api.updateCamera = async () => {
      calls.push('update-failed');
      throw new Error('camera busy');
    };
    await assert.rejects(
      openMeshPreviewCamera(api, { type: 'dolly', amount: -0.4, distance: 5 }),
      /camera busy/,
    );
    assert.equal(calls.at(-1)[0], 'abort');
    assert.equal(calls.at(-1)[1], 'mesh-target');
    const drive = await beginPreviewCameraDrive(api, mesh.target);
    await drive.commit();
    await assert.rejects(drive.commit(), (error) => {
      assert.equal(error instanceof ViewWorkspaceError, true);
      assert.equal(error.code, 'view-workspace-invalid-args');
      return true;
    });
  });

  it('does not open a drive when no mesh preview is live', async () => {
    const { api } = cameraApi({ scenePreview: scene, previews: [scene] });
    await assert.rejects(openMeshPreviewCamera(api), (error) => {
      assert.equal(error instanceof ViewWorkspaceError, true);
      assert.equal(error.code, 'view-workspace-preview-required');
      return true;
    });
  });
});
