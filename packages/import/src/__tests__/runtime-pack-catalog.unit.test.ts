import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { type CatalogDelta, ok, type SamplerAsset } from '@forgeax/engine-types';
import { expect, it, onTestFinished } from 'vitest';
import { prepareRuntimePackContent, RuntimePackProducer } from '../runtime-pack';
import { parseRuntimePackContent, runtimeGeneratorDefinition } from '../runtime-pack-content';

it('reads saved generator metadata with the retired build option', () => {
  const artifact = preparePackProgram({
    entry: 'entry.js',
    export: 'generate',
    modules: { 'entry.js': 'export const generate = () => ({ ok: true, value: {} });' },
  }).unwrap();
  const runtime = { dependencies: [], export: 'generate', outputs: { mesh: 'mesh' } } as const;
  const saved = {
    source: {
      schemaVersion: '2.0.0',
      kind: 'scriptable-pack-source',
      source: 'entry.js',
      program: 'generator',
      packageId: '01900000-0000-7000-8000-000000000198',
      runtime: { ...runtime, execution: 'task-worker', fallback: 'build' },
    },
    programs: { generator: { artifact } },
  } as const;
  const loaded = parseRuntimePackContent(saved);
  expect(loaded).toEqual(saved);
  const { source } = loaded;
  if (!('kind' in source) || source.kind !== 'scriptable-pack-source')
    throw new Error('Expected a generator');
  const executable = runtimeGeneratorDefinition(source, () => ok({}));
  expect(executable.runtime).toEqual({ ...runtime, execution: 'task-worker' });
});

it.each([
  true,
  false,
])('shares one publication within each Runtime Pack Catalog copy (pinned=%s)', async (pin) => {
  const sampler: SamplerAsset = { kind: 'sampler' };
  const producer = new RuntimePackProducer({
    scopeId: 'runtime-pack-catalog-copy',
    validate: async (state) => ok(new Map(pin ? state.rows.map((row) => [row.guid, sampler]) : [])),
  });
  onTestFinished(() => producer.dispose());
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
  const [entry] = receipt.rows;
  if (!entry) throw new Error('Runtime Pack did not publish a Catalog row');
  const selected = producer.catalogRow(entry.guid.toUpperCase());
  expect(selected).toEqual(entry);
  expect(selected).not.toBe(entry);
  Object.assign(selected?.publication ?? {}, { digest: 'changed by lookup consumer' });
  expect(producer.catalogRow(entry.guid)).toEqual(entry);
  producer.withdraw(content.source.packageId);
  expect(producer.catalogRow(entry.guid)).toBeUndefined();
});
