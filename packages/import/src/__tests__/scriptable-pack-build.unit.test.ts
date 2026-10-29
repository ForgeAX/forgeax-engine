import {
  AssetGuid,
  definePack,
  definePackageId,
  PackageId,
  validatePluginAssetSource,
} from '@forgeax/engine-pack/source';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ScriptablePackAssetSnapshotSource } from '../scriptable-pack.js';
import { AssetOutputProducerRegistry } from '../scriptable-pack.js';
import { buildScriptablePack, buildScriptablePackWorklist } from '../scriptable-pack-build.js';
import { produceScriptablePackProducts } from '../scriptable-pack-host.js';
import { materialAssetOutputProducer } from '../scriptable-pack-output-producers.js';

function id(value: string) {
  const result = PackageId.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
}

function scene() {
  return { kind: 'scene' as const, entities: {} };
}

function producers() {
  const registry = new AssetOutputProducerRegistry();
  registry.register({
    kind: 'scene',
    version: 'test',
    produce: ({ asset }) => ok({ payload: asset as never, refs: [], artifacts: {} }),
  });
  return registry;
}

describe('ScriptablePack import bridge with optional parameters', () => {
  it('omits plugin output without its explicit capability before producer dispatch', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: id('01900000-0000-7000-8000-000000000077'),
      build: () =>
        ok({
          'plugin/main': { kind: 'plugin', module: { specifier: './runtime.ts' } },
          'scene/main': scene(),
        }),
    });
    const result = await buildScriptablePack({
      definition,
      sourcePath: 'unmarked.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        product: { assets: [{ kind: 'scene' }] },
        stagedOutputs: [{ sourceKey: 'scene/main' }],
      },
    });
  });
  it('rebuilds cached plugin output without its explicit capability', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: id('01900000-0000-7000-8000-000000000078'),
      build: () =>
        ok({
          'plugin/main': { kind: 'plugin', module: { specifier: './runtime.ts' } },
          'scene/main': scene(),
        }),
    });
    let written: unknown;
    const result = await buildScriptablePackWorklist({
      subjects: [{ definition, sourcePath: 'cached.pack.ts' }],
      outputs: producers(),
      cache: {
        read: async () =>
          ({
            product: { assets: [{ kind: 'plugin' }] },
            stagedOutputs: [],
            externalEvidence: [],
            inputFingerprint: 'cached',
          }) as never,
        write: async (_subject, value) => {
          written = value;
        },
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(written).toMatchObject({
      product: { assets: [{ kind: 'scene' }] },
      stagedOutputs: [{ sourceKey: 'scene/main' }],
    });
  });
  it('refills an idle lane before a slow earlier subject completes, with bounded lookahead', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: string[] = [];
    const subjects = ['a', 'b', 'c', 'd', 'e'].map((name, index) => ({
      sourcePath: `assets/${name}.pack.ts`,
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId(`01900000-0000-7000-8000-00000000012${index}`),
        async build() {
          entered.push(name);
          if (name === 'a') await gate;
          return ok({ [`scene/${name}`]: scene() });
        },
      }),
    }));
    const pending = buildScriptablePackWorklist({
      subjects,
      outputs: producers(),
      maxConcurrency: 2,
    });
    try {
      await expect.poll(() => [...entered]).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      release();
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.value.stagedOutputs.map((output) => output.sourceKey)).toEqual(
          ['a', 'b', 'c', 'd', 'e'].map((name) => `scene/${name}`),
        );
    }
  });

  it('bounds concurrent subjects and publishes them in source order', async () => {
    let active = 0,
      peak = 0;
    const entered: string[] = [];
    let release!: () => void, paired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pair = new Promise<void>((resolve) => {
      paired = resolve;
    });
    const subjects = ['a', 'b', 'c'].map((name, index) => ({
      sourcePath: `assets/${name}.pack.ts`,
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId(`01900000-0000-7000-8000-00000000010${index}`),
        async build() {
          entered.push(name);
          active++;
          peak = Math.max(peak, active);
          if (active === 2) paired();
          try {
            await gate;
            return ok({ [`scene/${name}`]: scene() });
          } finally {
            active--;
          }
        },
      }),
    }));
    const pending = buildScriptablePackWorklist({
      subjects,
      outputs: producers(),
      maxConcurrency: 2,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pair,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      expect([...entered]).toEqual(['a', 'b']);
      expect(peak).toBe(2);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.value.stagedOutputs.map((output) => output.sourceKey)).toEqual([
          'scene/a',
          'scene/b',
          'scene/c',
        ]);
    }
  });

  it('reports real per-source cache/cook progress without counting a lookup as completed work', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000099'),
      build: () => ok({ 'scene/main': scene() }),
    });
    const options = { definition, sourcePath: 'progress.pack.ts', outputs: producers() };
    const built = await buildScriptablePack(options);
    if (!built.ok) throw built.error;
    for (const hit of [false, true]) {
      const events: Array<{ phase: string; completed: number; total: number; cache?: string }> = [];
      const result = await buildScriptablePackWorklist({
        subjects: [{ definition, sourcePath: options.sourcePath }],
        outputs: producers(),
        cache: {
          async read() {
            return hit ? built.value : undefined;
          },
          async write() {},
        },
        onProgress: (event) => events.push(event),
      });
      expect(result.ok).toBe(true);
      expect(events.map((event) => event.phase)).toEqual(
        hit ? ['cache', 'ready'] : ['cache', 'cook', 'persist', 'ready'],
      );
      expect(events.slice(0, -1).every((event) => event.completed === 0 && event.total === 1)).toBe(
        true,
      );
      expect(events.at(-1)).toMatchObject({ completed: 1, total: 1, cache: hit ? 'hit' : 'miss' });
    }
  });

  it('cooks parameterized custom sources alongside ordinary Assets with derived identity and references', async () => {
    const packageId = definePackageId('01900000-0000-7000-8000-000000000049');
    const sceneGuid = AssetGuid.format(AssetGuid.derive(packageId, 'scene/main'));
    const shapeGuid = AssetGuid.format(AssetGuid.derive(packageId, 'shape/custom'));
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      parameters: [{ name: 'count', type: 'u32', default: 2, minimum: 1 }] as const,
      build: ({ values }) =>
        ok({
          'scene/main': scene(),
          'shape/custom': {
            kind: 'test-volume',
            execution: 'cooked',
            source: { count: values.count, reference: sceneGuid },
          },
        }),
    });
    const inputs: unknown[] = [];
    const cooker = {
      key: 'test-volume',
      cook(raw: unknown) {
        inputs.push(raw);
        const input = raw as { guid: string; source: { count: number; reference: string } };
        return {
          guid: input.guid,
          payload: { kind: 'test-volume', count: input.source.count },
          refs: [input.source.reference],
          artifacts: {
            body: {
              mediaType: 'application/octet-stream',
              bytes: new Uint8Array(input.source.count),
            },
          },
          inputFingerprint: `test-count:${input.source.count}`,
        };
      },
    };
    const options = {
      definition,
      sourcePath: 'assets/custom.pack.ts',
      outputs: producers(),
      availableGuids: new Set<string>(),
    };
    const missing = await buildScriptablePack(options);
    expect(missing).toMatchObject({ ok: false, error: { code: 'native-cook-failed' } });
    const first = await buildScriptablePack({
      ...options,
      cookers: [cooker],
      values: { count: 3 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(inputs).toEqual([
      {
        guid: shapeGuid,
        sourceKey: 'shape/custom',
        sourcePath: 'assets/custom.pack.ts',
        source: { count: 3, reference: sceneGuid },
        refs: [],
      },
    ]);
    const output = first.value.product.assets.find((asset) => asset.guid === shapeGuid);
    expect(output).toMatchObject({
      kind: 'test-volume',
      payload: { kind: 'test-volume', count: 3 },
      refs: [{ guid: sceneGuid }],
      artifacts: { body: { bytes: new Uint8Array(3) } },
    });
    expect(first.value.stagedOutputs.map((output) => output.sourceKey)).toEqual([
      'scene/main',
      'shape/custom',
    ]);
    const second = await buildScriptablePack({
      ...options,
      cookers: [cooker],
      values: { count: 4 },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(
      second.value.product.assets.find((asset) => asset.guid === shapeGuid)?.artifacts.body?.bytes,
    ).toEqual(new Uint8Array(4));
    expect(second.value.inputFingerprint).not.toBe(first.value.inputFingerprint);
    const wrongIdentity = await buildScriptablePack({
      ...options,
      cookers: [
        {
          ...cooker,
          cook(raw: unknown) {
            return { ...cooker.cook(raw), guid: sceneGuid };
          },
        },
      ],
    });
    expect(wrongIdentity).toMatchObject({
      ok: false,
      error: { code: 'pack-source-output-invalid' },
    });
    const published = await produceScriptablePackProducts({
      sources: [
        {
          definition,
          sourcePath: options.sourcePath,
          displaySourcePath: options.sourcePath,
          sourceClosure: [],
          publicationGeneration: 1,
          values: { count: 3 },
          policy: {
            base: '/',
            packagePath: 'assets/custom.pack.json',
            artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
          },
        },
      ],
      cookers: [cooker],
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw published.error;
    const prepared = published.value.get(options.sourcePath);
    if (prepared === undefined) throw new Error('custom source was not published');
    expect(prepared.facts.outputs).toContainEqual(
      expect.objectContaining({ guid: shapeGuid, sourceKey: 'shape/custom', kind: 'test-volume' }),
    );
    expect(
      prepared.finalized.pack.assets.find((asset) => asset.guid === shapeGuid)?.artifacts?.body,
    ).toMatchObject({ byteLength: 3, integrity: { algorithm: 'sha256' } });
  });

  it('uses the subject packageId and dynamic sourceKey output map', async () => {
    const packageId = definePackageId('01900000-0000-7000-8000-000000000040');
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      parameters: [{ name: 'count', type: 'u32', default: 1, minimum: 1 }] as const,
      build: ({ values }) =>
        ok(
          Object.fromEntries(
            Array.from({ length: values.count }, (_, index) => [`scene/${index}`, scene()]),
          ),
        ),
    });
    const result = await buildScriptablePack({
      definition,
      sourcePath: 'assets/param.pack.ts',
      values: { count: 2 },
      outputs: producers(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.product.assets.map((asset) => asset.guid)).toEqual([
      AssetGuid.format(AssetGuid.derive(packageId, 'scene/0')),
      AssetGuid.format(AssetGuid.derive(packageId, 'scene/1')),
    ]);
    expect(result.value.stagedOutputs.map((output) => output.sourceKey)).toEqual([
      'scene/0',
      'scene/1',
    ]);
  });

  it.each([
    1, 2,
  ])('retries forward content reads with %s admitted subjects', async (maxConcurrency) => {
    const firstId = id('01900000-0000-7000-8000-000000000050');
    const secondId = id('01900000-0000-7000-8000-000000000051');
    const first = definePack({
      schemaVersion: '2.0.0',
      packageId: firstId,
      build: () => ok({ 'scene/first': scene() }),
    });
    const dependencyGuid = AssetGuid.derive(firstId, 'scene/first');
    const second = definePack({
      schemaVersion: '2.0.0',
      packageId: secondId,
      build: async ({ readByGuid }) => {
        const dependency = await readByGuid(dependencyGuid);
        if (!dependency.ok) return err(dependency.error);
        return ok({ 'scene/second': scene() });
      },
    });
    const result = await buildScriptablePackWorklist({
      subjects: [
        // Keep the dependency consumer first even after the worklist applies
        // its stable source-path ordering, so this proves a real retry pass.
        { definition: second, sourcePath: 'assets/a-second.pack.ts' },
        { definition: first, sourcePath: 'assets/z-first.pack.ts' },
      ],
      outputs: producers(),
      maxConcurrency,
    });
    expect(result).toMatchObject({ ok: true, value: { iterations: 2 } });
    if (result.ok) expect(result.value.products).toHaveLength(2);
  });

  it('joins admitted work before surfacing the earliest cache failure', async () => {
    const primary = new Error('first cache read failed');
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settled = false,
      finished = false,
      writes = 0;
    const subjects = ['a', 'b'].map((name, index) => ({
      sourcePath: `assets/${name}.pack.ts`,
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId(`01900000-0000-7000-8000-00000000011${index}`),
        async build() {
          started();
          await gate;
          finished = true;
          return ok({ [`scene/${name}`]: scene() });
        },
      }),
    }));
    const pending = buildScriptablePackWorklist({
      subjects,
      outputs: producers(),
      maxConcurrency: 2,
      cache: {
        async read(subject) {
          if (subject.sourcePath.includes('/a.')) throw primary;
          return undefined;
        },
        async write() {
          writes++;
        },
      },
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      release();
      await expect(pending).rejects.toBe(primary);
    }
    expect(finished).toBe(true);
    expect(writes).toBe(0);
  });

  it('returns a structured stall when no subject can satisfy a content read', async () => {
    const missing = AssetGuid.derive(id('01900000-0000-7000-8000-000000000060'), 'scene/missing');
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: id('01900000-0000-7000-8000-000000000061'),
      build: async ({ readByGuid }) => {
        const dependency = await readByGuid(missing);
        if (!dependency.ok) return err(dependency.error);
        return ok({ 'scene/main': scene() });
      },
    });
    const result = await buildScriptablePackWorklist({
      subjects: [{ definition, sourcePath: 'assets/missing.pack.ts' }],
      outputs: producers(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-content-dependency-stalled' } });
  });

  it('publishes serial dependencies before admitting the next subject', async () => {
    const producerId = id('01900000-0000-7000-8000-000000000132');
    const dependency = AssetGuid.derive(producerId, 'scene/main');
    const producer = definePack({
      schemaVersion: '2.0.0',
      packageId: producerId,
      build: () => ok({ 'scene/main': scene() }),
    });
    const consumer = definePack({
      schemaVersion: '2.0.0',
      packageId: id('01900000-0000-7000-8000-000000000133'),
      async build({ readByGuid }) {
        const result = await readByGuid(dependency);
        return result.ok ? ok({ 'scene/copy': scene() }) : err(result.error);
      },
    });
    const result = await buildScriptablePackWorklist({
      subjects: [
        { sourcePath: 'a-producer.pack.ts', definition: producer },
        { sourcePath: 'b-consumer.pack.ts', definition: consumer },
      ],
      outputs: producers(),
      maxConcurrency: 1,
      maxPasses: 1,
    });
    expect(result).toMatchObject({ ok: true, value: { iterations: 1 } });
  });

  it('retries a speculative fallback read replaced by an earlier producer', async () => {
    const producerId = id('01900000-0000-7000-8000-000000000130');
    const dependency = AssetGuid.derive(producerId, 'scene/main');
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const producer = definePack({
      schemaVersion: '2.0.0',
      packageId: producerId,
      async build() {
        await gate;
        return ok({ 'scene/main': scene() });
      },
    });
    const consumer = definePack({
      schemaVersion: '2.0.0',
      packageId: id('01900000-0000-7000-8000-000000000131'),
      async build({ readByGuid }) {
        const result = await readByGuid(dependency);
        if (!result.ok) return err(result.error);
        reads++;
        release();
        return ok({ 'scene/copy': scene() });
      },
    });
    const writes: string[] = [];
    const result = await buildScriptablePackWorklist({
      subjects: [
        { sourcePath: 'a-producer.pack.ts', definition: producer },
        { sourcePath: 'b-consumer.pack.ts', definition: consumer },
      ],
      outputs: producers(),
      maxConcurrency: 2,
      assetSource: {
        async readByGuid() {
          return ok({ asset: scene(), generation: 7, digest: 'sha256:old' });
        },
      },
      cache: {
        async read() {
          return undefined;
        },
        async write(subject) {
          writes.push(subject.sourcePath);
        },
      },
    });
    expect(result).toMatchObject({ ok: true, value: { iterations: 2 } });
    expect(reads).toBe(2);
    if (result.ok) {
      const evidence = result.value.buildProducts.flatMap((product) => product.externalEvidence);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.digest).not.toBe('sha256:old');
    }
    expect(writes).toEqual(['a-producer.pack.ts', 'b-consumer.pack.ts']);
  });

  it('uses the published asset source when a dynamic build reads a non-staged dependency', async () => {
    const packageId = id('01900000-0000-7000-8000-000000000062');
    const dependencyPackageId = id('01900000-0000-7000-8000-000000000063');
    const dependencyGuid = AssetGuid.derive(dependencyPackageId, 'sampler/main');
    const dependency = {
      kind: 'sampler' as const,
      magFilter: 'linear' as const,
      minFilter: 'linear' as const,
      mipmapFilter: 'linear' as const,
      addressModeU: 'repeat' as const,
      addressModeV: 'repeat' as const,
      addressModeW: 'repeat' as const,
    };
    const assetSource: ScriptablePackAssetSnapshotSource = {
      async readByGuid(guid) {
        return AssetGuid.equals(guid, dependencyGuid)
          ? ok({ asset: dependency, generation: 7, digest: 'sha256:published' })
          : err({
              code: 'asset-not-found',
              expected: 'the published dependency',
              hint: 'publish the dependency before rebuilding',
            });
      },
    };
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: async ({ readByGuid }) => {
        const read = await readByGuid(dependencyGuid);
        if (!read.ok) return err(read.error);
        return ok({ 'scene/main': scene() });
      },
    });
    const result = await produceScriptablePackProducts({
      sources: [
        {
          sourcePath: 'assets/consumer.pack.ts',
          displaySourcePath: 'assets/consumer.pack.ts',
          definition,
          sourceClosure: [],
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'assets/consumer.pack.json',
            artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
          },
        },
      ],
      assetSource,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.get('assets/consumer.pack.ts')?.product.externalEvidence).toEqual([
      {
        guid: AssetGuid.format(dependencyGuid),
        usage: 'content',
        generation: 7,
        digest: 'sha256:published',
      },
    ]);
    const revision = result.value.get('assets/consumer.pack.ts')?.revision;
    expect(revision?.observedAt).toBe(0);
  });

  it.each([
    'game::custom',
    'forgeax_material::standard',
    'forgeax::default-standard-pbr',
  ])('cooks authored material %s once, re-projects refsIndex values, and keeps cooker-only refs', async (module) => {
    const packageId = id('01900000-0000-7000-8000-000000000068');
    const textureGuid = '11111111-1111-4111-8111-111111111111';
    const cookerOnlyGuid = '22222222-2222-4222-8222-222222222222';
    const material = {
      kind: 'material' as const,
      passes: [{ name: 'forward', program: { module } }] as const,
      parameters: [{ name: 'baseColorTexture', type: 'texture' as const }],
      values: { baseColorTexture: textureGuid },
    };
    const outputs = new AssetOutputProducerRegistry();
    outputs.register(materialAssetOutputProducer);
    let cookCount = 0;
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId,
        build: () => ok({ 'material/main': material }),
      }),
      sourcePath: 'assets/dynamic-material.pack.ts',
      outputs,
      availableGuids: new Set([textureGuid, cookerOnlyGuid]),
      cookers: [
        {
          key: 'material',
          cook(input: {
            readonly guid: string;
            readonly source: typeof material;
            readonly refs: readonly string[];
          }) {
            cookCount += 1;
            expect(input.refs).toContain(textureGuid);
            return {
              guid: input.guid,
              payload: {
                ...input.source,
                values: { baseColorTexture: { texture: textureGuid } },
              },
              refs: [cookerOnlyGuid],
              artifacts: {},
              inputFingerprint: 'sha256:dynamic-material',
            };
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(cookCount).toBe(1);
    const [asset] = result.value.product.assets;
    expect(asset?.payload).toMatchObject({ values: { baseColorTexture: { texture: 0 } } });
    expect(asset?.refs).toEqual(
      expect.arrayContaining([
        {
          guid: textureGuid,
          sourceField: { componentName: '<material>', fieldName: 'baseColorTexture' },
        },
        { guid: cookerOnlyGuid },
      ]),
    );
  });

  it('threads the accepted Pack generation into every material cook receipt input', async () => {
    const packageId = id('01900000-0000-7000-8000-000000000069');
    const material = {
      kind: 'material' as const,
      passes: [{ name: 'forward', program: { module: 'game::surface' } }] as const,
      parameters: [],
    };
    const outputs = new AssetOutputProducerRegistry();
    outputs.register(materialAssetOutputProducer);
    let observedGeneration: number | undefined;
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId,
        build: () => ok({ 'material/water': material }),
      }),
      sourcePath: 'assets/surface.pack.ts',
      publicationGeneration: 7,
      outputs,
      cookers: [
        {
          key: 'material',
          cook(input: {
            readonly guid: string;
            readonly source: typeof material;
            readonly cookGeneration?: number;
          }) {
            observedGeneration = input.cookGeneration;
            return {
              guid: input.guid,
              payload: input.source,
              refs: [],
              artifacts: {},
              inputFingerprint: 'sha256:surface-generation',
            };
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(observedGeneration).toBe(7);
  });

  it('does not replace a staged read failure with a published value', async () => {
    const packageId = id('01900000-0000-7000-8000-000000000064');
    const dependencyGuid = AssetGuid.derive(packageId, 'scene/dependency');
    const assetSource: ScriptablePackAssetSnapshotSource = {
      async readByGuid() {
        return err({
          code: 'asset-fetch-failed',
          expected: 'the staged dependency read to succeed',
          hint: 'repair the staged generation before retrying',
        });
      },
    };
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build: async ({ readByGuid }) => {
        const read = await readByGuid(dependencyGuid);
        if (!read.ok) return err(read.error);
        return ok({ 'scene/main': scene() });
      },
    });
    const result = await produceScriptablePackProducts({
      sources: [
        {
          sourcePath: 'assets/failing-consumer.pack.ts',
          displaySourcePath: 'assets/failing-consumer.pack.ts',
          definition,
          sourceClosure: [],
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'assets/failing-consumer.pack.json',
            artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
          },
        },
      ],
      assetSource,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-fetch-failed' } });
  });

  it('keeps a thrown Plugin source validation error structured at the import boundary', async () => {
    const validated = validatePluginAssetSource({
      kind: 'plugin',
      module: { specifier: './behavior.ts' },
      config: { nested: undefined },
    });
    expect(validated.ok).toBe(false);
    if (validated.ok) throw new Error('expected an invalid Plugin config');
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000068'),
        build: () => {
          throw validated.error;
        },
      }),
      sourcePath: 'assets/invalid-plugin.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'plugin-source-invalid',
        expected: validated.error.expected,
        hint: validated.error.hint,
        detail: { path: '$.config.nested', reason: 'expected finite JSON data' },
      },
    });
    if (!result.ok) expect(result.error).toBe(validated.error);
  });

  it.each([
    [
      'AssetGuid.derive throw',
      ({ packageId }: { readonly packageId: PackageId }) => {
        AssetGuid.derive(packageId, 'material/rockLight');
        return ok({});
      },
    ],
    ['output key', () => ok({ 'material/rockLight': scene() })],
  ] as const)('reports an invalid sourceKey from a %s with its Pack and kebab-case fix', async (_, build) => {
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000071'),
        build: build as never,
      }),
      sourcePath: 'assets/rocks.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-key-invalid',
        expected: expect.stringContaining('^[a-z0-9][a-z0-9._-]*'),
        hint: expect.stringContaining('use kebab-case: "material/rock-light"'),
        detail: {
          sourcePath: 'assets/rocks.pack.ts',
          sourceKey: 'material/rockLight',
          suggestedSourceKey: 'material/rock-light',
        },
      },
    });
  });

  it.each([
    false,
    true,
  ])('retains the fallback for an unstructured build throw (accessor: %s)', async (accessor) => {
    let inspected = false;
    const cause = accessor
      ? Object.defineProperty({}, 'code', {
          get() {
            inspected = true;
            throw new Error('diagnostic getter must not run');
          },
        })
      : new Error('author build exploded');
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000069'),
        build: () => {
          throw cause;
        },
      }),
      sourcePath: 'assets/throwing-build.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'import-internal-error',
        detail: {
          reason: `assets/throwing-build.pack.ts: ${accessor ? '[object Object]' : 'author build exploded'}`,
        },
      },
    });
    expect(inspected).toBe(false);
  });

  it('does not let an opaque thrown Proxy hide the original import failure', async () => {
    const cause = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('diagnostic inspection must not replace the author failure');
        },
      },
    );
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000070'),
        build: () => {
          throw cause;
        },
      }),
      sourcePath: 'assets/opaque-build.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'import-internal-error',
        detail: { reason: 'assets/opaque-build.pack.ts: [object Object]' },
      },
    });
  });

  it('converts a throwing output producer into a structured import failure', async () => {
    const outputs = new AssetOutputProducerRegistry();
    outputs.register({
      kind: 'scene',
      version: 'test',
      produce: () => {
        throw new Error('producer exploded');
      },
    });
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000065'),
        build: () => ok({ 'scene/main': scene() }),
      }),
      sourcePath: 'assets/throwing-producer.pack.ts',
      outputs,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'import-internal-error' } });
  });

  it('rejects malformed output producer products at the import boundary', async () => {
    const outputs = new AssetOutputProducerRegistry();
    outputs.register({
      kind: 'scene',
      version: 'test',
      produce: () => ({ ok: true, value: null }) as never,
    });
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000066'),
        build: () => ok({ 'scene/main': scene() }),
      }),
      sourcePath: 'assets/malformed-producer.pack.ts',
      outputs,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });

  it('converts a malformed Pack build result into a structured import failure', async () => {
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: id('01900000-0000-7000-8000-000000000067'),
        build: () => null as never,
      }),
      sourcePath: 'assets/malformed-build.pack.ts',
      outputs: producers(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'import-internal-error' } });
  });
});
