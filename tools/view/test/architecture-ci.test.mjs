import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

it('GPU game probes retain the Engine browser lane unrounded adapter limits', () => {
  for (const name of [
    'verify-game3d-workspace',
    'verify-page-plugin-lifecycle',
    'verify-workspace-experience',
    'verify-engine-plugin-boundary',
    'verify-runtime-content-engine',
  ]) {
    const source = readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8');
    assert.ok(
      source.includes('--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'),
      name,
    );
  }
});

it('runs independent architecture and build lanes with every consumer required', () => {
  assert.doesNotMatch(workflow, /continue-on-error:|paths(?:-ignore)?:/);
  assert.match(workflow, / {2}architecture:\n[\s\S]*?run: pnpm check:architecture/);
  const architecture = workflow.slice(
    workflow.indexOf('  architecture:'),
    workflow.indexOf('  build:'),
  );
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  browser:'));
  const browser = workflow.slice(workflow.indexOf('  browser:'), workflow.indexOf('  bootstrap:'));
  for (const lane of [architecture, build]) {
    assert.doesNotMatch(lane, /^ {4}(?:needs|if):/m);
  }
  for (const lane of [build, browser]) {
    const preparation = lane.indexOf('uses: ./.github/actions/prepare-wgpu-wasm');
    assert.ok(preparation >= 0, 'native builds must retain the Engine source-build fallback');
    assert.ok(preparation < lane.indexOf('run: pnpm build:engine'));
    assert.doesNotMatch(lane, /@forgeax\/engine-wgpu-wasm fetch-wasm/);
  }
  assert.match(build, /run: pnpm build:engine && pnpm build:tools/);
  assert.match(build, /shards\.length !== 4/);
  assert.match(build, /new Set\(shards\)\.size !== shards\.length/);
  assert.match(browser, /^ {2}browser:\n {4}needs: build/m);
  assert.match(browser, /fail-fast: false/);
  assert.match(browser, /shard: \$\{\{ fromJSON\(needs\.build\.outputs\.view_shards\) \}\}/);
  assert.match(browser, /--candidate --shard \$\{\{ matrix\.shard \}\}/);
  assert.match(
    workflow,
    / {2}bootstrap:\n {4}if: always\(\)\n {4}needs: \[architecture, build, browser\]/,
  );
  for (const name of ['architecture', 'build', 'browser']) {
    assert.ok(workflow.includes(`${name.toUpperCase()}_RESULT: \${{ needs.${name}.result }}`));
  }
});

it('the actual aggregate command rejects every failed, skipped, cancelled or absent lane', () => {
  const aggregate = workflow.slice(workflow.indexOf('  bootstrap:'));
  const command = aggregate.match(/ {8}run: (.+)/)?.[1];
  assert.ok(command);
  let shell = 'sh';
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    assert.ifError(git.error);
    assert.equal(git.status, 0, git.stderr);
    shell = resolve(git.stdout.trim(), '../../../bin/bash.exe');
  }
  const results = ['success', 'failure', 'skipped', 'cancelled', ''];
  for (const architecture of results)
    for (const build of results)
      for (const browser of results) {
        const result = spawnSync(shell, ['-c', command], {
          env: {
            ...process.env,
            ARCHITECTURE_RESULT: architecture,
            BUILD_RESULT: build,
            BROWSER_RESULT: browser,
          },
        });
        assert.ifError(result.error);
        assert.equal(
          result.status === 0,
          [architecture, build, browser].every((value) => value === 'success'),
          JSON.stringify({ architecture, build, browser }),
        );
      }
});
