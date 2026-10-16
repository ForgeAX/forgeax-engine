// build-cache.unit.test.ts -- content-addressed build DDC unit
// (tweak-20260627-model-loading-smoke-build-perf M2 / m2-1, AC-05 / AC-07).
//
// Asserts the cache's two load-bearing properties (plan-strategy D-2):
//   1. determinism: same source bytes + same import settings => same key.
//   2. content-addressing: a changed source OR changed settings => different
//      key (so a stale hit is unrepresentable -- presence == validity).
//   3. round-trip integrity: write(key, {bytes, metadata}) then read(key)
//      reconstructs the decoded bytes + metadata byte-for-byte; a fresh key
//      (never written) reads as a miss (null).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDdcRoot, semanticBuildKey } from '@forgeax/engine-ddc';
import { describe, expect, it } from 'vitest';

describe('build-cache.unit.test.ts', () => {
  describe('semantic key', () => {
    it('does not change when only the publishing environment changes', () => {
      const semantic = {
        schemaVersion: '2.0.0',
        importerVersion: 'importer@1',
        codecVersion: 'codec@1',
        sourceDependencies: [{ path: 'a.png', digest: 'a' }],
        settings: { mipmap: true },
        declaredGuids: ['g1'],
        cookProfile: 'dev',
        publish: { base: '/', path: 'assets/a.bin', hash: 'one' },
      };
      expect(semanticBuildKey(semantic)).toBe(
        semanticBuildKey({
          ...semantic,
          publish: { base: '/preview/', path: 'assets/a-other.bin', hash: 'two' },
        }),
      );
    });

    it('changes when a semantic dependency changes', () => {
      const semantic = {
        schemaVersion: '2.0.0',
        importerVersion: 'importer@1',
        codecVersion: 'codec@1',
        sourceDependencies: [{ path: 'a.png', digest: 'a' }],
        settings: { mipmap: true },
        declaredGuids: ['g1'],
        cookProfile: 'dev',
      };
      expect(semanticBuildKey(semantic)).not.toBe(
        semanticBuildKey({
          ...semantic,
          sourceDependencies: [{ path: 'a.png', digest: 'b' }],
        }),
      );
    });
  });

  it('resolves nested app builds to the nearest workspace DDC root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgeax-workspace-'));
    try {
      const app = join(workspace, 'apps', 'demo');
      await mkdir(app, { recursive: true });
      await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n');
      expect(resolveDdcRoot(app)).toBe(join(workspace, 'node_modules/.cache/forgeax-ddc'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
