import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOfflineAssetEvidence } from '../evidence/offline-evidence.js';

const guid = '11111111-1111-4111-8111-111111111111';

describe('offline evidence adapter', () => {
  it('joins source inventory, catalog, receipt, and package verification', async () => {
    const result = await buildOfflineAssetEvidence({
      guid,
      source: { origin: 'sourceMeta', inputFingerprint: 'fp-1' },
      locator: { packageUrl: '/assets/config.pack.json', cookReceiptUrl: '/receipts/config.json' },
      receipt: {
        guid,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'fp-1',
        outputDigest: 'digest-1',
      },
      package: {
        guid,
        digest: 'digest-1',
        artifacts: {
          data: {
            path: 'artifacts/data.bin',
            mediaType: 'application/octet-stream',
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageUrl).toBe('/assets/config.pack.json');
    expect(result.value.cook.freshness).toBe('current');
    expect(result.value.package?.status).toBe('passed');
  });

  it('keeps runtime and WS outside the offline adapter boundary', () => {
    expect(buildOfflineAssetEvidence.toString()).not.toContain('assets.load');
    expect(buildOfflineAssetEvidence.toString()).not.toContain('WebSocket');
    expect(buildOfflineAssetEvidence.toString()).not.toContain('AssetRegistry');
  });

  it.each([
    ['offline reader', 'export const read = (reader, guid) => reader.readByGuid(guid);', 0],
    ['runtime load', 'engine.assets.load(guid, "mesh");', 1],
    ['runtime package', 'import { Engine } from "@forgeax/engine-runtime";', 1],
    ['asset package', 'import { AssetRegistry } from "@forgeax/engine-assets-runtime";', 1],
    ['SDK runtime root', 'import { Engine } from "@forgeax/engine";', 1],
    ['SDK asset subpath', 'import { AssetRegistry } from "@forgeax/engine/assets-runtime";', 1],
    ['dynamic runtime import', 'await import("@forgeax/engine/runtime");', 1],
    ['template runtime import', 'await import(`@forgeax/engine/runtime`);', 1],
    ['nested asset import', 'await import("@forgeax/engine-assets-runtime/subpath");', 1],
  ])('enforces the Pack boundary for %s while allowing game asset loading', async (_, source, status) => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-boundary-'));
    try {
      const script = join(root, 'packages/pack/scripts/check-no-assets-load.mjs');
      const files = [
        [
          script,
          await readFile(
            new URL('../../scripts/check-no-assets-load.mjs', import.meta.url),
            'utf8',
          ),
        ],
        [join(root, 'packages/pack/src/reader.ts'), source],
        [join(root, 'packages/runtime/src/game.ts'), 'engine.assets.load(guid, "mesh");'],
        [join(root, 'apps/game/src/main.ts'), 'engine.assets.load(guid, "scene");'],
        [join(root, 'templates/game/src/main.ts'), 'engine.assets.load(guid, "scene");'],
      ];
      for (const [path, content] of files) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      if (status === 1) expect(result.stderr).toContain('packages/pack/src/reader.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects a verified cook product without requiring DDC storage', async () => {
    const result = await buildOfflineAssetEvidence({
      guid,
      product: {
        guid,
        payload: { kind: 'direct-asset' },
        refs: [],
        artifacts: {
          data: { path: 'assets/data.bin', mediaType: 'application/octet-stream' },
        },
        digest: 'digest-direct',
        receipt: {
          guid,
          origin: 'authoredPack',
          status: 'succeeded',
          inputFingerprint: 'direct-input',
          outputDigest: 'digest-direct',
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cook.freshness).toBe('notApplicable');
    expect(result.value.package?.status).toBe('passed');
  });

  it('keeps a failed artifact in the offline evidence boundary', async () => {
    const result = await buildOfflineAssetEvidence({
      guid,
      source: { origin: 'sourceMeta', inputFingerprint: 'fp-failed' },
      locator: { packageUrl: '/assets/failed.pack.json' },
      package: {
        guid,
        digest: 'digest-failed',
        artifacts: {
          data: {
            path: 'assets/data.bin',
            mediaType: 'application/octet-stream',
            verification: 'failed',
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.package?.status).toBe('failed');
    expect(result.value.cook.freshness).toBe('unknown');
  });
});
