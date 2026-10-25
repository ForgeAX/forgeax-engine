import { createBoxGeometry, meshAssetContribution } from '@forgeax/engine-geometry';
import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { encodeAssetBundle } from '@forgeax/engine-pack/bundle';
import {
  createRuntimePackPublication,
  decodePackBlob,
  preparePackProgram,
  validateFixedPackPublication,
} from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  type ArtifactDescriptor,
  type CatalogEntry,
  encodeBase64,
  type MaterialPass,
  type MeshAsset,
  ok,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { normaliseForPack } from '../../../import/src/import-runner.js';
import {
  createFixedRuntimePackSnapshot,
  RuntimePackProducer,
} from '../../../import/src/runtime-pack.js';
import { meshAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers.js';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { AssetRegistry } from '../asset-registry.js';
import { captureAssetPublication } from '../capture-publication.js';
import { createCatalogSource } from '../catalog-source.js';
import { runtimeSourceReader } from '../internal/runtime-assets';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';
import { materialRecordFixture } from './fixtures/material-publication.js';
import { loadFixtureAsset, runtimePackDecoders } from './fixtures/runtime-pack-decoders';

const guid = '01900000-0000-7000-8000-000000000091';
const sibling = '01900000-0000-7000-8000-000000000092';
const packageUrl = 'https://delivered.invalid/content/pack.json';

async function fixture(plugin = false, encoding: 'identity' | 'zstd' = 'zstd') {
  const { compressZstd } = await import('@forgeax/engine-codec/encode');
  const original = createBoxGeometry(2, 3, 4).unwrap();
  const produced = (
    await meshAssetOutputProducer.produce({ guid, sourceKey: 'mesh/main', asset: original })
  ).unwrap();
  const body = defined(produced.artifacts.body);
  const digest = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body.bytes))), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const encoded = await compressZstd(body.bytes);
  if (!encoded.ok) throw encoded.error;
  const compressed = encoded.value;
  const asset = {
    guid,
    kind: 'mesh',
    payload: normaliseForPack(produced.payload),
    refs: [],
    artifacts: {
      body: {
        path: 'mesh.bin.zst',
        mediaType: body.mediaType,
        assetCodec: body.assetCodec,
        contentEncoding: encoding,
        byteLength: body.bytes.byteLength,
        integrity: { algorithm: 'sha256', digest },
      },
    },
  };
  const publication = createRuntimePackPublication({
    pack: {
      assets: [
        asset,
        plugin
          ? {
              guid: sibling,
              kind: 'plugin',
              payload: { kind: 'plugin', program: 'delivered/plugin', config: {} },
              refs: [],
              artifacts: {},
            }
          : { ...asset, guid: sibling },
      ],
    },
    scopeId: 'delivered',
    sourcePath: 'original.pack',
    sourceRevision: 'original-revision',
    packageUrl,
    sourceKeys: new Map([
      [guid, 'mesh/main'],
      [sibling, plugin ? 'plugin/main' : 'mesh/sibling'],
    ]),
  });
  const rows: CatalogEntry[] = publication.publication.outputs.map((output) => ({
    guid: output.guid,
    kind: output.kind,
    sourceKey: output.sourceKey,
    sourcePath: 'original.pack',
    packageUrl,
    publication: publication.publication,
  }));
  const bodies = new Map<string, Uint8Array>([
    [packageUrl, new TextEncoder().encode(JSON.stringify(publication.pack))],
    [new URL('mesh.bin.zst', packageUrl).href, encoding === 'zstd' ? compressed : body.bytes],
  ]);
  const fetcher: typeof fetch = async (input) => {
    const bytes = bodies.get(String(input));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
  };
  return { original, rows, publication, bodies, fetcher, compressed };
}

