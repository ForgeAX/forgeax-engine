import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const action = readFileSync('.github/actions/prepare-ui-blitz/action.yml', 'utf8');

for (const [owner, command] of [
  ['build-sdk', 'pnpm sdk:build'],
  ['reproducibility', 'pnpm sdk:build'],
  ['collision', 'pnpm build:engine'],
]) {
  test(`SDK Candidate ${owner} prepares the current UI payload before source production`, () => {
    const workflow = readFileSync('.github/workflows/sdk-release-candidate.yml', 'utf8');
    const job = workflow.split(`\n  ${owner}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
    assert.ok(job, `missing ${owner} producer`);
    const preparation = job.indexOf('      - name: Prepare current Blitz UI\n');
    const build = job.indexOf(command);
    assert.ok(preparation >= 0 && build > preparation, 'prepare UI before building release bytes');
    assert.ok(preparation > job.indexOf('run: pnpm install --frozen-lockfile --ignore-scripts'));
    const step = job.slice(preparation).split('\n      - name: ')[0];
    assert.match(step, /uses: \.\/\.github\/actions\/prepare-ui-blitz/);
    assert.match(step, /if: hashFiles\('packages\/ui-blitz\/Cargo.toml'\) != ''/);
    assert.match(step, /cache-scope: sdk-candidate-\$\{\{ runner.os \}\}-\$\{\{ runner.arch \}\}/);
  });
}

test('Native GI prepares the current UI payload before its full Engine package build', () => {
  const workflow = readFileSync('.github/workflows/native-ray-query.yml', 'utf8');
  const build = workflow.indexOf('      - name: Build engine packages\n');
  const prior = workflow.slice(0, build);
  const preparation = prior.lastIndexOf('      - name: Prepare current Blitz UI\n');
  assert.ok(build >= 0);
  assert.ok(preparation >= 0, 'native GI must prepare every native package build input');
  assert.ok(preparation > prior.lastIndexOf('      - name: Install workspace dependencies\n'));
  const step = workflow.slice(preparation).split('\n      - name: ')[0];
  assert.match(step, /uses: \.\/\.github\/actions\/prepare-ui-blitz/);
  assert.doesNotMatch(step, /\n\s+if:/);
  assert.match(step, /cache-scope: self-hosted-ubuntu-linux-x64/);
});

function shellStep(name) {
  const step = action.split(`    - name: ${name}\n`)[1]?.split('\n    - name: ')[0];
  assert.ok(step, name);
  const source = step.split('      run: ')[1];
  assert.ok(source);
  return source.startsWith('|\n')
    ? source
        .slice(2)
        .split('\n')
        .map((line) => line.slice(8))
        .join('\n')
    : source.split('\n')[0];
}

for (const state of ['absent', 'stale-source', 'corrupt-bytes', 'current']) {
  test(`UI preparation admits only current source and complete bytes: ${state}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-ui-readiness-'));
    const pkg = join(root, 'packages/ui-blitz');
    try {
      for (const path of [
        'packages/ui-blitz/scripts',
        'packages/ui-blitz/rust',
        'packages/ui-blitz/vendor/vello_gpu',
        'third_party/blitz/packages/blitz-dom',
        'third_party/blitz/vendor/stylo',
        'scripts/lib',
      ])
        mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, '.forgeax-public-distribution'), '');
      for (const name of [
        'ensure-wasm.mjs',
        'verify-current.mjs',
        'provenance.mjs',
        'content-key.mjs',
      ])
        cpSync(resolve('packages/ui-blitz/scripts', name), join(pkg, 'scripts', name));
      cpSync(
        resolve('scripts/lib/ensure-wasm-lib.mjs'),
        join(root, 'scripts/lib/ensure-wasm-lib.mjs'),
      );
      cpSync(
        resolve('scripts/lib/rust-build-paths.mjs'),
        join(root, 'scripts/lib/rust-build-paths.mjs'),
      );
      for (const path of [
        'packages/ui-blitz/Cargo.toml',
        'packages/ui-blitz/Cargo.lock',
        'packages/ui-blitz/rust/lib.rs',
        'packages/ui-blitz/vendor/vello_gpu/lib.rs',
        'third_party/blitz/Cargo.toml',
        'third_party/blitz/packages/blitz-dom/lib.rs',
        'third_party/blitz/vendor/stylo/lib.rs',
      ])
        writeFileSync(join(root, path), path);
      const output = join(root, 'output');
      const env = { ...process.env, FORGEAX_SKIP_UI_BLITZ_FETCH: '1', GITHUB_OUTPUT: output };
      const run = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
      const seed = () => {
        const result = run(process.execPath, [
          '--input-type=module',
          '-e',
          `
          import {mkdir,writeFile} from 'node:fs/promises';
          import {resolveAsset} from './packages/ui-blitz/scripts/content-key.mjs';
          import {OUTPUTS,outputFacts} from './packages/ui-blitz/scripts/provenance.mjs';
          const pkg='packages/ui-blitz/pkg';
          await mkdir(pkg,{recursive:true});
          for (const name of OUTPUTS) await writeFile(pkg+'/'+name,name);
          const source=await resolveAsset();
          await writeFile(pkg+'/provenance.json',JSON.stringify({schema:'forgeax-ui-blitz/2',
            sourceDigest:source.sha256,inputs:source.inputs,outputs:await outputFacts(pkg)}));
        `,
        ]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
      };
      if (state !== 'absent') seed();
      if (state === 'stale-source')
        writeFileSync(join(root, 'third_party/blitz/vendor/stylo/lib.rs'), 'changed');
      if (state === 'corrupt-bytes') writeFileSync(join(pkg, 'pkg/ui_blitz_bg.wasm'), 'damaged');
      const hydrate = run('bash', ['-e', '-c', shellStep('Hydrate and verify UI bundle')]);
      assert.equal(hydrate.status, 0, hydrate.stdout + hydrate.stderr);
      assert.match(readFileSync(output, 'utf8'), new RegExp(`needs_build=${state !== 'current'}`));
      const verify = () => run('bash', ['-e', '-c', shellStep('Verify prepared UI bundle')]);
      const final = verify();
      assert.equal(final.status === 0, state === 'current', final.stdout + final.stderr);
      if (state !== 'current') {
        seed();
        const repaired = verify();
        assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
