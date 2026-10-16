import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('CI prepares actual native Rapier declarations before a cold package typecheck', () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const root = mkdtempSync(join(tmpdir(), 'forgeax-rapier-types-'));
  try {
    mkdirSync(join(root, 'scripts/forgeax'), { recursive: true });
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    cpSync(
      join(repository, 'scripts/lib/rust-build-paths.mjs'),
      join(root, 'scripts/lib/rust-build-paths.mjs'),
    );
    cpSync(join(repository, 'package.json'), join(root, 'package.json'));
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    cpSync(
      join(repository, 'scripts/forgeax/build-rapier-native.mjs'),
      join(root, 'scripts/forgeax/build-rapier-native.mjs'),
    );
    const sources = [];
    for (const dimension of ['2d', '3d']) {
      const owner = `packages/physics-rapier${dimension}`;
      mkdirSync(join(root, owner, 'src'), { recursive: true });
      cpSync(join(repository, owner, 'package.json'), join(root, owner, 'package.json'));
      symlinkSync(
        join(repository, owner, 'node_modules'),
        join(root, owner, 'node_modules'),
        'dir',
      );
      for (const name of ['native.ts', 'wasm-browser.ts'])
        cpSync(join(repository, owner, 'src', name), join(root, owner, 'src', name));
      if (dimension === '3d') {
        for (const directory of ['scripts', 'patches'])
          cpSync(join(repository, owner, directory), join(root, owner, directory), {
            recursive: true,
          });
      }
      sources.push(join(owner, 'src/native.ts'));
    }
    const run = (command, args) =>
      spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const typecheck = () =>
      run(process.execPath, [
        join(repository, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'Bundler',
        ...sources,
      ]);
    const red = typecheck();
    assert.notEqual(red.status, 0);
    assert.match(red.stdout + red.stderr, /Cannot find module '\.\.\/pkg\/rapier-native\.mjs'/);

    const workflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8');
    const name = '      - name: Prepare native Rapier type inputs\n';
    const start = workflow.indexOf(name);
    assert.ok(start >= 0, 'the cold typecheck must acquire its generated native inputs');
    assert.ok(start < workflow.indexOf('      - name: Package declaration typecheck\n'));
    const sourcePreparation = workflow.indexOf('      - name: Prepare current Rapier WASM\n');
    assert.ok(sourcePreparation >= 0 && sourcePreparation < start);
    assert.match(
      workflow.slice(sourcePreparation, start),
      /uses: \.\/\.github\/actions\/prepare-rapier-wasm/,
    );
    // CI restores both source-keyed publications before the native declarations
    // step. Exercise that real cache admission with the complete recipe closure.
    for (const dimension of ['2d', '3d'])
      cpSync(
        join(repository, `packages/physics-rapier${dimension}/pkg`),
        join(root, `packages/physics-rapier${dimension}/pkg`),
        { recursive: true },
      );
    const action = readFileSync(
      join(repository, '.github/actions/prepare-rapier-wasm/action.yml'),
      'utf8',
    );
    const verificationStep = action
      .split('    - name: Verify prepared Rapier payload\n')[1]
      ?.split('\n    - name: ')[0];
    const verification = verificationStep
      ?.split('      run: |\n')[1]
      ?.split('\n')
      .filter((line) => line.startsWith('        '))
      .map((line) => line.slice(8))
      .join('\n');
    assert.ok(verification, 'the source publication must pass the actual CI verifier');
    const admitted = run('bash', ['-e', '-c', verification]);
    assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
    const step = workflow.slice(start).split('\n      - name: ')[0];
    const command = step
      .split('        run: |\n')[1]
      .split('\n')
      .filter((line) => line.startsWith('          '))
      .map((line) => line.slice(10))
      .join('\n');
    const prepared = run('bash', ['-e', '-c', command]);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const green = typecheck();
    assert.equal(green.status, 0, green.stdout + green.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
