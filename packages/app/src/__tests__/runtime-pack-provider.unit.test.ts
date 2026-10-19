import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createFixedRuntimePackSnapshot } from '@forgeax/engine-import';
import {
  createRuntimePackPublication,
  type FixedPackPublication,
  preparePackProgram,
} from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { type Context, inspectPluginFiber, type PluginPrograms } from '@forgeax/engine-plugin';
import { encodeBase64, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { defined } from '../../../assets-runtime/src/__tests__/assert-defined.js';
import { scriptablePackFingerprint } from '../../../import/src/scriptable-pack-fingerprint.js';
import { createAssetRuntimeAssembly } from '../assets-runtime-assembly.js';
import { activateExecutionRoot } from '../execution/bootstrap-entry.js';
import { assetRegistryPlugin } from '../internal/assets-world-plugin.js';
import { assembleRuntimePacks } from '../runtime-packs.js';

it('captures a shared delivered dependency once across all admission roots', async () => {
  const ids = ['b01', 'b02', 'b03'].map((suffix) => `01900000-0000-7000-8000-000000000${suffix}`);
  const shared = defined(ids[0]);
  const records = ids.map((guid, index) => {
    const packageUrl = `https://delivered.invalid/${guid}/pack.json`;
    const publication = createRuntimePackPublication({
      scopeId: 'test',
      sourcePath: guid,
      sourceRevision: guid,
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'sampler',
            payload: { kind: 'sampler' },
            refs: index === 0 ? [] : [shared],
            artifacts: {},
          },
        ],
      },
    });
    return {
      pack: publication.pack,
      row: {
        guid,
        kind: 'sampler',
        sourcePath: guid,
        packageUrl,
        publication: publication.publication,
      },
    };
  });
  const reads = new Map<string, number>();
  const assets = new AssetRegistry({} as never);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: records.map((record) => record.row) }),
    fetcher: async (input) => {
      const url = String(input);
      reads.set(url, (reads.get(url) ?? 0) + 1);
      const record = records.find((record) => record.row.packageUrl === url);
      return record ? new Response(JSON.stringify(record.pack)) : new Response('', { status: 404 });
    },
  }).unwrap();
  const context = await createWorldContext(new World(), []);
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'test' });
  try {
    const roots = records.slice(1);
    const content = {
      source: {
        schemaVersion: '3.0.0' as const,
        packageId: '01900000-0000-7000-8000-000000000b04',
        assets: {
          sampler: {
            kind: 'sampler',
            payload: { kind: 'sampler' },
            refs: roots.map(({ row }) => row.guid),
          },
        },
      },
      dependencies: Object.fromEntries(
        roots.map(({ row }) => [row.guid, defined(row.publication.outputs[0]).digest]),
      ),
    };
    (await runtime.producer.admit(content)).unwrap();
    for (const record of records) expect(reads.get(record.row.packageUrl)).toBe(1);
    const saved = JSON.parse(JSON.stringify(runtime.producer.snapshot()));
    runtime.producer.withdraw(content.source.packageId);
    (await runtime.producer.restore(saved)).unwrap();
    expect(runtime.producer.rows()).toHaveLength(1);
  } finally {
    await context.fiber.dispose();
    assembly.dispose();
  }
});

