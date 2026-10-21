import { type AssetDecoderContribution, type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { sceneAssetContribution } from '../assets/scene-decoder';

async function decoded<P>(
  contribution: AssetDecoderContribution<P>,
  payload: object,
  refs: readonly string[] = [],
): Promise<P | undefined> {
  const result = await contribution.decoder.decode({
    envelope: {
      guid: 'decoder-test',
      kind: contribution.kind.kind,
      payload: { kind: contribution.kind.kind, ...payload },
      refs,
      artifacts: {},
    },
    artifacts: { read: async () => ok(new Uint8Array()) },
    signal: new AbortController().signal,
  } as unknown as AssetDecoderInput<P>);
  if (!result.ok) expect(result.error.code).toBe('asset-package-invalid');
  return result.ok ? result.value : undefined;
}
describe('sceneAssetContribution', async () => {
  it('parses a scene payload into a SceneAsset', async () => {
    const out = await decoded(sceneAssetContribution, {
      entities: { 'entity-0': { components: {} } },
    });
    expect((out as { kind?: string }).kind).toBe('scene');
  });

  it('returns undefined for a malformed scene payload', async () => {
    expect(await decoded(sceneAssetContribution, { entities: 'bad' })).toBeUndefined();
  });

  it('defers component reference interpretation until the World supplies its schema', async () => {
    const out = await decoded(
      sceneAssetContribution,
      { entities: { 'entity-0': { components: { MeshFilter: { assetHandle: 9 } } } } },
      ['only-one-guid'],
    );
    expect(out).toMatchObject({
      kind: 'scene',
      entities: {
        'entity-0': { components: { MeshFilter: { assetHandle: 9 } } },
      },
    });
  });
});

it('rejects malformed entity, skin and instance facts without throwing or silently dropping them', async () => {
  for (const payload of [
    { entities: { root: null } },
    { entities: { root: { components: {} } }, skinGuids: 'bad' },
    { entities: { root: { components: {} } }, skinGuids: [2] },
    {
      entities: {
        root: {
          components: {},
          instance: { source: 0, overrides: [{ target: [], components: {} }] },
        },
      },
    },
  ])
    expect(await decoded(sceneAssetContribution, payload, ['source-guid'])).toBeUndefined();
  expect(
    await decoded(
      sceneAssetContribution,
      {
        entities: {
          root: {
            components: {},
            instance: { source: 0, overrides: [{ target: ['child'], components: {} }] },
          },
        },
        skinGuids: [1],
      },
      ['source-guid', 'skin-guid'],
    ),
  ).toMatchObject({
    entities: { root: { instance: { source: 'source-guid' } } },
    skinGuids: ['skin-guid'],
  });
});
