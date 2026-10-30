import { createBoxGeometry } from '@forgeax/engine-geometry';
import * as packRuntime from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../index';
import { runtimeAssets } from '../internal';
import { materialRecordFixture } from './fixtures/material-publication';
import { prepareRuntimeAssetPublication } from './fixtures/runtime-publication';

it('installs prepared wire bytes into independent runtime sources and decoded payloads', async () => {
  const guid = '01900000-0000-7000-8000-000000000abc';
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const install = prepareRuntimeAssetPublication([{ guid, asset: mesh }]);
  const first = new AssetRegistry(),
    second = new AssetRegistry();
  try {
    install(first);
    install(second);
    const firstHandle = (await first.load(guid, 'mesh')).unwrap();
    const secondHandle = (await second.load(guid, 'mesh')).unwrap();
    const a = runtimeAssets(first).resolveAsset<typeof mesh>(firstHandle).unwrap();
    const b = runtimeAssets(second).resolveAsset<typeof mesh>(secondHandle).unwrap();
    expect(a).not.toBe(b);
    expect(a.attributes.position).toBeInstanceOf(Float32Array);
    expect(b.attributes.position).toEqual(a.attributes.position);
    expect(b.attributes.position).not.toBe(a.attributes.position);
    first.dispose();
    expect((await second.load(guid, 'mesh')).unwrap()).toBe(secondHandle);
    expect(runtimeAssets(second).resolveAsset(secondHandle).ok).toBe(true);
  } finally {
    first.dispose();
    second.dispose();
  }
});

it('losslessly tables fixture programs while retaining independent real decode and adoption', async () => {
  const publication = vi.spyOn(packRuntime, 'createRuntimePackPublication');
  const first = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const second = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const firstSources = vi.spyOn(first, 'setCatalogSource');
  const secondSources = vi.spyOn(second, 'setCatalogSource');
  try {
    const records = [
      '01900000-0000-7000-8000-000000000a01',
      '01900000-0000-7000-8000-000000000a02',
    ].map((guid, index) =>
      materialRecordFixture({
        guid,
        generation: 1,
        passes: [{ name: 'Forward', program: { module: `game::shared${'x'.repeat(1024)}` } }],
        parameters: [{ name: 'roughness', type: 'f32' }],
        values: { roughness: 0.3 + index * 0.2 },
      }),
    );
    const entries = records.map((record, index) => ({
      guid: record.guid,
      asset: {
        kind: 'material' as const,
        passes: record.resolved.passes,
        parameters: record.parameterContract.parameters,
        values: { roughness: 0.3 + index * 0.2 },
        cooked: record,
      },
    }));
    const json = vi.spyOn(JSON, 'stringify');
    let install: ReturnType<typeof prepareRuntimeAssetPublication>;
    try {
      install = prepareRuntimeAssetPublication(entries);
      const transport = json.mock.calls.filter(
        ([value]) => value?.schemaVersion === 'pack-material-programs/2',
      );
      expect(transport).toHaveLength(1);
      expect(transport[0]?.[1]).toBeUndefined();
    } finally {
      json.mockRestore();
    }
    install(first);
    install(second);
    const firstSource = firstSources.mock.calls[0]?.[0];
    const secondSource = secondSources.mock.calls[0]?.[0];
    if (firstSource === undefined || secondSource === undefined)
      throw Error('missing fixture source');
    expect(firstSource).not.toBe(secondSource);
    const rows = (await firstSource.enumerate()).unwrap();
    const packageUrl = rows[0]?.packageUrl;
    if (packageUrl === undefined) throw Error('missing fixture package URL');
    const fetchFirst = firstSource.openPackage?.(packageUrl);
    const fetchSecond = secondSource.openPackage?.(packageUrl);
    if (fetchFirst === undefined || fetchSecond === undefined)
      throw Error('missing fixture transport');
    const firstResponse = await fetchFirst(packageUrl);
    const secondResponse = await fetchSecond(packageUrl);
    expect(firstResponse).not.toBe(secondResponse);
    const body = await firstResponse.text();
    expect(await secondResponse.text()).toBe(body);
    const produced = publication.mock.results[0];
    if (produced?.type !== 'return') throw Error('missing producer publication');
    const original = produced.value;
    const expanded = JSON.stringify(original.pack, (_key, value) =>
      ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
    );
    const wire = JSON.parse(body);
    expect(wire.schemaVersion).toBe('pack-material-programs/2');
    expect(wire.programs).toHaveLength(1);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(
      new TextEncoder().encode(expanded).byteLength,
    );
    expect(packRuntime.decodeMaterialProgramWire(wire).unwrap()).toEqual(JSON.parse(expanded));
    for (const [index, record] of records.entries()) {
      const firstHandle = (await first.load(record.guid, 'material')).unwrap();
      const secondHandle = (await second.load(record.guid, 'material')).unwrap();
      const a = runtimeAssets(first).resolveAsset(firstHandle).unwrap();
      const b = runtimeAssets(second).resolveAsset(secondHandle).unwrap();
      expect(a).not.toBe(b);
      expect(a).toMatchObject({ kind: 'material', values: { roughness: 0.3 + index * 0.2 } });
      expect(b).toEqual(a);
      first.update(firstHandle, { values: { roughness: 0.9 } }).unwrap();
      expect(runtimeAssets(second).resolveAsset(secondHandle).unwrap()).toMatchObject({
        values: { roughness: 0.3 + index * 0.2 },
      });
    }
    const indices = wire.pack.assets[0]?.payload.cooked.programs;
    if (!Array.isArray(indices)) throw Error('missing compact program indices');
    indices[0] = wire.programs.length + 1;
    expect(packRuntime.decodeMaterialProgramWire(wire).ok).toBe(false);
  } finally {
    firstSources.mockRestore();
    secondSources.mockRestore();
    publication.mockRestore();
    first.dispose();
    second.dispose();
  }
});