it.each([
  false,
  true,
])('avoids recapturing fixed sampler artifacts while checking unused attachments (corrupt=%s)', async (corrupt) => {
  const bytes = new Uint8Array([19, 27, 53, 91, 211]);
  const digest = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const guid = '01900000-0000-7000-8000-000000000974';
  const packageUrl = 'https://delivered.invalid/sampler.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'delivered',
    sourcePath: 'sampler',
    sourceRevision: 'sampler',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'sampler',
          payload: { kind: 'sampler' },
          refs: [],
          artifacts: {
            attachment: {
              path: 'attachment.bin',
              mediaType: 'application/octet-stream',
              contentEncoding: 'identity',
              byteLength: bytes.length,
              integrity: { algorithm: 'sha256', digest },
            },
          },
        },
      ],
    },
    sourceKeys: new Map([[guid, 'sampler']]),
  });
  const snapshot = await createFixedRuntimePackSnapshot(
    JSON.parse(
      JSON.stringify({
        pack: publication.pack,
        rows: [
          {
            guid,
            kind: 'sampler',
            sourceKey: 'sampler',
            sourcePath: 'sampler',
            packageUrl,
            publication: publication.publication,
          },
        ],
        blobs: {
          'attachment.bin': encodeBase64(corrupt ? new Uint8Array([19, 27, 53, 91, 212]) : bytes),
        },
      }),
    ),
  );
  const assets = new AssetRegistry({} as never);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  const context = await createWorldContext(new World(), []);
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'test' });
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let artifactHashes = 0;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, input) => {
    if (input.byteLength === bytes.length) artifactHashes++;
    return original(algorithm, input);
  });
  try {
    const result = await runtime.producer.restore(snapshot);
    expect(result.ok, JSON.stringify(result)).toBe(!corrupt);
    // Restore validates both its private recipe and the final current publication.
    expect(artifactHashes).toBe(corrupt ? 1 : 2);
    expect(runtime.producer.rows()).toHaveLength(corrupt ? 0 : 1);
  } finally {
    spy.mockRestore();
    await context.fiber.dispose();
    assembly.dispose();
  }
});

it('keeps runtime programs in the asset provider and mounts roots after independent game readiness', async () => {
  const assets = new AssetRegistry({} as never);
  const base = createCatalogSource({ entries: [] });
  let enumerations = 0;
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: {
      ...base,
      enumerate: () => {
        enumerations++;
        return base.enumerate();
      },
    },
  }).unwrap();
  const programs: PluginPrograms = {
    sessionId: 'test-session',
    contextId: 'engine',
    sessionGeneration: 1,
    target: 'engine',
    tools: new Map(),
    definitions: new Map(),
    programs: new Map(),
  };
  const world = new World();
  const context = await createWorldContext(world, []);
  const provider = context.plugin(assetRegistryPlugin(assembly, programs, { scopeId: 'test' }));
  await provider.await();
  let callerContext: Context | undefined;
  const caller = context.plugin({
    name: 'existing-host-plugin',
    apply(ctx) {
      callerContext = ctx;
    },
  });
  await caller.await();
  if (!callerContext) throw new Error('missing actual caller Context');
  try {
    const runtime = context.runtimePacks;
    if (!runtime) throw new Error('missing realm producer');
    expect(context.pluginPrograms).toBe(programs);
    expect(world.hasResource('runtime-plugin-active')).toBe(false);
    const packageId = '01900000-0000-7000-8000-000000000321';
    const program = 'project:runtime-behavior.js#default';
    (
      await runtime.producer.admit({
        source: {
          schemaVersion: '3.0.0',
          packageId,
          assets: {
            behavior: { kind: 'plugin', payload: { module: { specifier: './behavior.js' } } },
          },
        },
        programs: {
          [program]: {
            artifact: preparePackProgram({
              entry: 'behavior.js',
              export: 'default',
              modules: {
                'behavior.js': `export default { inject: ['world'], apply(ctx) {
          if (!ctx.world.getResource('game-ready')) throw new Error('root mounted before game readiness');
          ctx.effect(() => { ctx.world.insertResource('runtime-plugin-active', true); return () => ctx.world.removeResource('runtime-plugin-active'); });
        } };`,
              },
            }).unwrap(),
          },
        },
      })
    ).unwrap();
    expect(world.hasResource('runtime-plugin-active')).toBe(false);
    // Game host readiness remains separate from installing the asset/program provider.
    world.insertResource('game-ready', true);
    const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
    const root = await activateExecutionRoot(callerContext, { guid });
    expect(world.getResource('runtime-plugin-active')).toBe(true);
    expect(context.runtimePacks).toBe(runtime);
    expect(context.pluginPrograms?.programs.has(program)).toBe(true);
    await root.fiber.dispose();
    expect(world.hasResource('runtime-plugin-active')).toBe(false);
    expect(runtime.producer.inspect().packs).toHaveLength(1);
    const second = await activateExecutionRoot(callerContext, { guid });
    expect(world.hasResource('runtime-plugin-active')).toBe(true);
    const readsBeforeDisposal = enumerations;
    await provider.dispose();
    expect(enumerations, 'disposing the asset provider must not restart its base Catalog IO').toBe(
      readsBeforeDisposal,
    );
    expect(inspectPluginFiber(second.fiber).state).not.toBe('active');
    expect(world.hasResource('runtime-plugin-active')).toBe(false);
  } finally {
    await context.fiber.dispose();
  }
  expect(assets.hasCatalogSource).toBe(false);
  expect(world.hasResource('runtime-plugin-active')).toBe(false);
});

