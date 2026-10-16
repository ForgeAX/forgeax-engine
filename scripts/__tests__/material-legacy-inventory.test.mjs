import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanMaterialLegacySurface } from '../forgeax/check-material-legacy-surface.mjs';

describe('material legacy surface inventory', () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-inventory-'));
    roots.push(root);
    await mkdir(join(root, 'packages/sample/src'), { recursive: true });
    await mkdir(join(root, 'apps/sample/scripts'), { recursive: true });
    await mkdir(join(root, 'apps/sample/assets'), { recursive: true });
    return root;
  }

  it('scans TS, script or fixture literals, and JSON asset literals', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'packages/sample/src/author.ts'),
      "import type { ShaderAsset } from '@forgeax/engine-types';\n",
    );
    await writeFile(
      join(root, 'apps/sample/scripts/material.cjs'),
      "const material = { passes: [{ shader: 'legacy' }], paramValues: {} };\n",
    );
    await writeFile(
      join(root, 'apps/sample/assets/material.pack.json'),
      JSON.stringify({ passes: [{ shader: 'legacy' }], uvSet: 0 }),
    );

    const report = scanMaterialLegacySurface(root);
    expect(report.ok).toBe(false);
    expect(report.channels.map(([channel]) => channel)).toEqual([
      'typescript-import',
      'script-fixture-literal',
      'json-asset-literal',
    ]);
    expect(report.channels.every(([, files]) => files.length === 1)).toBe(true);
    expect(report.hits.map(({ path }) => path)).toEqual([
      'apps/sample/assets/material.pack.json',
      'apps/sample/scripts/material.cjs',
      'packages/sample/src/author.ts',
    ]);
  });

  it('returns deterministic empty channels after the legacy literals are removed', async () => {
    const root = await fixture();
    await writeFile(join(root, 'packages/sample/src/author.ts'), 'export const clean = true;\n');
    await writeFile(join(root, 'apps/sample/scripts/material.mjs'), 'export const clean = true;\n');
    await writeFile(
      join(root, 'apps/sample/assets/material.pack.json'),
      JSON.stringify({ kind: 'material', values: {} }),
    );

    const first = scanMaterialLegacySurface(root);
    const second = scanMaterialLegacySurface(root);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.channels).toEqual([
      ['typescript-import', []],
      ['script-fixture-literal', []],
      ['json-asset-literal', []],
    ]);
  });

  it('keeps deleted cooker and facade paths out of the current owner map', async () => {
    const root = process.cwd();
    const deletedPaths = [
      'packages/vite-plugin-pack/src/ddc-lifecycle-assembly.ts',
      'packages/vite-plugin-pack/src/material/cook-finalizer.ts',
    ];
    for (const path of deletedPaths) {
      await expect(access(join(root, path))).rejects.toThrow();
    }
    await expect(
      access(join(root, 'packages/shader-compiler/src/material/native-cooker.ts')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(root, 'packages/pack/src/evidence/material-cook.ts')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(root, 'packages/render/src/assembly/material')),
    ).resolves.toBeUndefined();
  });
});
