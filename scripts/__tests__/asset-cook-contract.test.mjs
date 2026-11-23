import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanAssetCookContract, scanPackAuthoring } from '../asset-cook-contract.mjs';

describe('asset cook contract sweep', () => {
  it('scans the three channels and reports legacy protocol hits as failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'asset-cook-contract-'));
    mkdirSync(join(root, 'packages/assets-runtime/src'), { recursive: true });
    mkdirSync(join(root, 'apps/hello'), { recursive: true });
    writeFileSync(
      join(root, 'packages/assets-runtime/src/fixture.ts'),
      'export const ok = true;\n',
    );
    writeFileSync(join(root, 'apps/hello/fixture.mjs'), 'export const ok = true;\n');
    writeFileSync(join(root, 'apps/hello/fixture.pack.json'), '{}');

    expect(scanAssetCookContract(root).ok).toBe(true);
    writeFileSync(
      join(root, 'packages/assets-runtime/src/legacy.ts'),
      'const relativeUrl = "x";\n',
    );
    const failed = scanAssetCookContract(root);
    expect(failed.ok).toBe(false);
    expect(failed.errors.some((error) => error.includes('relativeUrl'))).toBe(true);
  });

  it('keeps the three scan channels explicit for downstream migration tasks', () => {
    const report = scanAssetCookContract();
    expect(report.channels.map(([channel]) => channel)).toEqual([
      'typescript-import',
      'compiled-fixture',
      'json-meta-pack',
    ]);
    expect(report.channels.every(([, files]) => files.length > 0)).toBe(true);
  });

  it('audits current authoring files regardless of name and skips published Runtime Packs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pack-authoring-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(
        join(root, 'renamed.pack.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: '019fb264-1000-7000-8000-000000000104',
          assets: {},
        }),
      );
      writeFileSync(join(root, 'renamed.runtime-pack.json'), '{"schemaVersion":"2.0.0"}');
      expect(await scanPackAuthoring(root)).toEqual({ count: 1, errors: [] });

      writeFileSync(join(root, 'renamed.pack.json'), '{"schemaVersion":"2.0.0"}');
      const audit = await scanPackAuthoring(root);
      expect(audit.count).toBe(1);
      expect(audit.errors).toEqual([expect.stringContaining('renamed.pack.json:')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
