import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  produceScriptablePackProducts,
  type ScriptablePackInput,
} from '../scriptable-pack-host.js';
import { createScriptablePackStagedAssetSnapshotSource } from '../scriptable-pack-staged-snapshot.js';
import { packDefinition } from './fixtures/pack-definition.js';

function input(definition: ScriptablePackInput['definition'], name: string) {
  return {
    definition,
    sourcePath: name,
    displaySourcePath: name,
    sourceClosure: [],
    publicationGeneration: 1,
    policy: {
      base: '/',
      packagePath: `${name}.json`,
      artifactPath: (guid: string, key: string) => `${guid}/${key}`,
    },
  };
}

it('reuses successful evaluation across dependency reads and Cook in one worklist', async () => {
  const childId = definePackageId('01900000-0000-7000-8000-000000007101');
  const childGuid = AssetGuid.derive(childId, 'scene');
  let children = 0,
    parents = 0;
  const child = packDefinition(childId, () => {
    children++;
    return ok({ scene: { kind: 'scene' as const, entities: {} } });
  });
  const parent = packDefinition('01900000-0000-7000-8000-000000007102', async (context) => {
    parents++;
    const read = await context.readByGuid(childGuid);
    if (!read.ok) return read;
    return ok({ scene: { kind: 'scene' as const, entities: {} } });
  });
  const result = await produceScriptablePackProducts({
    sources: [input(child, 'child'), input(parent, 'parent')],
  });
  if (!result.ok) throw result.error;
  const first = result.value.get('parent');
  expect(result.value.has('child')).toBe(true);
  expect({ children, parents }).toEqual({ children: 1, parents: 1 });
  expect(first?.publication.externalEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ guid: AssetGuid.format(childGuid), usage: 'content' }),
    ]),
  );
  expect((await produceScriptablePackProducts({ sources: [input(child, 'child')] })).ok).toBe(true);
  expect(children).toBe(2);
});

it('does not silently reuse results across parameter contexts or changed output discovery', async () => {
  const definition = definePack({
    schemaVersion: '2.0.0',
    packageId: definePackageId('01900000-0000-7000-8000-000000007103'),
    parameters: [{ name: 'enabled', type: 'bool', default: true }] as const,
    build: ({ values }) =>
      ok({ [values.enabled ? 'scene' : 'other']: { kind: 'scene' as const, entities: {} } }),
  });
  const first = await produceScriptablePackProducts({ sources: [input(definition, 'subject')] });
  const changed = await produceScriptablePackProducts({
    sources: [{ ...input(definition, 'subject'), values: { enabled: false } }],
  });
  if (!first.ok) throw first.error;
  if (!changed.ok) throw changed.error;
  expect(first.value.get('subject')?.publication.outputs.map((asset) => asset.sourceKey)).toEqual([
    'scene',
  ]);
  expect(changed.value.get('subject')?.publication.outputs.map((asset) => asset.sourceKey)).toEqual(
    ['other'],
  );
});

it('reads external content without replacing a failed local owner with an older published value', async () => {
  const externalId = definePackageId('01900000-0000-7000-8000-000000007106');
  const externalGuid = AssetGuid.derive(externalId, 'scene');
  let reads = 0;
  const assetSource = {
    async readByGuid() {
      reads++;
      return ok({
        asset: { kind: 'scene' as const, entities: {} },
        generation: 1,
        digest: 'sha256:external',
      });
    },
  };
  const parent = input(
    packDefinition('01900000-0000-7000-8000-000000007107', async (context) => {
      const value = await context.readByGuid(externalGuid);
      return value.ok ? ok({ scene: { kind: 'scene' as const, entities: {} } }) : value;
    }),
    'parent',
  );
  expect((await produceScriptablePackProducts({ sources: [parent], assetSource })).ok).toBe(true);
  expect(reads).toBe(1);
  const failure = new AssetError({
    code: 'asset-not-imported',
    expected: 'the local source to build successfully',
    hint: 'repair the owner before building its consumer',
  });
  const ownerBuild = vi.fn(async () => err(failure));
  const local = createScriptablePackStagedAssetSnapshotSource({
    generation: 2,
    owners: [{ id: 'local-owner', guids: [externalGuid], build: ownerBuild }],
  });
  const result = await produceScriptablePackProducts({ sources: [parent], assetSource: local });
  expect(result.ok).toBe(false);
  expect(ownerBuild).toHaveBeenCalledTimes(1);
  expect(reads).toBe(1);
});

it('uses the same non-default generation for material receipts and the accepted publication', async () => {
  const material = {
    kind: 'material' as const,
    passes: [{ name: 'forward', program: { module: 'game::surface' } }] as const,
    parameters: [],
  };
  const definition = packDefinition('01900000-0000-7000-8000-000000007108', () => ok({ material }));
  let observedGeneration: number | undefined;
  const result = await produceScriptablePackProducts({
    sources: [{ ...input(definition, 'material'), publicationGeneration: 7 }],
    cookers: [
      {
        key: 'material',
        cook(value: {
          readonly guid: string;
          readonly source: typeof material;
          readonly cookGeneration?: number;
        }) {
          observedGeneration = value.cookGeneration;
          return {
            guid: value.guid,
            payload: value.source,
            refs: [],
            artifacts: {},
            inputFingerprint: 'sha256:surface-generation',
          };
        },
      },
    ],
  });
  expect(observedGeneration).toBe(7);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.get('material')?.publication.generation).toBe(7);
});
