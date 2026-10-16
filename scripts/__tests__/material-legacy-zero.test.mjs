import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_SURFACE_PATHS,
  scanMaterialLegacySurface,
} from '../forgeax/check-material-legacy-surface.mjs';

describe('material legacy zero gate', () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-material-legacy-zero-'));
    roots.push(root);
    await Promise.all(
      CORE_SURFACE_PATHS.map((path) => mkdir(join(root, path), { recursive: true })),
    );
    return root;
  }

  it('checks the three core channels and ignores unrelated packages', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'packages/types/material.ts'),
      "export type Legacy = 'paramValues';\n",
    );
    await writeFile(
      join(root, 'packages/shader/source.wgsl.meta.json'),
      JSON.stringify({ materialShaderIdentifier: 'legacy' }),
    );
    await writeFile(
      join(root, 'scripts/fixture.mjs'),
      "const value = { passes: [{ shader: 'legacy' }] };\n",
    );
    await mkdir(join(root, 'packages/other/src'), { recursive: true });
    await writeFile(join(root, 'packages/other/src/ignored.ts'), 'const paramValues = {};\n');

    const report = scanMaterialLegacySurface(root, { paths: CORE_SURFACE_PATHS });
    expect(report.ok).toBe(false);
    expect(report.channels.map(([channel]) => channel)).toEqual([
      'typescript-import',
      'script-fixture-literal',
      'json-asset-literal',
    ]);
    expect(report.hits.every(({ path }) => !path.includes('packages/other'))).toBe(true);
  });

  it('returns zero core hits for the new authoring vocabulary', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'packages/types/material.ts'),
      "export const material = { kind: 'material', values: { baseColor: [1, 1, 1, 1] } };\n",
    );
    await writeFile(
      join(root, 'packages/shader/source.wgsl'),
      '#define_import_path project::standard\n',
    );
    await writeFile(join(root, 'scripts/fixture.mjs'), 'export const clean = true;\n');

    const report = scanMaterialLegacySurface(root, { paths: CORE_SURFACE_PATHS });
    expect(report.ok).toBe(true);
    expect(report.channels).toEqual([
      ['typescript-import', []],
      ['script-fixture-literal', []],
      ['json-asset-literal', []],
    ]);
  });

  it('does not scan canonical inventory metadata as a legacy consumer', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'scripts/check-material-contract-inventory.mjs'),
      "const sidecar = '.wgsl.meta.json';\n",
    );
    await writeFile(
      join(root, 'scripts/material-contract-inventory.json'),
      JSON.stringify({ materialSidecars: ['source.wgsl.meta.json'] }),
    );
    await writeFile(join(root, 'scripts/real-consumer.mjs'), "const value = 'paramValues';\n");

    const report = scanMaterialLegacySurface(root, { paths: ['scripts'] });
    expect(report.ok).toBe(false);
    expect(report.hits).toEqual([
      {
        channel: 'script-fixture-literal',
        path: 'scripts/real-consumer.mjs',
        patterns: ['param-values'],
      },
    ]);
  });
});
