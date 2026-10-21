import { defineComponent, World } from '@forgeax/engine-ecs';
import { textureContribution } from '@forgeax/engine-image';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import type { Asset, MaterialAsset, MaterialRootAsset } from '@forgeax/engine-types';
import { describe, expect, test } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssets } from '../internal/runtime-assets';

const Binding = defineComponent('RuntimeMaterialBinding', { material: 'asset<material>' });
const material = (roughness = 1): MaterialRootAsset => ({
  kind: 'material',
  passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
  values: { roughness, metallic: 0 },
});
const guid = '630f7c5c-1c41-4979-9bed-4e6b6045f680';

function publish(
  assets: AssetRegistry,
  entries: readonly { guid: string; asset: Asset; refs?: readonly string[] }[],
) {
  assets.installDecoder(materialContribution.kind, materialContribution.decoder);
  assets.installDecoder(textureContribution.kind, textureContribution.decoder);
  const packageUrl = 'https://runtime-assets.invalid/pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'assets.pack',
    sourceRevision: 'fixture',
    packageUrl,
    pack: {
      assets: entries.map(({ guid, asset, refs }) => ({
        guid,
        kind: asset.kind,
        payload: asset,
        refs: refs ?? [],
        artifacts: {},
      })),
    },
  });
  const body = JSON.stringify(publication.pack, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, asset }) => ({
        guid,
        kind: asset.kind,
        packageUrl,
        sourcePath: 'assets.pack',
        publication: publication.publication,
      })),
      fetch: async () => new Response(body),
    }),
  );
}