it('preserves structured root mount failures through Cordis startup', async () => {
  const guid = '01900000-0000-7000-8000-000000000975';
  const failure = {
    code: 'plugin-asset-read-failed',
    expected: 'a validated root definition',
    hint: 'repair the root publication',
    detail: { guid, cause: 'fixture read rejection' },
  } as const;
  const context = await createWorldContext(new World(), []);
  const programs: PluginPrograms = {
    sessionId: 'test-session',
    contextId: 'engine',
    sessionGeneration: 1,
    target: 'engine',
    tools: new Map(),
    definitions: new Map(),
    programs: new Map(),
  };
  context.provide('pluginPrograms', programs);
  context.provide('assets', {
    readPluginDefinition: async () => ({ ok: false, error: failure }),
  } as never);
  try {
    const thrown = await activateExecutionRoot(context, { guid }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({
      code: 'plugin-startup-failed',
      detail: {
        cause: {
          name: 'Error',
          message: `Root PluginAsset mount failed: ${failure.code}`,
          cause: {
            code: 'plugin-asset-read-failed',
            detail: { guid, cause: failure },
          },
        },
      },
    });
  } finally {
    await context.fiber.dispose();
  }
});

it('keeps a shared tool executor until the last restored plugin publication withdraws', async () => {
  const assets = new AssetRegistry({} as never);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  const context = await createWorldContext(new World(), []);
  context.provide('pluginPrograms', {
    sessionId: 'test',
    contextId: 'engine',
    sessionGeneration: 1,
    target: 'engine',
    definitions: new Map(),
    programs: new Map(),
    tools: new Map(),
  });
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'test' });
  const artifact = (text: string) =>
    preparePackProgram({
      entry: 'entry.js',
      export: 'default',
      modules: { 'entry.js': text },
    }).unwrap();
  const executor = artifact('export default () => 42;');
  const fixed = (name: string, guid: string, target = 'engine'): FixedPackPublication => {
    const packageUrl = `https://delivered.invalid/${name}.pack.json`;
    const publication = createRuntimePackPublication({
      scopeId: 'delivered',
      sourcePath: name,
      sourceRevision: name,
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'plugin',
            payload: { kind: 'plugin', program: name },
            refs: [],
            artifacts: {},
          },
        ],
      },
      sourceKeys: new Map([[guid, name]]),
    });
    return JSON.parse(
      JSON.stringify({
        pack: publication.pack,
        blobs: {},
        rows: [
          {
            guid,
            kind: 'plugin',
            sourceKey: name,
            sourcePath: name,
            packageUrl,
            publication: publication.publication,
          },
        ],
        executions: {
          [target]: {
            programs: { [name]: artifact('export default { apply() {} };'), shared: executor },
            tools: {
              [guid]: {
                schemaVersion: '1.0.0',
                commands: [
                  { id: name, title: name, summary: '', realm: target, executor: 'shared' },
                ],
              },
            },
          },
        },
      }),
    );
  };
  const first = fixed('first', '01900000-0000-7000-8000-000000000971');
  const second = fixed('second', '01900000-0000-7000-8000-000000000972');
  const foreignGuid = '01900000-0000-7000-8000-000000000973';
  const foreign = fixed('first', foreignGuid, 'host');
  try {
    (await runtime.producer.restore(await createFixedRuntimePackSnapshot(first))).unwrap();
    const shared = context.pluginPrograms?.programs.get('shared');
    expect(shared).toBeDefined();
    (await runtime.producer.restore(await createFixedRuntimePackSnapshot(second))).unwrap();
    (await runtime.producer.restore(await createFixedRuntimePackSnapshot(foreign))).unwrap();
    expect(context.pluginPrograms?.definitions.has(foreignGuid)).toBe(true);
    expect(context.pluginPrograms?.tools.has(foreignGuid)).toBe(false);
    runtime.producer.withdraw(scriptablePackFingerprint(first));
    expect(context.pluginPrograms?.programs.has('first')).toBe(false);
    expect(context.pluginPrograms?.programs.has('second')).toBe(true);
    expect(context.pluginPrograms?.programs.get('shared')).toBe(shared);
    expect(context.pluginPrograms?.tools?.size).toBe(1);
    runtime.producer.withdraw(scriptablePackFingerprint(second));
    expect(context.pluginPrograms?.programs.size).toBe(0);
    expect(context.pluginPrograms?.tools?.size).toBe(0);
    expect(context.pluginPrograms?.definitions.size).toBe(1);
  } finally {
    await context.fiber.dispose();
    assembly.dispose();
  }
});