it.each([
  'cold',
  'owned',
] as const)('verifies a captured Bundle once while checking every %s artifact', async (mode) => {
  const input = await fixture(false, 'identity');
  const original = defined(input.publication.pack.assets[0]);
  const descriptor = defined(original.artifacts.body);
  const body = defined(input.bodies.get(new URL(descriptor.path, packageUrl).href));
  const bundle = encodeAssetBundle([body]);
  const digest = `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', bundle.bytes)).toString('hex')}`;
  const publication = createRuntimePackPublication({
    pack: {
      assets: input.publication.pack.assets.map((asset) => ({
        ...asset,
        artifacts: Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `body${index}`,
            {
              ...descriptor,
              path: 'bundle.bin',
              byteRange: { ...defined(bundle.windows[0]), bundleDigest: digest },
            },
          ]),
        ),
      })),
    },
    scopeId: 'delivered',
    sourcePath: 'original.pack',
    sourceRevision: 'original-revision',
    packageUrl,
    sourceKeys: new Map([
      [guid, 'mesh/main'],
      [sibling, 'mesh/sibling'],
    ]),
  });
  const rows: CatalogEntry[] = publication.publication.outputs.map((output) => ({
    guid: output.guid,
    kind: output.kind,
    sourceKey: output.sourceKey,
    sourcePath: 'original.pack',
    packageUrl,
    publication: publication.publication,
  }));
  let corrupt = false;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === packageUrl) return new Response(JSON.stringify(publication.pack));
    const bytes = bundle.bytes.slice();
    if (corrupt) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    return new Response(bytes);
  });
  const source = createCatalogSource({ entries: rows });
  const registry = mode === 'owned' ? new AssetRegistry({ scopeId: 'delivered' }) : undefined;
  registry?.setCatalogSource(source, fetcher);
  const hashing = vi.spyOn(crypto.subtle, 'digest');
  try {
    const captured = (
      await captureAssetPublication(
        defined(rows[0]),
        rows,
        source,
        fetcher,
        registry ? { registry } : {},
      )
    ).unwrap();
    expect(decodePackBlob(defined(captured.blobs['bundle.bin']))).toEqual(bundle.bytes);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/bundle.bin'))).toHaveLength(
      1,
    );
    expect(
      hashing.mock.calls.filter(([, bytes]) => bytes.byteLength === bundle.bytes.byteLength),
    ).toHaveLength(1);
    expect(
      hashing.mock.calls.filter(([, bytes]) => bytes.byteLength === body.byteLength),
    ).toHaveLength(24);
    corrupt = true;
    expect(
      (
        await captureAssetPublication(
          defined(rows[0]),
          rows,
          source,
          fetcher,
          registry ? { registry } : {},
        )
      ).ok,
    ).toBe(false);
  } finally {
    hashing.mockRestore();
    registry?.dispose();
  }
});

