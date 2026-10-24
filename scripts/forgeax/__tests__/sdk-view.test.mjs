import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { stageViewToolPackage, VIEW_TOOL_FILES } from '../sdk-view.mjs';

async function fixture(imports) {
  const directory = await mkdtemp(resolve(tmpdir(), 'sdk-view-test-'));
  const view = resolve(directory, 'view');
  const output = resolve(directory, 'output');
  for (const path of ['dist/viewer', 'skills', 'scripts'])
    await mkdir(resolve(view, path), { recursive: true });
  for (const path of VIEW_TOOL_FILES.filter((file) => file.startsWith('scripts/')))
    await cp(resolve(import.meta.dirname, '../../../tools/view', path), resolve(view, path));
  for (const file of ['host.pack.json', 'README.md', 'LICENSE'])
    await writeFile(
      resolve(view, file),
      file === 'LICENSE' ? 'Apache License Version 2.0' : 'fixture',
    );
  await writeFile(
    resolve(view, 'package.json'),
    JSON.stringify({
      name: '@forgeax/view',
      version: '0.2.0',
      license: 'Apache-2.0',
      bin: { view: 'dist/cli.mjs' },
      scripts: { build: 'build' },
      devDependencies: { typescript: '*' },
      exports: { '.': './dist/index.mjs', './build': './scripts/build-tool.mjs' },
      dependencies: {
        '@forgeax/engine': 'workspace:*',
        '@forgeax/view-viewer': 'workspace:*',
        react: '^19.1.0',
      },
    }),
  );
  await writeFile(
    resolve(view, 'dist/native-build.json'),
    JSON.stringify({ outputs: { 'frontend.mjs': { imports } } }),
  );
  await writeFile(resolve(view, 'dist/viewer/panel-graph.json'), 'private-source-paths');
  await writeFile(resolve(view, 'dist/index.mjs'), "export * from '@forgeax/engine-profiler';\n");
  return { directory, view, output };
}
test('the official tool has one Engine version and no private workspace dependency', async () => {
  const f = await fixture([{ external: true, path: '@forgeax/engine-profiler' }]);
  try {
    await stageViewToolPackage(f.view, f.output, '1.2.3');
    const value = JSON.parse(await readFile(resolve(f.output, 'package.json')));
    assert.equal(value.private, true, 'View is an SDK-local tool, never an npm publication');
    assert.equal(value.version, '1.2.3');
    assert.equal(
      await readFile(resolve(f.output, 'dist/index.mjs'), 'utf8'),
      "export * from '@forgeax/engine/profiler';\n",
    );
    assert.deepEqual(value.dependencies, {
      '@forgeax/engine': '1.2.3',
      react: '^19.1.0',
    });
    for (const key of ['bin', 'scripts', 'devDependencies', 'forgeax'])
      assert.equal(value[key], undefined);
    assert.equal(value.exports['./build'], undefined);
    assert.equal(value.license, 'Apache-2.0');
    for (const probe of [
      'browser-proof-workload.mjs',
      'verify-runtime-content-engine.mjs',
      'verify-game3d-workspace.mjs',
    ]) {
      assert.ok(value.files.includes(`scripts/${probe}`));
      const staged = await readFile(resolve(f.output, 'scripts', probe), 'utf8');
      const original = await readFile(resolve(f.view, 'scripts', probe), 'utf8');
      assert.equal(
        staged,
        original.replaceAll(/@forgeax\/engine-([a-z][a-z0-9-]*)/g, '@forgeax/engine/$1'),
      );
      assert.ok(!staged.includes('../packages/'), 'installed probes use public package imports');
      for (const [, specifier] of staged.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g))
        await readFile(resolve(f.output, 'scripts', specifier));
    }
    assert.ok(!value.files.includes('scripts'), 'contributor scripts remain outside the SDK');
    await assert.rejects(readFile(resolve(f.output, 'dist/native-build.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(f.output, 'dist/viewer/panel-graph.json')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test('publication rejects a workspace package that escaped the native bundle', async () => {
  const f = await fixture([{ external: true, path: '@forgeax/view-viewer' }]);
  try {
    await assert.rejects(
      stageViewToolPackage(f.view, f.output, '1.2.3'),
      /sdk-view-unbundled-workspace-package/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('the packed tool loads the real cold-import dependency outside its source checkout', async () => {
  const f = await fixture([]);
  const execute = promisify(execFile);
  try {
    await stageViewToolPackage(f.view, f.output, '1.2.3');
    const { stdout } = await execute(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', f.directory],
      { cwd: f.output },
    );
    const [{ filename }] = JSON.parse(stdout);
    const installed = resolve(f.directory, 'installed');
    await mkdir(installed);
    await execute('tar', ['-xzf', resolve(f.directory, filename), '-C', installed]);
    await rm(f.view, { recursive: true, force: true });
    const { stdout: imported } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { importRuntimeContent } from './package/scripts/runtime-content-import.mjs'; import { savePreviewRhiEvidence } from './package/scripts/preview-rhi-evidence.mjs'; console.log(typeof importRuntimeContent, typeof savePreviewRhiEvidence);",
      ],
      { cwd: installed },
    );
    assert.equal(imported.trim(), 'function function');
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
