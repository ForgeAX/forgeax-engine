import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { samplerContribution } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { guid, installMemoryPack } from '../asset-formats/fixtures/memory-pack';

export default defineFeature({
  title: 'Finite asset batches',
  catalog: '`AssetRegistry.loadMany`',
  kind: 'headless',
  summary: 'A finite serial roster shares verified Pack reads across awaited progress callbacks.',
  expect:
    'Two fresh sampler GUIDs use one Pack fetch and expose ordered progress; duplicate requests own separate grants.',
  async run(checks) {
    const registry = new AssetRegistry();
    registry.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    try {
      const firstGuid = guid(0xd3);
      const guids = [firstGuid, guid(0xd4)];
      const { fetched } = await installMemoryPack(
        registry,
        guids.map((guid) => ({
          guid,
          kind: 'sampler',
          payload: { magFilter: 'nearest', minFilter: 'linear' },
        })),
      );
      const progress: number[] = [];
      const result = await registry.loadMany([...guids, firstGuid], 'sampler', {
        onProgress: async (completed, total) => {
          checks.equal('finite progress total', total, 3);
          progress.push(completed);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        },
      });
      checks.ok('batch loads every entry', result.ok);
      checks.equal('one verified Pack fetch across host tasks', fetched.length, 1);
      checks.equal('progress order', progress.join(','), '1,2,3');
      if (result.ok) {
        checks.equal('one grant per requested entry', result.value.length, 3);
        checks.equal('duplicate GUID keeps identity', result.value[0], result.value[2]);
        for (const handle of result.value) registry.release(handle).unwrap();
      }
    } finally {
      registry.dispose();
    }
  },
});
