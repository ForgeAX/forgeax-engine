import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanAssetCookContract } from '../asset-cook-contract.mjs';

describe('asset cook contract sweep', () => {
  it('scans the three channels and reports legacy protocol hits as failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'asset-cook-contract-'));
    mkdirSync(join(root, 'packages/assets-runtime/src'), { recursive: true });
    for (const fixture of [
      'apps/hello/cube/assets/cube-mesh.pack.json',
      'apps/hello/room/assets/room.pack.json',
      'apps/hello/scene-nesting/assets/outer-scene.pack.json',
      'packages/runtime/assets/builtin/cube.pack.json',
    ]) {
      mkdirSync(join(root, dirname(fixture)), { recursive: true });
    }
    writeFileSync(
      join(root, 'packages/assets-runtime/src/fixture.ts'),
      'export const ok = true;\n',
    );
    writeFileSync(join(root, 'apps/hello/fixture.mjs'), 'export const ok = true;\n');
    const pack = JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [{ guid: 'g', kind: 'mesh', payload: {}, refs: [], artifacts: {} }],
    });
    for (const fixture of [
      'apps/hello/cube/assets/cube-mesh.pack.json',
      'apps/hello/room/assets/room.pack.json',
      'apps/hello/scene-nesting/assets/outer-scene.pack.json',
      'packages/runtime/assets/builtin/cube.pack.json',
    ])
      writeFileSync(join(root, fixture), pack);

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
});
