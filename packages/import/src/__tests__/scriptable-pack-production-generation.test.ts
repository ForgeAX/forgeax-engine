import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  createScriptablePackProduction,
  type ScriptablePackInput,
} from '../scriptable-pack-host.js';

function input(definition: ScriptablePackInput['definition'], name: string) {
  return {
    definition,
    sourcePath: name,
    displaySourcePath: name,
    sourceKeys: ['scene'],
    sourceClosure: [],
    publicationGeneration: 1,
    policy: {
      base: '/',
      packagePath: `${name}.json`,
      artifactPath: (guid: string, key: string) => `${guid}/${key}`,
    },
  };
}

it('reuses successful evaluation and production across inspection, dependency reads and Cook', async () => {
  const childId = definePackageId('01900000-0000-7000-8000-000000007101');
  const childGuid = AssetGuid.derive(childId, 'scene');
  let children = 0,
    parents = 0;
  const child = definePack({
    schemaVersion: '2.0.0',
    packageId: childId,
    build() {
      children++;
      return ok({ scene: { kind: 'scene' as const, entities: {} } });
    },
  });
  const parent = definePack({
    schemaVersion: '2.0.0',
    packageId: definePackageId('01900000-0000-7000-8000-000000007102'),
    async build(context) {
      parents++;
      const read = await context.readByGuid(childGuid);
      if (!read.ok) return read;
      return ok({ scene: { kind: 'scene' as const, entities: {} } });
    },
  });
  const generation = createScriptablePackProduction({
    sources: [input(parent, 'parent'), input(child, 'child')],
  });
  expect((await generation.inspect('parent')).ok).toBe(true);
  const [first, second, dependency] = await Promise.all([
    generation.produce('parent'),
    generation.produce('parent'),
    generation.produce('child'),
  ]);
  expect(first.ok && second.ok && dependency.ok).toBe(true);
  expect(first).toBe(second);
  expect({ children, parents }).toEqual({ children: 1, parents: 1 });
  if (!first.ok) throw first.error;
  expect(first.value.publication.externalEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ guid: AssetGuid.format(childGuid), usage: 'content' }),
    ]),
  );
  expect(
    (await createScriptablePackProduction({ sources: [input(child, 'child')] }).produce('child'))
      .ok,
  ).toBe(true);
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
  expect(
    (
      await createScriptablePackProduction({ sources: [input(definition, 'subject')] }).produce(
        'subject',
      )
    ).ok,
  ).toBe(true);
  const changed = createScriptablePackProduction({
    sources: [{ ...input(definition, 'subject'), values: { enabled: false } }],
  });
  expect(await changed.produce('subject')).toMatchObject({
    ok: false,
    error: { code: 'pack-source-output-invalid' },
  });
});

it('rejects concurrent content cycles instead of waiting on another root indefinitely', async () => {
  const ids = [
    definePackageId('01900000-0000-7000-8000-000000007104'),
    definePackageId('01900000-0000-7000-8000-000000007105'),
  ];
  let entered = 0;
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sources = ids.map((packageId, index) =>
    input(
      definePack({
        schemaVersion: '2.0.0',
        packageId,
        async build(context) {
          if (++entered === 2) release();
          await bothEntered;
          const other = ids[1 - index];
          if (other === undefined) throw new Error('missing cycle fixture');
          const read = await context.readByGuid(AssetGuid.derive(other, 'scene'));
          return read.ok ? ok({ scene: { kind: 'scene' as const, entities: {} } }) : read;
        },
      }),
      `cycle-${index}`,
    ),
  );
  const generation = createScriptablePackProduction({ sources });
  const results = await Promise.all(
    sources.map((source) => generation.produce(source.displaySourcePath)),
  );
  for (const result of results)
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-content-dependency-stalled' } });
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
    definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000007107'),
      async build(context) {
        const value = await context.readByGuid(externalGuid);
        return value.ok ? ok({ scene: { kind: 'scene' as const, entities: {} } }) : value;
      },
    }),
    'parent',
  );
  expect(
    (await createScriptablePackProduction({ sources: [parent], assetSource }).produce('parent')).ok,
  ).toBe(true);
  expect(reads).toBe(1);
  const failed = input(
    definePack({
      schemaVersion: '2.0.0',
      packageId: externalId,
      build() {
        throw new Error('broken local owner');
      },
    }),
    'failed',
  );
  expect(
    (
      await createScriptablePackProduction({ sources: [parent, failed], assetSource }).produce(
        'parent',
      )
    ).ok,
  ).toBe(false);
  expect(reads).toBe(1);
});

it('uses the same non-default generation for material receipts and the accepted publication', async () => {
  const material = {
    kind: 'material' as const,
    passes: [{ name: 'forward', program: { module: 'game::surface' } }] as const,
    parameters: [],
  };
  const definition = definePack({
    schemaVersion: '2.0.0',
    packageId: definePackageId('01900000-0000-7000-8000-000000007108'),
    build: () => ok({ material }),
  });
  let observedGeneration: number | undefined;
  const production = createScriptablePackProduction({
    sources: [
      { ...input(definition, 'material'), sourceKeys: ['material'], publicationGeneration: 7 },
    ],
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
  expect((await production.inspect('material')).ok).toBe(true);
  expect(observedGeneration).toBe(7);
  const result = await production.produce('material');
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.publication.generation).toBe(7);
});
