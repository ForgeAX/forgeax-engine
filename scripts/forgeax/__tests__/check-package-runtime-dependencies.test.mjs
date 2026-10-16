import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  checkPackageRuntimeDependencies,
  extractRuntimeEngineImports,
} from '../check-package-runtime-dependencies.mjs';

async function fixture({
  code,
  dependencies = {},
  devDependencies = {},
  optionalDependencies,
  peerDependencies,
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-package-runtime-dependencies-'));
  const packageRoot = resolve(root, 'packages', 'fixture');
  await mkdir(resolve(packageRoot, 'dist'), { recursive: true });
  await writeFile(
    resolve(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@forgeax/engine-fixture',
        version: '0.0.0',
        private: false,
        dependencies,
        devDependencies,
        ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
        ...(peerDependencies === undefined ? {} : { peerDependencies }),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(resolve(packageRoot, 'dist/index.mjs'), code ?? 'export const ok = true;\n');
  return root;
}

test('extracts static, side-effect, dynamic, and require imports with subpaths', () => {
  const imports = extractRuntimeEngineImports(`
    import value from '@forgeax/engine-import/mesh-bin';
    import '@forgeax/engine-font/font-importer';
    export { thing } from '@forgeax/engine-image';
    const dynamic = import('@forgeax/engine-runtime/internal/renderer-host');
    const required = require('@forgeax/engine-fbx');
    const generated = "import { createApp } from '@forgeax/engine/not-a-runtime-import';";
  `);
  assert.deepEqual(
    imports.map(({ dependency, specifier }) => [dependency, specifier]),
    [
      ['@forgeax/engine-import', '@forgeax/engine-import/mesh-bin'],
      ['@forgeax/engine-font', '@forgeax/engine-font/font-importer'],
      ['@forgeax/engine-image', '@forgeax/engine-image'],
      ['@forgeax/engine-runtime', '@forgeax/engine-runtime/internal/renderer-host'],
      ['@forgeax/engine-fbx', '@forgeax/engine-fbx'],
    ],
  );
});

test('rejects a runtime import declared only as a development dependency', async () => {
  const root = await fixture({
    code: "import { parse } from '@forgeax/engine-import';\n",
    devDependencies: { '@forgeax/engine-import': 'workspace:*' },
  });
  try {
    const result = await checkPackageRuntimeDependencies({
      packagesRoot: resolve(root, 'packages'),
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].dependency, '@forgeax/engine-import');
    assert.equal(result.violations[0].devOnly, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts runtime, optional, and peer declarations and ignores declaration files', async () => {
  const root = await fixture({
    code: "import '@forgeax/engine-import';\nimport '@forgeax/engine-font';\nimport '@forgeax/engine-image';\n",
    dependencies: { '@forgeax/engine-import': 'workspace:*' },
    optionalDependencies: { '@forgeax/engine-font': 'workspace:*' },
    peerDependencies: { '@forgeax/engine-image': 'workspace:*' },
  });
  try {
    const packageRoot = resolve(root, 'packages', 'fixture', 'dist');
    await writeFile(
      resolve(packageRoot, 'index.d.ts'),
      "import type { ImageAsset } from '@forgeax/engine-missing';\n",
    );
    const result = await checkPackageRuntimeDependencies({
      packagesRoot: resolve(root, 'packages'),
    });
    assert.deepEqual(result.violations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
