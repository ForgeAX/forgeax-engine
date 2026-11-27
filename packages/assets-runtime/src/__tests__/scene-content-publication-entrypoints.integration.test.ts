import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  createSceneContentPublicationTask,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import { sceneAssetContribution } from '@forgeax/engine-scene';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

it('reuses an unchanged cooked Scene proof across the published entrypoints', async () => {
  const assets = new AssetRegistry();
  onTestFinished(() => assets.dispose());
  assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
  publishRuntimeAssets(assets, [{ guid, asset: { kind: 'scene', entities: {} } }]);
  const scene = (await assets.load(guid, 'scene')).unwrap();
  const records = runtimeAssets(assets);
  const lease = records.beginContentCapture(scene).unwrap().step(1000).unwrap();
  assert.isDefined(lease);
  const task = createSceneContentPublicationTask(assets, lease, scene);
  try {
    const guard = task.step(100).unwrap();
    assert(guard);
    const version = vi.spyOn(records, 'version');
    try {
      for (let turn = 0; turn < 100; turn++) guard.validate().unwrap();
      expect(version).not.toHaveBeenCalled();
    } finally {
      version.mockRestore();
    }
  } finally {
    task.dispose();
    const retirement = lease.retire().unwrap();
    while (!retirement.inspect().done) retirement.step(1).unwrap();
  }
});
