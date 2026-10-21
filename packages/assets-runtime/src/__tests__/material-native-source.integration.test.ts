import type { MaterialAsset, RenderTextureSourceToken } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { samplerContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';

const token = (source: RenderTextureSourceToken['source']): RenderTextureSourceToken => ({
  kind: 'render-texture-source',
  owner: 'native-owner',
  id: 1,
  source,
});
const material = (value: unknown): MaterialAsset => ({
  kind: 'material',
  passes: [{ name: 'main', program: { module: 'forgeax::default-unlit' } }],
  parameters: [{ name: 'image', type: 'texture' }],
  values: { image: value as never },
});

it.each([
  'target',
  'canvas',
  'external',
] as const)('retains a copyable %s source binding without inventing an asset dependency', (source) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const input = token(source);
  const reference = assets.create(material({ source: input })).unwrap();
  const original = { ...input };
  (input as { owner: string }).owner = 'mutated-caller';
  expect(assets.read(reference).unwrap().values?.image).toEqual({ source: original });
  expect(runtimeAssets(assets).dependencies(reference).unwrap()).toEqual([]);
  const copy = assets.copy(reference).unwrap();
  const fixed = assets.snapshot(reference).unwrap();
  assets.update(reference, { values: { image: { source: { ...original, id: 2 } } } }).unwrap();
  expect(assets.read(copy).unwrap().values?.image).toEqual({ source: original });
  expect(fixed.read<MaterialAsset>(reference).unwrap().values?.image).toEqual({ source: original });
  expect(assets.read(reference).unwrap().values?.image).toEqual({ source: { ...original, id: 2 } });
  fixed.dispose();
  assets.dispose();
});

it('transfers only the optional sampler hold when a native binding changes', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const sampler = assets
    .create({ kind: 'sampler', minFilter: 'linear', magFilter: 'linear' })
    .unwrap();
  const reference = assets.create(material({ source: token('target'), sampler })).unwrap();
  assets.release(sampler).unwrap();
  expect(assets.read(sampler).ok).toBe(true);
  assets.replace(reference, material({ source: token('canvas') })).unwrap();
  expect(assets.read(sampler).ok).toBe(false);
  assets.dispose();
});

it.each([
  undefined,
  null,
  {},
  { ...token('target'), id: 0 },
  { ...token('target'), id: NaN },
  { ...token('target'), owner: '' },
  { ...token('target'), source: 'asset' },
  { ...token('target'), nativeObject: {} },
])('rejects malformed native source %# without committing a version', (source) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const reference = assets.create(material({ source: token('target') })).unwrap();
  const observer = assets.observe().unwrap();
  expect(assets.update(reference, { values: { image: { source } as never } }).ok).toBe(false);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  observer.dispose();
  assets.dispose();
});

it('rejects bindings that ambiguously name both an asset and a native producer', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  expect(assets.create(material({ source: token('target'), texture: 42 })).ok).toBe(false);
  assets.dispose();
});
