import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

for (const [owner, label, files] of [
  ['fbx', 'FBX', ['fbx-wasm.mjs', 'fbx-wasm.wasm']],
  [
    'codec',
    'Codec',
    [
      'basis_transcoder.mjs',
      'basis_transcoder.wasm',
      'encode/basis_encoder.mjs',
      'encode/basis_encoder.wasm',
    ],
  ],
]) {
  const steps = parse(readFileSync(`.github/actions/prepare-${owner}-wasm/action.yml`, 'utf8')).runs
    .steps;
  const current = steps.findIndex((step) => step.id === 'current');
  const cache = steps.findIndex((step) => step.name === `Cache current ${label} payloads`);
  const hydrate = steps.findIndex((step) => step.id === 'hydrate');
  test(`${label} warm payloads bypass optional cache and retain final native execution`, () => {
    assert.ok(current >= 0 && current < cache && cache < hydrate);
    assert.equal(steps[cache].if, "steps.current.outputs.ready != 'true'");
    assert.ok(steps[current].env.GITHUB_TOKEN.includes('github.token'));
    assert.doesNotMatch(steps[hydrate].run, /ensure-wasm\.mjs(?! --check)/);
    assert.match(
      steps.at(-1).run,
      owner === 'fbx' ? /test-wasm\.mjs --verify/ : /verify-transcoder\.mjs --all/,
    );
  });
  for (const complete of [true, false]) {
    test(`${label} release readiness ${complete} drives cache/source admission with actual owner checks`, (t) => {
      const root = mkdtempSync(join(tmpdir(), 'forgeax-native-admission-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      for (const file of [
        `packages/${owner}/scripts/ensure-wasm.mjs`,
        'scripts/lib/ensure-wasm-lib.mjs',
      ]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        cpSync(resolve(file), join(root, file));
      }
      for (const file of complete ? files : files.slice(1)) {
        const path = join(root, `packages/${owner}/pkg`, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'completeness fixture');
      }
      const output = join(root, 'output');
      for (const index of [current, hydrate]) {
        const result = spawnSync('bash', ['-e', '-c', steps[index].run], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            FORGEAX_SKIP_FBX_WASM_FETCH: '1',
            FORGEAX_SKIP_CODEC_WASM_FETCH: '1',
          },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
      const result = readFileSync(output, 'utf8');
      assert.match(result, new RegExp(`ready=${complete}`));
      assert.match(result, new RegExp(`needs_build=${!complete}`));
    });
  }
}

test('main and Focus share the maintained FBX/Codec preparation owners', () => {
  for (const [file, job] of [
    ['ci.yml', 'core-build'],
    ['ci-focus.yml', 'diagnostic'],
  ]) {
    const steps = parse(readFileSync(`.github/workflows/${file}`, 'utf8')).jobs[job].steps;
    for (const owner of ['fbx', 'codec']) {
      const calls = steps.filter((step) => step.uses === `./.github/actions/prepare-${owner}-wasm`);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].with['cache-scope']);
    }
    assert.ok(
      !steps.some((step) =>
        ['cache-fbx-pkg', 'cache-codec-pkg', 'emcc-needed', 'native-build'].includes(step.id),
      ),
    );
  }
});