describe('runtime Registry content', () => {
  test('rejects a second World attachment and closed-owner attachment', () => {
    const assets = new AssetRegistry();
    const first = new World({ assets });
    expect(first.bindAssets(assets).ok).toBe(true);
    expect(() => new World({ assets })).toThrow();
    assets.dispose();
    expect(new World().bindAssets(assets).ok).toBe(false);
  });

  test('rejects uncooked static changes without committing content or change evidence', () => {
    const assets = new AssetRegistry();
    const observer = assets.observe().unwrap();
    const invalid = { ...material(), staticSwitches: { transmission: true } } as MaterialAsset;
    expect(assets.create(invalid)).toMatchObject({
      ok: false,
      error: { code: 'material-specialization-not-cooked' },
    });
    expect(runtimeAssets(assets).inspect().assets).toBe(0);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    const reference = assets.create(material()).unwrap();
    observer.read().unwrap().accept();
    expect(assets.update(reference, { staticSwitches: { transmission: true } })).toMatchObject({
      ok: false,
      error: { code: 'material-specialization-not-cooked' },
    });
    expect(assets.read(reference).unwrap().staticSwitches).toBeUndefined();
    expect(observer.read().unwrap().changes).toHaveLength(0);
  });

  test('validates numeric parameters before a material write is accepted', () => {
    const assets = new AssetRegistry();
    const reference = assets
      .create({
        ...material(),
        parameters: [
          { name: 'roughness', type: 'f32' },
          { name: 'metallic', type: 'u32' },
        ],
      } as MaterialAsset)
      .unwrap();
    for (const values of [
      { roughness: NaN },
      { roughness: Infinity },
      { metallic: -1 },
      { metallic: 0.5 },
    ]) {
      expect(assets.update(reference, { values }).ok).toBe(false);
      expect(assets.read(reference).unwrap().values).toEqual({ roughness: 1, metallic: 0 });
    }
  });

  test('creates directly bindable references without a Catalog or renderer', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const reference = assets.create(material()).unwrap();
    const entity = world.spawn({ component: Binding, data: { material: reference } }).unwrap();
    assets.release(reference).unwrap();
    assets.update(reference, { values: { roughness: 0.2 } }).unwrap();
    expect(assets.read(reference).unwrap().values).toEqual({ roughness: 0.2, metallic: 0 });
    expect(world.get(entity, Binding).unwrap().material).toBe(reference);
    world.despawn(entity).unwrap();
    expect(assets.read(reference).ok).toBe(false);
  });

  test('repeated source loads preserve runtime identity and edits', async () => {
    const assets = new AssetRegistry();
    publish(assets, [{ guid, asset: material() }]);
    const first = (await assets.load(guid, 'material')).unwrap();
    assets.update(first, { values: { roughness: 0.3 } }).unwrap();
    publish(assets, [{ guid, asset: material(0.9) }]);
    const second = (await assets.load(guid, 'material')).unwrap();
    expect(second).toBe(first);
    expect(assets.read(second).unwrap().values?.roughness).toBe(0.3);
    assets.release(first).unwrap();
    assets.release(second).unwrap();
  });

  test('copies and owners isolate current content and detached reads', () => {
    const a = new AssetRegistry();
    const b = new AssetRegistry();
    const first = a.create(material()).unwrap();
    const copy = a.copy(first).unwrap();
    a.update(first, { values: { roughness: 0.1 } }).unwrap();
    expect(a.read(copy).unwrap().values?.roughness).toBe(1);
    expect(b.update(first, { values: { roughness: 0.8 } }).ok).toBe(false);
    const read = a.read(first).unwrap();
    (read.values as Record<string, unknown>).roughness = 0.5;
    expect(a.read(first).unwrap().values?.roughness).toBe(0.1);
  });

  test('commits a numeric field group without replacing untouched values or re-resolving programs', () => {
    const assets = new AssetRegistry();
    const reference = assets
      .create({
        ...material(),
        parameters: [
          { name: 'roughness', type: 'f32' },
          { name: 'metallic', type: 'u32' },
          { name: 'tint', type: 'vec4' },
          { name: 'direction', type: 'vec3' },
        ],
        values: { roughness: 1, metallic: 0, tint: [1, 0, 0, 1], direction: [0, 1, 0] },
      } as MaterialAsset)
      .unwrap();
    const current = runtimeAssets(assets).borrow<MaterialAsset>(reference).unwrap();
    const priorValues = current.values;
    const direction = current.values?.direction;
    const fixed = assets.snapshot(reference).unwrap();
    const observer = assets.observe().unwrap();
    const revision = runtimeAssets(assets).version(reference).unwrap();
    const tint = [0, 1, 0, 1];
    assets.update(reference, { values: { roughness: 0.25, tint } }).unwrap();
    tint.fill(9);
    expect(current.values).toBe(priorValues);
    expect(current.values?.direction).toBe(direction);
    expect(assets.read(reference).unwrap().values).toEqual({
      roughness: 0.25,
      metallic: 0,
      tint: [0, 1, 0, 1],
      direction: [0, 1, 0],
    });
    expect(runtimeAssets(assets).version(reference).unwrap()).toBe(revision + 1);
    expect(observer.read().unwrap().changes).toMatchObject([
      { handle: reference, fields: ['values'], ranges: [] },
    ]);
    expect(fixed.read<MaterialAsset>(reference).unwrap().values?.roughness).toBe(1);
    observer.read().unwrap().accept();
    for (const values of [
      { roughness: 0.8, metallic: -1 },
      { tint: [1, undefined, 1, 1] },
      { unknown: 1 },
    ]) {
      expect(assets.update(reference, { values } as never).ok).toBe(false);
      expect(current.values?.roughness).toBe(0.25);
      expect(observer.read().unwrap().changes).toHaveLength(0);
    }
    fixed.dispose();
    assets.dispose();
  });

  test('complete replacement removes old fields, preserves bindings and snapshots, and refreshes validation', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const reference = assets
      .create({ ...material(), colorSpace: 'linear' } as MaterialAsset)
      .unwrap();
    const entity = world.spawn({ component: Binding, data: { material: reference } }).unwrap();
    const fixed = assets.snapshot(reference).unwrap();
    const observer = assets.observe().unwrap();
    assets
      .replace(reference, {
        kind: 'material',
        passes: material().passes,
        parameters: [{ name: 'count', type: 'u32' }],
        values: { count: 2 },
      } as MaterialAsset)
      .unwrap();
    expect(world.get(entity, Binding).unwrap().material).toBe(reference);
    const read = assets.read(reference).unwrap();
    expect(Object.hasOwn(read, 'colorSpace')).toBe(false);
    expect(read.values).toEqual({ count: 2 });
    expect(fixed.read<MaterialAsset>(reference).unwrap().colorSpace).toBe('linear');
    observer.read().unwrap().accept();
    expect(assets.update(reference, { values: { count: -1 } }).ok).toBe(false);
    expect(assets.update(reference, { values: { roughness: 0.5 } }).ok).toBe(false);
    expect(assets.replace(reference, { kind: 'texture' } as never).ok).toBe(false);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    assets.update(reference, { values: { count: 3 } }).unwrap();
    expect(assets.read(reference).unwrap().values).toEqual({ count: 3 });
    fixed.dispose();
    assets.dispose();
  });

  test('replacing material content transfers dependency holds and preserves failure atomicity', () => {
    const assets = new AssetRegistry();
    const texture = assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array([1, 2, 3, 255]),
      } as const)
      .unwrap();
    const reference = assets.create({ ...material(), values: { albedo: { texture } } }).unwrap();
    assets.release(texture).unwrap();
    const fixed = assets.snapshot(reference).unwrap();
    const observer = assets.observe().unwrap();
    expect(
      // @ts-expect-error Runtime admission also rejects a material passed as a texture.
      assets.replace(reference, { ...material(), values: { albedo: { texture: reference } } }).ok,
    ).toBe(false);
    expect(assets.read(texture).ok).toBe(true);
    expect(observer.read().unwrap().changes).toHaveLength(0);
    assets.replace(reference, material(0.25)).unwrap();
    expect(assets.read(texture).ok).toBe(false);
    expect(fixed.read<{ data: Uint8Array }>(texture).unwrap().data[0]).toBe(1);
    fixed.dispose();
    assets.dispose();
  });

  test('adopts complete material inheritance and never consults it during runtime reads', async () => {
    const assets = new AssetRegistry();
    publish(assets, [{ guid, asset: material() }]);
    (await assets.load(guid, 'material')).unwrap();
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw parsed.error;
    const child = assets
      .create({ kind: 'material', parent: parsed.value, values: { roughness: 0.2 } })
      .unwrap();
    expect(assets.read(child).unwrap().parent).toBeUndefined();
    expect(assets.read(child).unwrap().values).toEqual({ roughness: 0.2, metallic: 0 });
    publish(assets, [{ guid, asset: material(0.8) }]);
    const before = runtimeAssets(assets).version(child).unwrap();
    expect(assets.read(child).unwrap().values?.roughness).toBe(0.2);
    expect(runtimeAssets(assets).version(child).unwrap()).toBe(before);
  });

  test('source adoption captures the versions of resource dependencies', async () => {
    const assets = new AssetRegistry();
    const textureGuid = '00000000-0000-4000-8000-000000000001';
    publish(assets, [
      {
        guid: textureGuid,
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          data: new Uint8Array([255, 255, 255, 255]),
          colorSpace: 'linear',
          mips: { kind: 'none' },
        },
      },
      {
        guid,
        asset: {
          ...material(),
          values: { albedo: { texture: textureGuid } },
        },
        refs: [textureGuid],
      },
    ]);
    const root = (await assets.load(guid, 'material')).unwrap();
    const texture = (await assets.load(textureGuid, 'texture')).unwrap();
    expect(assets.read(root).unwrap().values?.albedo).toEqual({ texture });
    const snapshot = assets.snapshot(root).unwrap();
    const before = runtimeAssets(assets).version(root).unwrap();
    assets.update(texture, { data: new Uint8Array([0, 0, 0, 255]) }).unwrap();
    expect(runtimeAssets(assets).version(root).unwrap()).toBe(before);
    expect(snapshot.matchesCurrent()).toBe(false);
    expect(snapshot.read<{ data: Uint8Array }>(texture).unwrap().data[0]).toBe(255);
    snapshot.dispose();
    assets.dispose();
    expect(assets.read(root).ok).toBe(false);
    expect(assets.create(material()).ok).toBe(false);
  });

  test.each([
    'shorthand',
    'descriptor',
  ] as const)('retains %s texture bindings and atomically replaces their holds', (form) => {
    const assets = new AssetRegistry();
    const texture = () =>
      assets
        .create({
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data: new Uint8Array([255, 255, 255, 255]),
        } as const)
        .unwrap();
    const first = texture();
    const second = texture();
    const binding = (texture: import('@forgeax/engine-types').AssetHandle<'texture'>) =>
      form === 'shorthand' ? texture : { texture };
    const root = assets
      .create({
        ...material(),
        parameters: [{ name: 'albedo', type: 'texture' }],
        values: { albedo: binding(first) },
      } as MaterialAsset)
      .unwrap();
    assets.release(first).unwrap();
    const fixed = assets.snapshot(root).unwrap();
    assets.update(root, { values: { albedo: binding(second) } }).unwrap();
    expect(assets.read(first).ok).toBe(false);
    expect(fixed.read<{ data: Uint8Array }>(first).unwrap().data[0]).toBe(255);
    // @ts-expect-error Runtime admission also rejects a material passed as a texture.
    expect(assets.update(root, { values: { albedo: binding(root) } }).ok).toBe(false);
    expect(assets.read(root).unwrap().values?.albedo).toEqual(binding(second));
    assets.release(second).unwrap();
    expect(assets.read(second).ok).toBe(true);
    assets
      .replace(root, {
        ...material(),
        parameters: [{ name: 'albedo', type: 'f32' }],
        values: { albedo: 0.5 },
      })
      .unwrap();
    expect(runtimeAssets(assets).dependencies(root).unwrap()).toEqual([]);
    expect(assets.read(second).ok).toBe(false);
    assets.release(root).unwrap();
    expect(assets.read(second).ok).toBe(false);
    fixed.dispose();
  });
});
