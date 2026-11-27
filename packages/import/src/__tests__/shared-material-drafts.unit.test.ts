import assert from 'node:assert/strict';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  buildScriptablePack,
  createStandardAssetOutputProducerRegistry,
} from '../scriptable-pack-build.js';

it('retains one copy of equal native programs before Pack product persistence', async () => {
  const packageId = definePackageId('01900000-0000-7000-8000-0000000000d7');
  const shader = 'materials/programs/example.wgsl';
  const material = { kind: 'material' } as const;
  const makeDraft = (guid: string, sourceKey: string) => {
    const bytes = Uint8Array.of(sourceKey === 'different-bytes' ? 2 : 1);
    const program = {
      specializationKey: 'one specialization',
      artifact: { path: shader, mediaType: 'text/wgsl', bytes },
      selections: [{ entry: sourceKey === 'different-abi' ? 'other' : 'main' }],
    };
    return {
      guid,
      payload: {
        ...material,
        cooked: { schemaVersion: 'material-cook/5', programs: [program], materialGuid: guid },
      },
      refs: [],
      artifacts: {
        [shader]: {
          mediaType: 'text/wgsl',
          bytes: sourceKey === 'external-conflict' ? Uint8Array.of(3) : bytes.slice(),
        },
      },
      inputFingerprint: sourceKey,
    };
  };
  const names = ['a', 'b', 'different-abi', 'different-bytes', 'external-conflict'];
  const drafts = new Map<string, ReturnType<typeof makeDraft>>();
  const result = await buildScriptablePack({
    definition: definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: () => ok(Object.fromEntries(names.map((name) => [name, material]))),
    }),
    sourcePath: 'assets/materials.pack.ts',
    outputs: createStandardAssetOutputProducerRegistry(),
    cookers: [
      {
        key: 'material',
        cook(input: unknown) {
          const { guid, sourceKey } = input as { guid: string; sourceKey: string };
          const draft = makeDraft(guid, sourceKey);
          drafts.set(sourceKey, draft);
          return draft;
        },
      },
    ],
  });
  const assets = result.unwrap().product.assets;
  const asset = (name: string) => {
    const guid = AssetGuid.format(AssetGuid.derive(packageId, name));
    const row = assets.find((output) => output.guid === guid);
    assert(row);
    return { ...row, payload: row.payload as ReturnType<typeof makeDraft>['payload'] };
  };
  const first = asset('a');
  const second = asset('b');
  const canonical = first.payload.cooked.programs[0];
  assert(canonical);
  expect(second.payload.cooked.programs[0]).toBe(canonical);
  expect(second.artifacts[shader]?.bytes).toBe(canonical.artifact.bytes);
  expect(first.payload.cooked.materialGuid).not.toBe(second.payload.cooked.materialGuid);
  expect(asset('different-abi').payload.cooked.programs[0]?.selections[0]?.entry).toBe('other');
  expect(asset('different-bytes').payload.cooked.programs[0]?.artifact.bytes).toEqual(
    Uint8Array.of(2),
  );
  expect(asset('external-conflict').artifacts[shader]?.bytes).toEqual(Uint8Array.of(3));
  const original = drafts.get('b');
  assert(original);
  expect(original.payload.cooked.programs[0]).not.toBe(canonical);
  expect(original.artifacts[shader]?.bytes).not.toBe(canonical.artifact.bytes);
});
