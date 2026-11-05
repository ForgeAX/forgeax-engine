import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePackWorklist } from '../scriptable-pack-build.js';

async function run(staleCycle = false) {
  const parentId = definePackageId('01900000-0000-7000-8000-000000008112');
  const childId = definePackageId('01900000-0000-7000-8000-000000008113');
  const guid = AssetGuid.derive(parentId, 'scene'),
    childGuid = AssetGuid.format(AssetGuid.derive(childId, 'scene'));
  let childBuilds = 0;
  const subjects = [
    {
      sourcePath: 'a-dependent.pack.ts',
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: childId,
        async build(context) {
          childBuilds++;
          const source = await context.readByGuid(guid);
          return source.ok ? ok({ scene: source.value }) : source;
        },
      }),
    },
    {
      sourcePath: 'z-source.pack.ts',
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: parentId,
        build: () => ok({ scene: { kind: 'scene' as const, entities: {} } }),
      }),
    },
  ];
  const outputs = new AssetOutputProducerRegistry();
  outputs.register({
    kind: 'scene',
    version: 'fixture/1',
    produce: ({ asset }) => ok({ payload: asset as never, refs: [], artifacts: {} }),
  });
  const result = await buildScriptablePackWorklist({
    subjects,
    outputs,
    cache: {
      read: async () => undefined,
      write: async () => {},
      dependencies: async (subject) =>
        subject.sourcePath.startsWith('a')
          ? { outputs: [childGuid], reads: [AssetGuid.format(guid)] }
          : { outputs: [AssetGuid.format(guid)], reads: staleCycle ? [childGuid] : [] },
    },
  });
  return { result, childBuilds };
}

it('uses cached dependency topology to avoid rebuilding a consumer before its source is staged', async () => {
  const { result, childBuilds } = await run();
  expect(result.ok).toBe(true);
  expect(childBuilds).toBe(1);
});

it('treats a stale cached cycle as a scheduling hint and retains the ordinary dependency retry', async () => {
  const { result, childBuilds } = await run(true);
  expect(result.ok).toBe(true);
  expect(childBuilds).toBe(2);
});
