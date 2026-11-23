import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCatalogWire } from '../catalog-wire.js';
import { inspectOfflineAsset } from '../cli-asset.js';
import { createRuntimePackPublication } from '../runtime-publication.js';

const guid = '11111111-1111-4111-8111-111111111111';
const tempRoots: string[] = [];

async function evidenceFixture(
  wire: 'array' | 'rows-container' | 'scoped' | 'degraded',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-asset-evidence-'));
  tempRoots.push(root);
  await mkdir(join(root, 'assets', 'artifacts'), { recursive: true });
  const bytes = Buffer.from('data');
  const digest = createHash('sha256').update(bytes).digest('base64');
  await writeFile(join(root, 'assets', 'artifacts', 'data.bin'), bytes);
  await writeFile(
    join(root, 'assets', 'config.runtime-pack.json'),
    JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'config',
          payload: { answer: 42 },
          refs: [],
          artifacts: {
            data: {
              path: 'artifacts/data.bin',
              mediaType: 'application/octet-stream',
              byteLength: bytes.byteLength,
              integrity: { algorithm: 'sha256', digest },
            },
          },
        },
      ],
    }),
  );
  await writeFile(join(root, 'config.source'), 'source declaration');
  const meta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'config.source',
    importSettings: {},
    subAssets: [{ guid, sourceIndex: 0, kind: 'config' }],
  };
  const metaRaw = JSON.stringify(meta);
  const inputFingerprint = createHash('sha256').update(metaRaw).digest('base64');
  await writeFile(join(root, 'config.source.meta.json'), metaRaw);
  await writeFile(
    join(root, 'receipts.json'),
    JSON.stringify({
      guid,
      origin: 'sourceMeta',
      status: 'succeeded',
      inputFingerprint,
      outputDigest: digest,
    }),
  );
  const { publication } = createRuntimePackPublication({
    scopeId: 'cli-fixture',
    sourcePath: 'config.source.meta.json',
    sourceRevision: inputFingerprint,
    packageUrl: '/assets/config.runtime-pack.json',
    pack: {
      assets: [guid, '22222222-2222-4222-8222-222222222222'].map((guid) => ({
        guid,
        kind: 'config',
        payload: { answer: 42 },
        refs: [],
      })),
    },
  });
  const rows = publication.outputs.map((output) => ({
    guid: output.guid,
    packageUrl: '/assets/config.runtime-pack.json',
    cookReceiptUrl: '/receipts.json',
    kind: 'config',
    sourcePath: 'config.source.meta.json',
    publication,
  }));
  const catalog =
    wire === 'array'
      ? rows
      : wire === 'rows-container'
        ? { entries: rows }
        : encodeCatalogWire({
            schemaVersion: 'runtime-catalog-snapshot-v1',
            scopeId: 'cli-fixture',
            generation: 1,
            authority: wire === 'degraded' ? 'degraded' : 'authoritative',
            entries: rows,
            diagnostics: [],
          });
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog));
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

describe('offline asset evidence', () => {
  it.each([
    'array',
    'rows-container',
    'scoped',
    'degraded',
  ] as const)('returns the shared evidence JSON for offline inspection (%s)', async (wire) => {
    const project = await evidenceFixture(wire);
    const evidence = (
      await inspectOfflineAsset({ guid, project, catalog: join(project, 'catalog.json') })
    ).unwrap();
    expect(evidence.guid).toBe(guid);
    expect(evidence.packageUrl).toBe('/assets/config.runtime-pack.json');
    expect(evidence.cook.status).toBe('ready');
    expect(evidence.cook.freshness).toBe('current');
    const dataArtifact = evidence.artifacts.data;
    expect(dataArtifact).toBeDefined();
    if (dataArtifact === undefined) return;
    expect(dataArtifact.verification).toBe('passed');
  });

  it('returns the structured invalid GUID error', async () => {
    expect(
      await inspectOfflineAsset({
        guid: 'not-a-guid',
        project: '/project',
        catalog: '/project/catalog.json',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'pack-guid-malformed',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: expect.any(Object),
      },
    });
  });
});

it.each([
  'valid',
  'outside-corruption',
  'window-corruption',
  'out-of-bounds',
])('verifies stored chunk and selected artifact in offline evidence: %s', async (mode) => {
  const project = await evidenceFixture('array');
  const file = join(project, 'assets', 'config.runtime-pack.json');
  const pack = JSON.parse(await readFile(file, 'utf8'));
  const stored = Buffer.from('_data_');
  pack.assets[0].artifacts.data.byteRange = {
    offset: 1,
    length: mode === 'out-of-bounds' ? 99 : 4,
    bundleDigest: `sha256:${createHash('sha256').update(stored).digest('hex')}`,
  };
  if (mode === 'outside-corruption') stored[0] = 0;
  if (mode === 'window-corruption') stored[2] = 0;
  await writeFile(file, JSON.stringify(pack));
  await writeFile(join(project, 'assets', 'artifacts', 'data.bin'), stored);
  const result = (
    await inspectOfflineAsset({ guid, project, catalog: join(project, 'catalog.json') })
  ).unwrap();
  expect(result.artifacts.data?.verification).toBe(mode === 'valid' ? 'passed' : 'failed');
});

it('verifies compressed Catalog, Pack and receipt documents through the shared codec', async () => {
  const project = await evidenceFixture('array');
  for (const relative of ['catalog.json', 'assets/config.runtime-pack.json', 'receipts.json']) {
    const file = join(project, relative);
    const encoded = await compressZstd(await readFile(file));
    if (!encoded.ok) throw encoded.error;
    await writeFile(file, encoded.value);
  }
  const result = (
    await inspectOfflineAsset({ guid, project, catalog: join(project, 'catalog.json') })
  ).unwrap();
  expect(result).toMatchObject({
    guid,
    cook: { status: 'ready', freshness: 'current' },
    artifacts: { data: { verification: 'passed' } },
  });
});