it('captures frozen transport without awaiting an unrelated unfinished domain read', async () => {
  const input = await fixture(false, 'identity');
  const source = createCatalogSource({ entries: input.rows });
  const registry = new AssetRegistry({
    scopeId: 'delivered',
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  registry.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    registry.setCatalogSource(source, async (url, init) =>
      String(url).endsWith('unfinished.bin') ? new Promise(() => {}) : input.fetcher(url, init),
    );
    void defined(runtimeSourceReader(registry, source)).readArtifact(
      {
        packageUrl,
        guid,
        artifactKey: 'unfinished',
        descriptor: {
          ...(defined(input.publication.pack.assets[0]).artifacts.body as ArtifactDescriptor),
          path: 'unfinished.bin',
        },
      },
      new AbortController().signal,
    );
    let result: Awaited<ReturnType<typeof captureAssetPublication>> | undefined;
    void captureAssetPublication(defined(input.rows[0]), input.rows, source, input.fetcher, {
      registry,
    }).then((value) => {
      result = value;
    });
    await vi.waitFor(() => expect(result?.ok).toBe(true), { timeout: 500 });
    expect(validateFixedPackPublication(defined(result).unwrap(), defined(input.rows[0])).ok).toBe(
      true,
    );
  } finally {
    registry.clearCatalogSource();
  }
});

it.each([
  'identity',
  'zstd',
  'mutated',
] as const)('retains loaded %s bytes without repeating identity transport or trusting mutable cache bytes', async (mode) => {
  const input = await fixture(false, mode === 'zstd' ? 'zstd' : 'identity');
  const fetcher = vi.fn(input.fetcher);
  const source = createCatalogSource({ entries: input.rows });
  const registry = new AssetRegistry({
    scopeId: 'delivered',
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  registry.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    registry.setCatalogSource(source, fetcher);
    (await loadFixtureAsset(registry, guid, 'mesh')).unwrap();
    const before = fetcher.mock.calls.length;
    if (mode === 'mutated') {
      const bytes = (
        await defined(runtimeSourceReader(registry, source)).readArtifact(
          {
            packageUrl,
            guid,
            artifactKey: 'body',
            descriptor: defined(input.publication.pack.assets[0]).artifacts
              .body as ArtifactDescriptor,
          },
          new AbortController().signal,
        )
      ).unwrap().stored;
      bytes[0] = (bytes[0] ?? 0) ^ 255;
    }
    const result = await captureAssetPublication(
      defined(input.rows[0]),
      input.rows,
      source,
      fetcher,
      { registry },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (mode === 'zstd')
      expect(decodePackBlob(defined(result.unwrap().blobs['mesh.bin.zst']))).toEqual(
        input.compressed,
      );
    expect(fetcher.mock.calls.length).toBe(before);
  } finally {
    registry.clearCatalogSource();
  }
});

it.each([
  false,
  true,
])('captures complete publications with bounded overlapping artifact reads (corrupt=%s)', async (corrupt) => {
  const input = await fixture();
  const asset = defined(input.publication.pack.assets[0]);
  const attachmentDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.of(1, 2))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const attachments = Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [
      `attachment-${index}`,
      {
        path: `attachment-${index}.bin`,
        mediaType: 'application/octet-stream',
        contentEncoding: 'identity',
        byteLength: 2,
        integrity: { algorithm: 'sha256', digest: `sha256:${attachmentDigest}` },
      },
    ]),
  );
  const publication = createRuntimePackPublication({
    pack: { assets: [{ ...asset, artifacts: { ...asset.artifacts, ...attachments } }] },
    scopeId: 'delivered',
    sourcePath: 'original.pack',
    sourceRevision: 'concurrent-capture',
    packageUrl,
    sourceKeys: new Map([[guid, 'mesh/main']]),
  });
  const row = { ...defined(input.rows[0]), publication: publication.publication };
  let active = 0;
  let peak = 0;
  const waiting: Array<() => void> = [];
  const reads: string[] = [];
  const pending = captureAssetPublication(
    row,
    [row],
    createCatalogSource({ entries: [row] }),
    async (url) => {
      if (url === packageUrl) return new Response(JSON.stringify(publication.pack));
      if (String(url).endsWith('mesh.bin.zst'))
        return new Response(new Uint8Array(input.compressed));
      reads.push(String(url));
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => waiting.push(resolve));
      active--;
      return new Response(
        corrupt && String(url).endsWith('attachment-17.bin')
          ? Uint8Array.of(1)
          : Uint8Array.of(1, 2),
      );
    },
  );
  try {
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(1), { timeout: 300, interval: 5 });
    expect(reads.length).toBeLessThanOrEqual(8);
  } finally {
    // Also drain a serial RED implementation without leaving pending requests.
    for (let index = 0; index < 25; index++) {
      for (const release of waiting.splice(0)) release();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  const result = await pending;
  expect(reads).toHaveLength(18);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  if (corrupt) {
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-artifact-integrity-mismatch',
        detail: { artifactKey: 'attachment-17' },
      },
    });
  } else {
    const captured = result.unwrap();
    expect(Object.keys(captured.blobs)).toHaveLength(19);
    expect(decodePackBlob(defined(captured.blobs['mesh.bin.zst']))).toEqual(input.compressed);
    expect(decodePackBlob(defined(captured.blobs['attachment-17.bin']))).toEqual(
      Uint8Array.of(1, 2),
    );
  }
});

it.each([
  'network',
  'http',
])('retries a transient artifact %s failure without retaining the rejected byte request', async (failure) => {
  const input = await fixture();
  let requests = 0;
  const result = await captureAssetPublication(
    defined(input.rows[0]),
    input.rows,
    createCatalogSource({ entries: input.rows }),
    async (url) => {
      if (String(url).endsWith('mesh.bin.zst') && ++requests === 1) {
        if (failure === 'http') return new Response('', { status: 503 });
        throw new TypeError('transient read');
      }
      return input.fetcher(url);
    },
  );
  expect(result.ok).toBe(true);
  expect(requests).toBe(2);
});

