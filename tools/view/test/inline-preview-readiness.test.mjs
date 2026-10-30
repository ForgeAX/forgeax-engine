import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { inlinePreviewReadyExtent } from '../scripts/verify-inline-previews.mjs';

test('a sized preview waits for its own completed ready frame before fresh capture', () => {
  const surface = {
    width: 400, height: 300,
    dataset: { forgeaxAssetPreview: 'mesh-target' },
    forgeaxFrameProgress: {},
  };
  const host = { clientWidth: 200, clientHeight: 150, querySelector: () => surface };
  const read = runInNewContext(`(${inlinePreviewReadyExtent.toString()})`, {
    devicePixelRatio: 2,
    document: { querySelector: () => host },
  });
  const input = { testId: 'mesh-preview', targetId: 'mesh-target' };
  assert.equal(read(input), false, 'layout alone does not establish GPU readiness');
  surface.forgeaxFrameProgress.completed = { frameId: 4, presentation: 'pending' };
  assert.equal(read(input), false, 'completed warming frames cannot qualify');
  surface.forgeaxFrameProgress.completed = { frameId: 5, presentation: 'ready' };
  assert.deepEqual(Array.from(read(input)), [400, 300]);
  assert.equal(read({ ...input, targetId: 'scene-target' }), false, 'foreign targets cannot qualify');
  surface.width = 200;
  assert.equal(read(input), false, 'an old drawing-buffer extent cannot qualify');
});
