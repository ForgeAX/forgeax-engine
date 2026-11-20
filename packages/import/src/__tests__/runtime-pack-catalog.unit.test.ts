import { type CatalogDelta, ok, type SamplerAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { prepareRuntimePackContent, RuntimePackProducer } from '../runtime-pack';

it('shares one publication within each Runtime Pack Catalog copy', async () => {
  const sampler: SamplerAsset = { kind: 'sampler' };
  const producer = new RuntimePackProducer({
    scopeId: 'runtime-pack-catalog-copy',
    validate: async (state) => ok(new Map(state.rows.map((row) => [row.guid, sampler]))),
  });
  try {
    const first: CatalogDelta[] = [];
    const second: CatalogDelta[] = [];
    producer.catalog.subscribe((delta) => first.push(delta));
    producer.catalog.subscribe((delta) => second.push(delta));
    const content = (
      await prepareRuntimePackContent('01900000-0000-7000-8000-000000000199', {
        near: sampler,
        far: { ...sampler, minFilter: 'linear' },
      })
    ).unwrap();
    const receipt = (await producer.admit(content)).unwrap();
    const rows = (await producer.catalog.enumerate()).unwrap();
    const firstCopy = first[0]?.added[0]?.publication;
    const secondCopy = second[0]?.added[0]?.publication;
    const enumerated = rows[0]?.publication;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.added).toEqual(receipt.rows);
    expect(second[0]?.added).toEqual(receipt.rows);
    expect(rows).toEqual(receipt.rows);
    expect(firstCopy).toBeDefined();
    expect(firstCopy).toBe(first[0]?.added[1]?.publication);
    expect(secondCopy).toBe(second[0]?.added[1]?.publication);
    expect(enumerated).toBe(rows[1]?.publication);
    expect(firstCopy).not.toBe(secondCopy);
    expect(firstCopy).not.toBe(receipt.publication);
    expect(enumerated).not.toBe((await producer.catalog.enumerate()).unwrap()[0]?.publication);
    Object.assign(firstCopy ?? {}, { digest: 'changed by listener' });
    expect(secondCopy?.digest).toBe(receipt.publication?.digest);
    expect(producer.rows()[0]?.publication?.digest).toBe(receipt.publication?.digest);
  } finally {
    producer.dispose();
  }
});