it.each([
  false,
  true,
])('captures the fixed publication through source changes (cached owner=%s)', async (cachedOwner) => {
  const input = await fixture();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const fallback = vi.fn<typeof fetch>(async () => {
    throw new Error('escaped fixed transport');
  });
  const source = {
    enumerate: async () => ok(input.rows),
    subscribe: () => () => {},
    openPackage: vi.fn(() => {
      const bound = input.fetcher;
      return async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        enter();
        await gate;
        return bound(url, init);
      };
    }),
  };
  const registry = cachedOwner ? new AssetRegistry({ scopeId: 'delivered' }) : undefined;
  registry?.setCatalogSource(source, fallback);
  const pending = captureAssetPublication(defined(input.rows[0]), input.rows, source, fallback, {
    registry,
  });
  await entered;
  source.openPackage.mockImplementation(() => fallback);
  resume();
  const captured = (await pending).unwrap();
  expect(source.openPackage).toHaveBeenCalledTimes(1);
  expect(fallback).not.toHaveBeenCalled();
  expect(captured.rows).toEqual(input.rows);
  expect(captured.rows.every((row) => row.packageId === undefined)).toBe(true);
  expect(captured.pack).toEqual(input.publication.pack);
  expect(decodePackBlob(defined(captured.blobs['mesh.bin.zst']))).toEqual(input.compressed);
  input.bodies.clear();
  const offline: typeof fetch = async (url) => {
    if (String(url) === packageUrl) return new Response(JSON.stringify(captured.pack));
    const bytes = captured.blobs[String(url).slice(packageUrl.lastIndexOf('/') + 1)];
    return bytes ? new Response(decodePackBlob(bytes)) : new Response('', { status: 404 });
  };
  const decoded = (
    await validateAssetPublication(captured.rows, offline, undefined, {
      decoders: runtimePackDecoders,
    })
  ).unwrap();
  expect(decoded.size).toBe(2);
  registry?.dispose();
  expect((defined(decoded.get(guid)) as MeshAsset).attributes.position).toEqual(
    input.original.attributes.position,
  );
  expect((defined(decoded.get(sibling)) as MeshAsset).indices).toEqual(input.original.indices);
});

it.each([
  'missing sibling',
  'wrong tuple',
  'missing artifact',
  'corrupt artifact',
])('rejects %s instead of exporting an incomplete fixed publication', async (fault) => {
  const input = await fixture();
  if (fault === 'missing sibling') input.rows.pop();
  if (fault === 'wrong tuple')
    input.bodies.set(
      packageUrl,
      new TextEncoder().encode(JSON.stringify({ ...input.publication.pack, generation: 1 })),
    );
  if (fault === 'missing artifact') input.bodies.delete(new URL('mesh.bin.zst', packageUrl).href);
  if (fault === 'corrupt artifact')
    input.bodies.set(new URL('mesh.bin.zst', packageUrl).href, new Uint8Array([0, 1, 2]));
  expect(
    (
      await captureAssetPublication(
        defined(input.rows[0]),
        input.rows,
        { enumerate: async () => ok(input.rows), subscribe: () => () => {} },
        input.fetcher,
      )
    ).ok,
  ).toBe(false);
});

async function pluginFixture() {
  const input = await fixture(true);
  const source = { enumerate: async () => ok(input.rows), subscribe: () => () => {} };
  const artifact = preparePackProgram({
    entry: 'plugin.js',
    export: 'default',
    modules: {
      'plugin.js':
        'throw new Error("capture must not execute"); export default function plugin() {}',
    },
  }).unwrap();
  const executor = preparePackProgram({
    entry: 'executor.js',
    export: 'default',
    modules: {
      'executor.js': 'throw new Error("capture must not execute tools"); export default () => 42;',
    },
  }).unwrap();
  const programs = new Map([
    ['delivered/plugin', { exportSource: async () => artifact }],
    ['delivered/executor', { exportSource: async () => executor }],
  ]);
  const tools = new Map([
    [
      sibling,
      {
        schemaVersion: '1.0.0' as const,
        commands: [
          {
            id: 'saved.run',
            title: 'Run',
            summary: '',
            realm: 'host' as const,
            executor: 'delivered/executor',
          },
        ],
      },
    ],
  ]);
  const { scopeId, generation, digest, outputSetDigest } = input.publication.pack;
  const definitions = new Map([
    [
      sibling,
      {
        kind: 'publication' as const,
        publication: { scopeId, generation, digest, outputSetDigest },
      },
    ],
  ]);
  return {
    ...input,
    source,
    artifact,
    executor,
    options: { target: 'host' as const, programs, tools, definitions },
  };
}

