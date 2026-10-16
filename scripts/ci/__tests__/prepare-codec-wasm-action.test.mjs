import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const files = [
  'basis_transcoder.mjs',
  'basis_transcoder.wasm',
  'encode/basis_encoder.mjs',
  'encode/basis_encoder.wasm',
];
const actionPath = '.github/actions/prepare-codec-wasm/action.yml';

function shellStep(name) {
  const action = readFileSync(actionPath, 'utf8');
  const step = action.split(`    - name: ${name}\n`)[1]?.split('\n    - name: ')[0];
  assert.ok(step, name);
  return step
    .split('      run: |\n')[1]
    .split('\n')
    .filter((line) => !line.trim() || line.startsWith('        '))
    .map((line) => line.slice(8))
    .join('\n');
}

function fixture(t, omitted) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-codec-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    'packages/codec/scripts/ensure-wasm.mjs',
    'scripts/lib/ensure-wasm-lib.mjs',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(resolve(file), join(root, file));
  }
  for (const file of files) {
    if (omitted === 'all' || omitted === file) continue;
    const path = join(root, 'packages/codec/pkg', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture bytes');
  }
  const output = join(root, 'output');
  const run = (command, args) =>
    spawnSync(command, args, {
      cwd: root,
      env: { ...process.env, FORGEAX_SKIP_CODEC_WASM_FETCH: '1', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
  return { root, output, run };
}

for (const omitted of ['all', ...files, undefined]) {
  test(`Codec strict preparation rejects ${omitted ?? 'no'} missing payload files`, (t) => {
    const f = fixture(t, omitted);
    const checked = f.run(process.execPath, ['packages/codec/scripts/ensure-wasm.mjs', '--check']);
    assert.equal(checked.status, omitted ? 1 : 0, checked.stdout + checked.stderr);
  });
}

test('Codec strict preparation rejects an empty transcoder paired with existing WASM', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'packages/codec/pkg/basis_transcoder.mjs'), '');
  const checked = f.run(process.execPath, ['packages/codec/scripts/ensure-wasm.mjs', '--check']);
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
});

test('locked compiler cache stays outside SDK source admission while source edits remain visible', (t) => {
  const f = fixture(t);
  cpSync(resolve('.gitignore'), join(f.root, '.gitignore'));
  mkdirSync(join(f.root, 'emsdk-cache/install'), { recursive: true });
  writeFileSync(join(f.root, 'emsdk-cache/install/compiler'), 'generated toolchain');
  writeFileSync(join(f.root, 'source.ts'), 'export {};\n');
  const initialized = f.run('git', ['init', '-q']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const status = f.run('git', ['status', '--porcelain', '--untracked-files=all']);
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /emsdk-cache/);
  assert.match(status.stdout, /\?\? source\.ts/);
});

for (const state of ['cache-miss', 'current-cache', 'stale-retained']) {
  test(`Codec preparation admits ${state} through the real payload owner`, (t) => {
    const f = fixture(t, state === 'cache-miss' ? 'all' : undefined);
    if (state === 'stale-retained') {
      const cleared = f.run('bash', ['-c', shellStep('Clear unverified retained Codec payloads')]);
      assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
    }
    const hydrated = f.run('bash', ['-c', shellStep('Hydrate and check Codec payloads')]);
    assert.equal(hydrated.status, 0, hydrated.stdout + hydrated.stderr);
    assert.match(
      readFileSync(f.output, 'utf8'),
      new RegExp(`needs_build=${state === 'current-cache' ? 'false' : 'true'}`),
    );
    const verified = f.run('bash', ['-c', shellStep('Verify prepared Codec payloads')]);
    assert.equal(verified.status, state === 'current-cache' ? 0 : 1);
  });
}

test('Codec preparation uses the existing locked source recovery after every acceleration miss', () => {
  const action = readFileSync(actionPath, 'utf8');
  const source = shellStep('Build missing Codec payloads');
  assert.match(source, /node packages\/codec\/scripts\/fetch-basis\.mjs/);
  assert.match(source, /node packages\/codec\/scripts\/build-wasm\.mjs/);
  const compiler = shellStep('Prepare locked Emscripten');
  assert.match(compiler, /setup-emscripten-no-xz\.py[\s\S]*?--validate-cache/);
  assert.match(compiler, /else[\s\S]*prepare-emscripten-no-xz-archive\.py/);
  assert.equal(
    (compiler.match(/--github-env "\$GITHUB_ENV" --github-path "\$GITHUB_PATH"/g) ?? []).length,
    2,
  );
  assert.equal(
    (action.match(/if: steps\.hydrate\.outputs\.needs_build == 'true'/g) ?? []).length,
    3,
  );
  assert.doesNotMatch(action, /continue-on-error|restore-keys|cache-hit/);
  assert.ok(action.indexOf('Clear unverified retained') < action.indexOf('uses: actions/cache@v5'));
  assert.match(
    action,
    /key: \$\{\{ inputs\.cache-scope \}\}-basis-wasm-pkg-v1-\$\{\{ hashFiles\('packages\/codec\/scripts\/fetch-basis\.mjs', 'packages\/codec\/scripts\/build-wasm\.mjs'\) \}\}/,
  );
});

test('shared producer selects its build closure without Runtime or native physics packages', () => {
  const repoRoot = resolve('.');
  const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('\n  shared-app-inputs:\n')[1]?.split(/\n {2}\S/)[0];
  const step = job
    ?.split('name: Build shared producer plugin dependencies')[1]
    ?.split('\n      - ')[0];
  const command = step?.match(/run: >-\n((?: {10}.+(?:\n|$))+)/)?.[1].trim();
  assert.ok(command, 'the shared producer declares its package build command');
  const [executable, ...args] = command.split(/\s+/).map((token) => token.replace(/^'|'$/g, ''));
  assert.equal(executable, 'pnpm');
  assert.equal(args.pop(), 'build');
  const selected = spawnSync(executable, [...args, 'list', '--depth', '-1', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    shell: process.platform === 'win32',
  });
  assert.equal(selected.status, 0, selected.stderr);
  const names = JSON.parse(selected.stdout).map((entry) => entry.name);
  assert.ok(names.includes('@forgeax/engine-codec'), 'Codec remains in the real build closure');
  assert.deepEqual(
    names.filter((name) => /^@forgeax\/engine-(runtime|physics-rapier[23]d)$/.test(name)),
    [],
    'the empty catalog/shader entry leaves Runtime and both native physics builds to core',
  );
});

test('every direct shared producer and native Engine package build prepares Codec first', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const name of ['shared-app-inputs']) {
    const job = ci.split(`\n  ${name}:\n`)[1]?.split(/\n {2}\S/)[0];
    assert.ok(job, name);
    const prepare = job.indexOf('uses: ./.github/actions/prepare-codec-wasm');
    const build = job.indexOf('name: Build shared producer plugin dependencies');
    assert.ok(prepare >= 0 && prepare < build, `${name}: Codec inputs precede its build`);
  }
  const native = readFileSync('.github/workflows/native-ray-query.yml', 'utf8');
  const jobs = [...native.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gm)];
  const builders = jobs.filter(([, , body]) => body.includes('name: Build engine packages'));
  assert.ok(builders.length > 0);
  for (const [, name, body] of builders) {
    const prepare = body.indexOf('uses: ./.github/actions/prepare-codec-wasm');
    assert.ok(prepare >= 0 && prepare < body.indexOf('name: Build engine packages'), name);
  }
  assert.match(ci, /scripts\/ci\/__tests__\/prepare-codec-wasm-action\.test\.mjs/);
});
