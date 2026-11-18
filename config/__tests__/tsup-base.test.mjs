import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = process.env.FORGEAX_TEST_TMPDIR ?? resolve(repoRoot, '..', '.tmp');
const tsup = resolve(repoRoot, 'node_modules/tsup/dist/cli-default.js');
const baseConfig = pathToFileURL(resolve(repoRoot, 'config/tsup.base.ts')).href;

function write(root, file, contents) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), contents);
}

function build(root) {
  const result = spawnSync(process.execPath, [tsup], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('successful split production removes obsolete chunks without deleting declaration or source assets', (t) => {
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, 'tsup-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'package');
  write(pkg, 'package.json', '{"type":"module"}');
  write(
    pkg,
    'tsup.config.ts',
    `import { baseTsupConfig } from ${JSON.stringify(baseConfig)};
export default [
  { ...baseTsupConfig, entry: ['src/standalone.ts'] },
  { ...baseTsupConfig, entry: ['src/first.ts', 'src/second.ts'], splitting: true }
];
`,
  );
  write(pkg, 'src/standalone.ts', 'export const standalone = true;');
  write(pkg, 'src/shared.ts', 'export const shared = { value: 1 };');
  write(pkg, 'src/lazy.ts', 'export const lazy = 1;');
  for (const entry of ['first', 'second']) {
    write(
      pkg,
      `src/${entry}.ts`,
      'export { shared } from "./shared"; export const load = () => import("./lazy");',
    );
  }
  const preserved = [
    'index.d.ts',
    'index.d.ts.map',
    '.tsbuildinfo',
    'shader.wgsl',
    'source.mjs',
    'source.mjs.map',
    'native.wasm',
    'manifest.json',
  ];
  for (const file of preserved) write(pkg, `dist/${file}`, `preserve:${file}`);
  write(root, 'sibling/chunk-OUTSIDE.mjs', 'sibling');
  write(root, 'outside/chunk-LINKED.mjs', 'outside');
  symlinkSync(join(root, 'outside'), join(pkg, 'dist/linked'), 'junction');
  build(pkg);
  const firstChunks = readdirSync(join(pkg, 'dist')).filter((file) =>
    /-[A-Z0-9]{8}\.mjs$/.test(file),
  );
  assert.ok(firstChunks.length > 0, 'the real producer must emit a shared hashed chunk');
  assert.ok(
    firstChunks.some((file) => file.startsWith('lazy-')),
    'dynamic imports use named hashed chunks',
  );
  write(pkg, 'src/lazy.ts', 'export const lazy = ;');
  const failedBuild = spawnSync(process.execPath, [tsup], {
    cwd: pkg,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(failedBuild.status, 1, `${failedBuild.stdout}\n${failedBuild.stderr}`);
  for (const file of firstChunks) assert.ok(readdirSync(join(pkg, 'dist')).includes(file));
  write(pkg, 'src/shared.ts', 'export const shared = { value: 2 };');
  write(pkg, 'src/lazy.ts', 'export const lazy = 2;');
  build(pkg);
  const secondChunks = readdirSync(join(pkg, 'dist')).filter((file) =>
    /-[A-Z0-9]{8}\.mjs$/.test(file),
  );
  assert.ok(secondChunks.length > 0);
  assert.ok(
    firstChunks.every((file) => !secondChunks.includes(file)),
    'obsolete hashed chunks must disappear',
  );
  for (const chunk of firstChunks) {
    assert.ok(
      !readdirSync(join(pkg, 'dist')).includes(`${chunk}.map`),
      'obsolete maps must disappear',
    );
  }
  for (const file of preserved)
    assert.equal(readFileSync(join(pkg, 'dist', file), 'utf8'), `preserve:${file}`);
  assert.equal(readFileSync(join(root, 'sibling/chunk-OUTSIDE.mjs'), 'utf8'), 'sibling');
  assert.equal(readFileSync(join(root, 'outside/chunk-LINKED.mjs'), 'utf8'), 'outside');
  const entry = pathToFileURL(join(pkg, 'dist/first.mjs')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { shared } from ${JSON.stringify(entry)}; if (shared.value !== 2) process.exit(1);`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(join(pkg, 'dist/standalone.mjs'), 'utf8').includes('standalone'));
});

test('chunk cleanup rejects escaping output roots before deleting files', async (t) => {
  const { baseTsupConfig } = await import(baseConfig);
  const plugin = baseTsupConfig.plugins[0];
  const root = mkdtempSync(join(fixtureRoot, 'tsup-output-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'chunk-12345678.mjs', 'outside');
  for (const outDir of [root, '.', '..']) {
    await assert.rejects(
      plugin.buildEnd.call(
        { format: 'esm', splitting: true, options: { outDir } },
        { writtenFiles: [] },
      ),
      /requires an output directory inside/,
    );
  }
  assert.equal(readFileSync(join(root, 'chunk-12345678.mjs'), 'utf8'), 'outside');
});

test('chunk cleanup refuses a linked output root and its parent segments', async (t) => {
  const { baseTsupConfig } = await import(baseConfig);
  const root = mkdtempSync(join(fixtureRoot, 'tsup-output-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'outside/nested/chunk-12345678.mjs', 'outside');
  symlinkSync(join(root, 'outside'), join(root, 'linked'), 'junction');
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    for (const outDir of ['linked', 'linked/nested']) {
      await assert.rejects(
        baseTsupConfig.plugins[0].buildEnd.call(
          { format: 'esm', splitting: true, options: { outDir } },
          { writtenFiles: [] },
        ),
        /refuses linked output directory/,
      );
    }
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(readFileSync(join(root, 'outside/nested/chunk-12345678.mjs'), 'utf8'), 'outside');
});

test('Water JS production preserves complete tsc declarations and incremental state', (t) => {
  mkdirSync(fixtureRoot, { recursive: true });
  const root = mkdtempSync(join(fixtureRoot, 'water-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readFileSync(join(repoRoot, 'packages/water/tsup.config.ts'), 'utf8')
    .replace("import { defineConfig } from 'tsup';", 'const defineConfig = (config) => config;')
    .replace("'../../config/tsup.base'", JSON.stringify(baseConfig));
  write(root, 'package.json', '{"type":"module"}');
  write(root, 'tsup.config.ts', config);
  write(root, 'src/index.ts', 'export const water = 1;');
  write(root, 'src/internal.ts', 'export const internal = 2;');
  const declarations = ['advanced-simulation.d.ts', 'advanced-simulation.d.ts.map', '.tsbuildinfo'];
  for (const name of declarations) write(root, `dist/${name}`, `preserved:${name}`);
  build(root);
  for (const name of declarations)
    assert.equal(readFileSync(join(root, 'dist', name), 'utf8'), `preserved:${name}`);
});