it('captures unmounted plugin siblings and their tool executors without evaluating them', async () => {
  const input = await pluginFixture();
  const captured = (
    await captureAssetPublication(defined(input.rows[0]), input.rows, input.source, input.fetcher, {
      executions: [input.options],
    })
  ).unwrap();
  expect(captured.executions?.host?.programs?.['delivered/plugin']).toEqual(input.artifact);
  expect(captured.executions?.host?.programs?.['delivered/executor']).toEqual(input.executor);
  expect(captured.executions?.host?.tools?.[sibling]).toEqual(input.options.tools.get(sibling));
  expect(validateFixedPackPublication(structuredClone(captured)).ok).toBe(true);
});

it('exports only requested publication programs and clones each result before later producer I/O', async () => {
  const input = await pluginFixture();
  const mutable = structuredClone(input.artifact);
  const unrelated = vi.fn(async () => {
    throw new Error('unrelated exporter must not run');
  });
  const first = vi.fn(async () => mutable);
  input.options.programs.set('unrelated', { exportSource: unrelated });
  input.options.programs.set('delivered/plugin', { exportSource: first });
  input.options.programs.set('delivered/executor', {
    exportSource: async () => {
      // The first producer may recycle its own object while another export awaits.
      (mutable.modules as Record<string, string>)['plugin.js'] = 'export default 0;';
      return input.executor;
    },
  });
  const fixed = (
    await captureAssetPublication(defined(input.rows[0]), input.rows, input.source, input.fetcher, {
      executions: [input.options],
    })
  ).unwrap();
  expect(fixed.executions?.host?.programs['delivered/plugin']).toEqual(input.artifact);
  expect(fixed.executions?.host?.programs['delivered/executor']).toEqual(input.executor);
  expect(first).toHaveBeenCalledTimes(1);
  expect(unrelated).not.toHaveBeenCalled();
});

it.each([
  'definition',
  'program',
  'contract',
  'executor',
  'newer provider',
  'other scope',
])('rejects missing or mismatched %s before saving a plugin publication', async (fault) => {
  const input = await pluginFixture();
  const { programs, tools, definitions } = input.options;
  const evidence = defined(definitions.get(sibling));
  if (fault === 'definition') definitions.clear();
  if (fault === 'program') programs.delete('delivered/plugin');
  if (fault === 'contract') tools.clear();
  if (fault === 'executor') programs.delete('delivered/executor');
  if (fault === 'newer provider') evidence.publication.generation++;
  if (fault === 'other scope') evidence.publication.scopeId = 'another-realm';
  const captured = await captureAssetPublication(
    defined(input.rows[0]),
    input.rows,
    input.source,
    input.fetcher,
    { executions: [input.options] },
  );
  expect(captured.ok).toBe(false);
});

it('freezes program, declaration and definition tables before awaiting transport', async () => {
  const input = await pluginFixture();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const source = {
    ...input.source,
    openPackage:
      () =>
      async (...args: Parameters<typeof fetch>) => {
        await gate;
        return input.fetcher(...args);
      },
  };
  const original = {
    programs: { 'delivered/plugin': input.artifact, 'delivered/executor': input.executor },
    tools: structuredClone(input.options.tools),
  };
  const pending = captureAssetPublication(
    defined(input.rows[0]),
    input.rows,
    source,
    input.fetcher,
    { executions: [input.options] },
  );
  input.options.programs.clear();
  defined(defined(input.options.tools.get(sibling)).commands[0]).executor = 'newer/executor';
  defined(input.options.definitions.get(sibling)).publication.generation++;
  resume();
  const captured = (await pending).unwrap();
  expect(captured.executions?.host?.programs).toEqual(original.programs);
  expect(captured.executions?.host?.tools).toEqual(Object.fromEntries(original.tools));
});

it.each([
  'unknown plugin',
  'extra program',
  'invalid contract',
  'unlowered export',
  'absent executor',
])('rejects %s in a restored fixed plugin archive', async (fault) => {
  const input = await pluginFixture();
  const captured = (
    await captureAssetPublication(defined(input.rows[0]), input.rows, input.source, input.fetcher, {
      executions: [input.options],
    })
  ).unwrap();
  const saved = JSON.parse(
    JSON.stringify({
      ...captured,
      blobs: Object.fromEntries(
        Object.entries(captured.blobs).map(([path, bytes]) => [
          path,
          encodeBase64(decodePackBlob(bytes)),
        ]),
      ),
    }),
  );
  if (fault === 'unknown plugin')
    saved.executions.host.tools[guid] = saved.executions.host.tools[sibling];
  if (fault === 'extra program') saved.executions.host.programs.extra = input.executor;
  if (fault === 'invalid contract') saved.executions.host.tools[sibling].schemaVersion = 'unknown';
  if (fault === 'unlowered export')
    saved.executions.host.tools[sibling].commands[0].exportName = 'run';
  if (fault === 'absent executor') delete saved.executions.host.programs['delivered/executor'];
  expect(validateFixedPackPublication(saved).ok).toBe(false);
});

