import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('Rapier declaration packaging stays within its exact inputs in a junction-mounted checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax declaration % '));
  try {
    const declarations = join(root, 'declarations'),
      staged = join(root, 'pkg');
    mkdirSync(declarations);
    mkdirSync(staged);
    mkdirSync(join(root, 'harness'));
    symlinkSync(
      join(root, 'harness'),
      join(root, '.forgeax-harness'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(
      realpathSync(resolve('node_modules/typescript')),
      join(root, 'node_modules/typescript'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFileSync(
      join(declarations, 'rapier.d.ts'),
      'export interface Probe { sinkHeight: number }\nexport declare function probe(): Probe;\n',
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'rapier-declaration-regression', type: 'module' }),
    );
    const tsconfig = join(root, 'tsconfig.json');
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: { skipLibCheck: true, module: 'esnext', moduleResolution: 'bundler' },
      }),
    );
    const owner = pathToFileURL(
      resolve('packages/physics-rapier3d/scripts/build-declarations.mjs'),
    ).href;
    const program = `import { bundleRapierDeclarations } from ${JSON.stringify(owner)}; await bundleRapierDeclarations(${JSON.stringify(declarations)},${JSON.stringify(staged)},${JSON.stringify(tsconfig)});`;
    const entry = join(root, 'bundle.mjs');
    writeFileSync(entry, program);
    // tsup starts a Worker that inherits Node arguments. Use a file entry so
    // the CI preload cannot carry eval-only --input-type into that Worker.
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(resolve('scripts/ci/patch-dawn-device-limits.mjs')).href, entry],
      { cwd: root, encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const artifact = readFileSync(join(staged, 'rapier.d.mts'), 'utf8');
    assert.match(artifact, /sinkHeight: number/);
    assert.match(artifact, /export.*Probe.*probe/s);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
