import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCatalogWire } from '../catalog-wire.js';
import { runCliAsset } from '../cli-asset.js';
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
    join(root, 'assets', 'config.pack.json'),
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
    packageUrl: '/assets/config.pack.json',
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
    packageUrl: '/assets/config.pack.json',
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

describe('asset evidence CLI contract', () => {
  it('advertises the complete AI inspection and recovery vocabulary', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCliAsset(['--help'], {
      stdoutWrite: (line) => stdout.push(line),
      stderrWrite: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const help = stdout.join('\n');
    for (const operation of [
      'inspect',
      'rebuild',
      'cold-cook',
      'preview-LKG',
      'override',
      'promote',
      'stop-publish',
    ]) {
      expect(help).toContain(operation);
    }
  });

  it.each([
    'array',
    'rows-container',
    'scoped',
    'degraded',
  ] as const)('returns the shared evidence JSON for lookup --guid --json (%s)', async (wire) => {
    const project = await evidenceFixture(wire);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCliAsset(
      [
        'lookup',
        '--guid',
        guid,
        '--project',
        project,
        '--catalog',
        join(project, 'catalog.json'),
        '--json',
      ],
      { stdoutWrite: (line) => stdout.push(line), stderrWrite: (line) => stderr.push(line) },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const evidence = JSON.parse(stdout[0] as string) as {
      guid: string;
      packageUrl?: string;
      cook: { status: string; freshness: string };
      artifacts: Record<string, { verification: string }>;
    };
    expect(evidence.guid).toBe(guid);
    expect(evidence.packageUrl).toBe('/assets/config.pack.json');
    expect(evidence.cook.status).toBe('ready');
    expect(evidence.cook.freshness).toBe('current');
    const dataArtifact = evidence.artifacts.data;
    expect(dataArtifact).toBeDefined();
    if (dataArtifact === undefined) return;
    expect(dataArtifact.verification).toBe('passed');
  });

  it('emits exactly one structured JSON error and no free-text protocol', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCliAsset(
      [
        'verify',
        '--guid',
        'not-a-guid',
        '--project',
        '/project',
        '--catalog',
        '/project/catalog.json',
        '--json',
      ],
      { stdoutWrite: (line) => stdout.push(line), stderrWrite: (line) => stderr.push(line) },
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0] as string)).toMatchObject({
      code: 'pack-guid-malformed',
      expected: expect.any(String),
      hint: expect.any(String),
      detail: expect.any(Object),
    });
  });
});