it('requires an explicit empty tool contract for a plugin with no tools', async () => {
  const input = await pluginFixture();
  defined(input.options.tools.get(sibling)).commands.length = 0;
  input.options.programs.delete('delivered/executor');
  const captured = (
    await captureAssetPublication(defined(input.rows[0]), input.rows, input.source, input.fetcher, {
      executions: [input.options],
    })
  ).unwrap();
  expect(captured.executions?.host?.tools?.[sibling]?.commands).toEqual([]);
  expect(Object.keys(captured.executions?.host?.programs ?? {})).toEqual(['delivered/plugin']);
});

it.each([
  'matching',
  'revision',
  'payload',
])('checks %s source evidence from the existing static plugin provider', async (fault) => {
  const input = await pluginFixture();
  const plugin = defined(input.publication.pack.assets.find((asset) => asset.guid === sibling));
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(plugin.payload))),
  );
  const digest = `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const captured = await captureAssetPublication(
    defined(input.rows[0]),
    input.rows,
    input.source,
    input.fetcher,
    {
      executions: [
        {
          ...input.options,
          definitions: new Map([
            [
              sibling,
              {
                kind: 'source' as const,
                revision:
                  fault === 'revision'
                    ? 'newer-source'
                    : input.publication.publication.sourceRevision,
                digest: fault === 'payload' ? `sha256:${'0'.repeat(64)}` : digest,
              },
            ],
          ]),
        },
      ],
    },
  );
  expect(captured.ok).toBe(fault === 'matching');
});

function materialCapture(passes?: readonly MaterialPass[]) {
  const record = materialRecordFixture(passes === undefined ? { guid } : { guid, passes });
  const publication = createRuntimePackPublication({
    pack: {
      assets: [
        {
          guid,
          kind: 'material',
          payload: {
            kind: 'material',
            ...record.resolved,
            cooked: JSON.parse(serializeCookedMaterialRecord(record)),
          },
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [
              artifact.path,
              {
                path: artifact.path,
                mediaType: artifact.mediaType,
                contentEncoding: 'identity',
                byteLength: artifact.bytes.length,
                integrity: { algorithm: 'sha256', digest: artifact.digest },
              },
            ]),
          ),
        },
      ],
    },
    scopeId: 'material-capture',
    sourcePath: 'material.pack',
    sourceRevision: 'material-original',
    packageUrl,
    sourceKeys: new Map([[guid, 'surface/main']]),
  });
  const row = {
    guid,
    kind: 'material',
    sourcePath: 'material.pack',
    sourceKey: 'surface/main',
    packageUrl,
    publication: publication.publication,
  };
  const blobs = new Map(
    record.programs.map(({ artifact }) => [
      new URL(artifact.path, packageUrl).href,
      artifact.bytes,
    ]),
  );
  return { record, publication, row, blobs };
}

it('captures cooked material shader artifacts and validates their offline loader path', async () => {
  const { publication, row, blobs } = materialCapture();
  let connected = true;
  const captured = (
    await captureAssetPublication(
      row,
      [row],
      { enumerate: async () => ok([row]), subscribe: () => () => {} },
      async (url) => {
        if (!connected) throw new Error('original transport disconnected');
        if (String(url) === packageUrl) return new Response(JSON.stringify(publication.pack));
        const bytes = blobs.get(String(url));
        return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
      },
    )
  ).unwrap();
  connected = false;
  const saved = structuredClone(captured) as typeof captured;
  const offline: typeof fetch = async (url) => {
    if (String(url) === packageUrl) return new Response(JSON.stringify(saved.pack));
    const bytes = saved.blobs[String(url).slice(packageUrl.lastIndexOf('/') + 1)];
    return bytes ? new Response(decodePackBlob(bytes)) : new Response('', { status: 404 });
  };
  expect(
    (
      await validateAssetPublication(saved.rows, offline, undefined, {
        decoders: runtimePackDecoders,
      })
    ).ok,
  ).toBe(true);
  const missing = vi.fn<typeof fetch>(async (url, init) =>
    String(url) === packageUrl ? offline(url, init) : new Response('', { status: 404 }),
  );
  expect(
    (
      await validateAssetPublication(saved.rows, missing, undefined, {
        decoders: runtimePackDecoders,
      })
    ).ok,
  ).toBe(false);
});

it.each([
  'owned',
  'corrupt',
  'cold',
] as const)('captures %s source material bytes after raw read-cache retirement', async (mode) => {
  const { record, publication, row, blobs } = materialCapture();
  const source = createCatalogSource({ entries: [row] });
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === packageUrl) return new Response(JSON.stringify(publication.pack));
    const bytes = blobs.get(String(url));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
  });
  const registry = new AssetRegistry({
    scopeId: 'material-capture',
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  registry.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    registry.setCatalogSource(source, fetcher);
    if (mode !== 'cold') {
      (await loadFixtureAsset(registry, guid, 'material')).unwrap();
      const program = defined(record.programs[0]);
      const owned = defined(registry.getMaterialArtifact(program.specializationKey));
      expect(owned.bytes).toEqual(program.artifact.bytes);
      // Memory pressure drops source transport bytes; fixed capture reloads that same source.
      registry.trimReadCache();
      if (mode === 'corrupt') owned.bytes[0] = (owned.bytes[0] ?? 0) ^ 255;
    }
    const before = fetcher.mock.calls.length;
    const result = await captureAssetPublication(row, [row], source, fetcher, { registry });
    {
      // A caller mutation of returned shader bytes cannot change the source publication.
      const captured = result.unwrap();
      expect(captured.rows).toEqual([row]);
      expect(Object.keys(captured.blobs)).toEqual(
        record.programs.map(({ artifact }) => artifact.path),
      );
      for (const { artifact } of record.programs)
        expect(decodePackBlob(defined(captured.blobs[artifact.path]))).toEqual(artifact.bytes);
      expect(fetcher.mock.calls.length).toBeGreaterThan(before);
    }
  } finally {
    registry.clearCatalogSource();
  }
});

// Quark on a phone spent >25 s in fixed dependency capture: each material pack issued
// its ~50 shader artifact round trips one at a time.
it('reads independent artifacts concurrently within a bounded window and keeps blob order', async () => {
  const passes = Array.from({ length: 20 }, (_, index) => ({
    name: `Forward${index}`,
    program: { module: `game::program${index}` },
  }));
  const { record, publication, row, blobs } = materialCapture(passes);
  let active = 0;
  let peak = 0;
  const captured = (
    await captureAssetPublication(
      row,
      [row],
      { enumerate: async () => ok([row]), subscribe: () => () => {} },
      async (url) => {
        if (String(url) === packageUrl) return new Response(JSON.stringify(publication.pack));
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        const bytes = blobs.get(String(url));
        return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
      },
    )
  ).unwrap();
  expect(record.programs).toHaveLength(20);
  expect(peak).toBe(8);
  expect(Object.keys(captured.blobs)).toEqual(record.programs.map(({ artifact }) => artifact.path));
});

it.each([
  'receipt',
  'current locator',
  'duplicate output',
  'failed sibling',
  'selected row',
])('rejects inconsistent %s evidence', async (fault) => {
  const input = await fixture();
  const publication = input.publication.publication;
  if (fault === 'receipt')
    input.rows.splice(
      0,
      input.rows.length,
      ...input.rows.map((row) => ({
        ...row,
        publication: {
          ...publication,
          receipt: { ...publication.receipt, sourceRevision: 'different' },
        },
      })),
    );
  if (fault === 'current locator')
    input.rows.splice(
      0,
      input.rows.length,
      ...input.rows.map((row) => ({
        ...row,
        publication: {
          ...publication,
          current: { ...defined(publication.current), generation: publication.generation + 1 },
        },
      })),
    );
  if (fault === 'duplicate output')
    input.rows.splice(
      0,
      input.rows.length,
      ...input.rows.map((row) => ({
        ...row,
        publication: {
          ...publication,
          outputs: [...publication.outputs, defined(publication.outputs[0])],
        },
      })),
    );
  if (fault === 'failed sibling')
    input.rows[1] = { ...defined(input.rows[1]), lifecycle: 'failed' };
  const selected =
    fault === 'selected row'
      ? { ...defined(input.rows[0]), sourceKey: 'incorrect' }
      : defined(input.rows[0]);
  const result = await captureAssetPublication(
    selected,
    input.rows,
    { enumerate: async () => ok(input.rows), subscribe: () => () => {} },
    input.fetcher,
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'pack-v2-envelope-invalid' } });
});

it('accepts semantically equal publication objects with a different JSON field order', async () => {
  const input = await fixture();
  const row = defined(input.rows[1]);
  input.rows[1] = {
    ...row,
    publication: Object.fromEntries(
      Object.entries(defined(row.publication)).reverse(),
    ) as NonNullable<CatalogEntry['publication']>,
  };
  expect(
    (
      await captureAssetPublication(
        defined(input.rows[0]),
        input.rows,
        { enumerate: async () => ok(input.rows), subscribe: () => () => {} },
        input.fetcher,
      )
    ).ok,
  ).toBe(true);
});

it('preserves cancellation and does not start an already cancelled capture', async () => {
  const input = await fixture();
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn(input.fetcher);
  expect(
    await captureAssetPublication(
      defined(input.rows[0]),
      input.rows,
      { enumerate: async () => ok(input.rows), subscribe: () => () => {} },
      fetcher,
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { code: 'asset-load-cancelled' } });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  undefined,
  'pack-index.json',
  './pack-index.json',
])('uses the Catalog locator authority for %s', async (catalogUrl) => {
  const input = await fixture();
  vi.stubGlobal('location', new URL('https://delivered.invalid/game/index.html'));
  try {
    const path = catalogUrl === undefined ? '/content/pack.json' : '../content/pack.json';
    const publication = {
      ...input.publication.publication,
      current: { ...defined(input.publication.publication.current), packageUrl: path },
    };
    const rows = input.rows.map((row) => ({ ...row, packageUrl: path, publication }));
    const fetcher: typeof fetch = async (url, init) =>
      String(url) === catalogUrl
        ? new Response(JSON.stringify(rows))
        : input.fetcher(new URL(String(url), 'https://delivered.invalid').href, init);
    const source =
      catalogUrl === undefined
        ? createCatalogSource({ entries: rows })
        : createCatalogSource({ url: catalogUrl, fetch: fetcher });
    const parsed = (await source.enumerate()).unwrap();
    const result = await captureAssetPublication(defined(parsed[0]), parsed, source, fetcher);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('replays artifact paths using the same normalization as the ordinary loader', async () => {
  const original = await fixture();
  const publication = createRuntimePackPublication({
    scopeId: 'delivered',
    sourcePath: 'original.pack',
    sourceRevision: 'encoded-artifact-path',
    packageUrl,
    pack: {
      assets: original.publication.pack.assets.map((asset) => ({
        ...asset,
        artifacts: { body: { ...defined(asset.artifacts.body), path: 'nested%2Fmesh.bin.zst' } },
      })),
    },
    sourceKeys: new Map([
      [guid, 'mesh/main'],
      [sibling, 'mesh/sibling'],
    ]),
  });
  const rows = original.rows.map((row) => ({ ...row, publication: publication.publication }));
  const transport: typeof fetch = async (url) =>
    String(url) === packageUrl
      ? new Response(JSON.stringify(publication.pack))
      : String(url) === new URL('nested/mesh.bin.zst', packageUrl).href
        ? new Response(new Uint8Array(original.compressed))
        : new Response('', { status: 404 });
  const captured = (
    await captureAssetPublication(
      defined(rows[0]),
      rows,
      createCatalogSource({ entries: rows }),
      transport,
    )
  ).unwrap();
  const target = new RuntimePackProducer({
    scopeId: 'offline',
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(state.rows, fetcher, undefined, {
        ...{ dependencies },
        decoders: runtimePackDecoders,
      }),
  });
  const registry = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  registry.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  registry.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    const restored = await target.restore(await createFixedRuntimePackSnapshot(captured));
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    registry.setCatalogSource(target.catalog, target.fetch);
    const loaded = (await loadFixtureAsset(registry, guid, 'mesh')).unwrap();
    expect(loaded.indices).toEqual(original.original.indices);
  } finally {
    registry.clearCatalogSource();
    target.dispose();
  }
});