it.each([
  'current',
  'current-no-evidence',
  'missing',
  'changed',
] as const)('keeps sibling publication evidence in the validation Catalog (%s)', async (version) => {
  const a = '01900000-0000-7000-8000-000000000a01';
  const b = '01900000-0000-7000-8000-000000000a02';
  const x = '01900000-0000-7000-8000-000000000a03';
  const y = '01900000-0000-7000-8000-000000000a04';
  const fixed = (
    name: string,
    outputs: readonly { guid: string; refs: readonly string[] }[],
    evidence: readonly {
      guid: string;
      digest: string;
      usage: 'reference';
      generation: number;
    }[] = [],
    generation = 1,
  ): FixedPackPublication => {
    const packageUrl = `https://delivered.invalid/${name}.pack.json`;
    const publication = createRuntimePackPublication({
      scopeId: 'delivered',
      sourcePath: name,
      sourceRevision: name,
      packageUrl,
      externalEvidence: evidence,
      generation,
      sourceKeys: new Map(outputs.map(({ guid }) => [guid, guid])),
      pack: {
        assets: outputs.map(({ guid, refs }) => ({
          guid,
          refs,
          kind: 'sampler',
          payload: { kind: 'sampler' },
          artifacts: {},
        })),
      },
    });
    return JSON.parse(
      JSON.stringify({
        pack: publication.pack,
        blobs: {},
        rows: outputs.map(({ guid }) => ({
          guid,
          kind: 'sampler',
          sourceKey: guid,
          sourcePath: name,
          packageUrl,
          publication: publication.publication,
        })),
      }),
    );
  };
  const left = fixed('x', [{ guid: x, refs: [] }]);
  const right = fixed('y', [{ guid: y, refs: [] }]);
  const siblings = fixed(
    'siblings',
    [
      { guid: a, refs: [x] },
      { guid: b, refs: [y] },
    ],
    (version === 'current-no-evidence' ? [] : [left, right]).map((value) => ({
      guid: defined(value.rows[0]).guid,
      digest: defined(defined(defined(value.rows[0]).publication).outputs[0]).digest,
      generation: value.pack.generation,
      usage: 'reference',
    })),
  );
  let source = await createFixedRuntimePackSnapshot(
    siblings,
    new Map([
      [x, await createFixedRuntimePackSnapshot(left)],
      [y, await createFixedRuntimePackSnapshot(right)],
    ]),
  );
  const yRow = defined(right.rows[0]);
  const externalY = {
    ...yRow,
    guid: y.toUpperCase(),
    publication: {
      ...defined(yRow.publication),
      generation: defined(yRow.publication).generation + (version === 'changed' ? 1 : 0),
    },
  };
  const assets = new AssetRegistry({} as never);
  let currentRows = [...siblings.rows, ...left.rows, ...(version === 'missing' ? [] : [externalY])];
  let emit: ((delta: import('@forgeax/engine-types').CatalogDelta) => void) | undefined;
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: {
      enumerate: async () => ok(currentRows),
      subscribe: (listener) => {
        emit = listener;
        return () => {
          emit = undefined;
        };
      },
    },
  }).unwrap();
  let exports = 0;
  const context = await createWorldContext(new World(), []);
  const runtime = assembleRuntimePacks(context, assembly, {
    scopeId: 'test',
    assetSource: {
      currentRow: (guid) =>
        [...siblings.rows, ...left.rows, ...right.rows].find((row) => row.guid === guid),
      exportSource: async () => {
        exports++;
        return source;
      },
    },
  });
  try {
    const content = {
      source: {
        schemaVersion: '3.0.0' as const,
        packageId: '01900000-0000-7000-8000-000000000a05',
        assets: { sampler: { kind: 'sampler', payload: { kind: 'sampler' }, refs: [a] } },
      },
      dependencies: {
        [a]: defined(
          defined(defined(siblings.rows[0]).publication).outputs.find(
            (output) => output.guid === a,
          ),
        ).digest,
      },
    };
    const result = await runtime.producer.admit(content);
    expect(result.ok, JSON.stringify(result)).toBe(version.startsWith('current'));
    expect(runtime.producer.rows()).toHaveLength(version.startsWith('current') ? 1 : 0);
    if (version === 'current-no-evidence') {
      const admit = async (suffix: string) =>
        (
          await runtime.producer.admit({
            ...content,
            source: { ...content.source, packageId: `01900000-0000-7000-8000-000000000a${suffix}` },
          })
        ).unwrap();
      await admit('07');
      expect(exports).toBe(1);
      const newer = fixed('y', [{ guid: y, refs: [] }], [], 2);
      source = await createFixedRuntimePackSnapshot(
        siblings,
        new Map([
          [x, await createFixedRuntimePackSnapshot(left)],
          [y, await createFixedRuntimePackSnapshot(newer)],
        ]),
      );
      const changed = defined(newer.rows[0]);
      currentRows = [...siblings.rows, ...left.rows, changed];
      emit?.({ added: [], changed: [changed], removed: [] });
      await admit('08');
      expect(exports).toBe(2);
      runtime.producer.withdraw(content.source.packageId);
      runtime.producer.withdraw('01900000-0000-7000-8000-000000000a07');
      runtime.producer.withdraw('01900000-0000-7000-8000-000000000a08');
      await admit('09');
      expect(exports).toBe(3);
    }
  } finally {
    await context.fiber.dispose();
    assembly.dispose();
  }
});

it('reconciles a recoverable stale Catalog before validating a new runtime publication', async () => {
  let changed: ((delta: import('@forgeax/engine-types').CatalogDelta) => void) | undefined;
  let enumerations = 0;
  const assets = new AssetRegistry({} as never);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: {
      enumerate: async () => {
        enumerations++;
        return ok([]);
      },
      subscribe: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    },
  }).unwrap();
  const context = await createWorldContext(new World(), []);
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'test' });
  try {
    (await runtime.catalog.enumerate()).unwrap();
    const before = enumerations;
    changed?.({ added: [], changed: [], removed: [], authority: 'degraded' });
    const result = await runtime.producer.admit({
      source: {
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000a06',
        assets: { sampler: { kind: 'sampler', payload: { kind: 'sampler' }, refs: [] } },
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(enumerations).toBeGreaterThan(before);
  } finally {
    await context.fiber.dispose();
    assembly.dispose();
  }
});

it('captures one plugin execution projection for an entire dependency batch', async () => {
  const program = preparePackProgram({
    entry: 'entry.js',
    export: 'default',
    modules: { 'entry.js': 'export default { apply() {} };' },
  }).unwrap();
  const records = ['c01', 'c02'].map((suffix) => {
    const guid = `01900000-0000-7000-8000-000000000${suffix}`;
    const packageUrl = `https://delivered.invalid/${guid}/pack.json`;
    const publication = createRuntimePackPublication({
      scopeId: 'test',
      sourcePath: guid,
      sourceRevision: guid,
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'plugin',
            payload: { kind: 'plugin', program: 'shared' },
            refs: [],
            artifacts: {},
          },
        ],
      },
    });
    return {
      pack: publication.pack,
      row: {
        guid,
        kind: 'plugin',
        sourcePath: guid,
        packageUrl,
        publication: publication.publication,
      },
    };
  });
  const programs: PluginPrograms = {
    sessionId: 'test',
    contextId: 'engine',
    sessionGeneration: 1,
    target: 'engine',
    programs: new Map([
      ['shared', { load: async () => ({ apply() {} }), exportSource: async () => program }],
    ]),
    tools: new Map(
      records.map(({ row }) => [row.guid, { schemaVersion: '1.0.0' as const, commands: [] }]),
    ),
    definitions: new Map(
      records.map(({ row }) => [
        row.guid,
        {
          kind: 'publication' as const,
          publication: {
            scopeId: 'test',
            generation: row.publication.generation,
            digest: row.publication.digest,
            outputSetDigest: row.publication.outputSetDigest,
          },
        },
      ]),
    ),
  };
  const assets = new AssetRegistry({} as never);
  let reads = 0;
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: records.map((record) => record.row) }),
    fetcher: async (input) => {
      if (++reads === 1) {
        (programs.programs as Map<string, unknown>).clear();
        (programs.tools as Map<string, unknown>).clear();
        (programs.definitions as Map<string, unknown>).clear();
      }
      return new Response(
        JSON.stringify(
          defined(records.find((record) => record.row.packageUrl === String(input))).pack,
        ),
      );
    },
  }).unwrap();
  const context = await createWorldContext(new World(), []);
  context.provide('pluginPrograms', programs);
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'test' });
  try {
    (
      await runtime.producer.admit({
        source: {
          schemaVersion: '3.0.0',
          packageId: '01900000-0000-7000-8000-000000000c03',
          assets: {
            sampler: {
              kind: 'sampler',
              payload: { kind: 'sampler' },
              refs: records.map(({ row }) => row.guid),
            },
          },
        },
        dependencies: Object.fromEntries(
          records.map(({ row }) => [row.guid, defined(row.publication.outputs[0]).digest]),
        ),
      })
    ).unwrap();
    const recipes = Object.values(defined(runtime.producer.snapshot().closure).recipes);
    const fixed = recipes.filter((recipe) => 'fixed' in recipe);
    expect(fixed).toHaveLength(2);
    for (const recipe of fixed)
      if ('fixed' in recipe)
        expect(recipe.fixed.executions?.engine?.programs.shared).toEqual(program);
  } finally {
    await context.fiber.dispose();
    assembly.dispose();
  }
});

it('joins the pending delivered baseline when the runtime Pack overlay replaces its replica', async () => {
  const context = await createWorldContext(new World(), []);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let bodyReads = 0;
  class CatalogResponse extends Response {
    override async json() {
      bodyReads++;
      return super.json();
    }
  }
  const fetcher = vi.fn(async () => {
    await held;
    return new CatalogResponse('[]');
  });
  const assets = new AssetRegistry({} as never);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({
      url: 'https://delivered.invalid/pack-index.json',
      fetch: fetcher,
    }),
    fetcher,
  }).unwrap();
  const runtime = assembleRuntimePacks(context, assembly, { scopeId: 'test' });
  try {
    const enumerated = runtime.catalog.enumerate();
    release();
    expect((await enumerated).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(bodyReads).toBe(1);
    expect(assembly.registry).toBe(assets);
  } finally {
    release();
    await context.fiber.dispose();
    assembly.dispose();
  }
});
