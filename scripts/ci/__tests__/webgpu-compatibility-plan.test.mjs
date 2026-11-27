import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { compatibilityLaunch, compatibilityPhases } from '../webgpu-compatibility-plan.mjs';

test('heavier workloads stay in two of the existing four carriers', () => {
  assert.deepEqual(compatibilityPhases('stable'), ['owners', 'policy', 'compatibility', 'scene']);
  assert.deepEqual(compatibilityPhases('webkit'), ['owners', 'scene']);
  for (const carrier of ['reference', 'legacy'])
    assert.deepEqual(compatibilityPhases(carrier), ['owners']);
  assert.throws(() => compatibilityPhases('latest'), /Unknown/);
});

test('standalone carriers build the WebGPU RHI dependency closure before running owners', () => {
  const workflow = new URL('../../../.github/workflows/webgpu-compatibility.yml', import.meta.url);
  const { steps } = parse(readFileSync(workflow, 'utf8')).jobs.compatibility;
  const buildIndex = steps.findIndex(
    (step) => step.name === 'Build WebGPU RHI and its workspace dependencies',
  );
  const testIndex = steps.findIndex((step) =>
    step.name?.startsWith('Run actual GPU compatibility'),
  );
  assert.ok(buildIndex >= 0 && buildIndex < testIndex);
  assert.equal(steps[buildIndex].run, "pnpm --filter '@forgeax/engine-rhi-webgpu...' build");
  assert.equal(steps[buildIndex].if, "steps.ci-repair.outputs.reused != 'true'");
});

test('policy execution removes diagnostic overrides and preserves the sandbox', () => {
  const defaults = {
    channel: 'chrome-beta',
    chromiumSandbox: true,
    args: ['--ignore-gpu-blocklist', '--disable-dawn-features=tiered_adapter_limits'],
  };
  const env = { FORGEAX_BROWSER_EXECUTABLE: '/ci/pinned-chrome' };
  for (const phase of ['policy', 'compatibility']) {
    const launch = compatibilityLaunch(defaults, phase, env);
    assert.equal(launch.executablePath, env.FORGEAX_BROWSER_EXECUTABLE);
    assert.equal(launch.chromiumSandbox, true);
    assert.equal('channel' in launch, false);
    assert.equal(
      launch.args.some((arg) => /ignore-gpu|disable-.*(?:dawn|driver|watchdog)/.test(arg)),
      false,
    );
  }
  assert.deepEqual(compatibilityLaunch(defaults, 'owners', env).args, defaults.args);
  assert.throws(() => compatibilityLaunch(defaults, 'typo', env), /Unknown/);
});

test('software scene keeps the shared watchdog policy without overriding device limits or drivers', () => {
  const defaults = JSON.parse(readFileSync(new URL('../browser-launch.json', import.meta.url)));
  const env = { FORGEAX_BROWSER_EXECUTABLE: '/ci/pinned-chrome' };
  const launch = compatibilityLaunch(defaults, 'scene', env);
  assert.equal(launch.executablePath, env.FORGEAX_BROWSER_EXECUTABLE);
  assert.equal(launch.chromiumSandbox, true);
  assert.equal('channel' in launch, false);
  assert.deepEqual(
    launch.args.filter((arg) => /ignore-gpu|disable-.*(?:dawn|driver|watchdog)/.test(arg)),
    ['--disable-gpu-watchdog'],
  );
  assert.ok(defaults.args.includes('--disable-gpu-watchdog'));
  assert.ok(launch.args.includes('--use-angle=swiftshader'));
  assert.ok(launch.args.includes('--use-vulkan=swiftshader'));
});

test('the local compatibility scene honors explicit native graphics admission', () => {
  const defaults = JSON.parse(readFileSync(new URL('../browser-launch.json', import.meta.url)));
  const env = { CI: '1', FORGEAX_BROWSER_GPU: 'native' };
  const launch = compatibilityLaunch(defaults, 'scene', env, 'darwin');
  assert.equal(launch.chromiumSandbox, true);
  assert.ok(launch.args.includes('--enable-unsafe-webgpu'));
  assert.ok(launch.args.includes('--disable-gpu-watchdog'));
  assert.ok(!launch.args.some((arg) => /SwiftShader|Vulkan/i.test(arg)));
  assert.ok(
    compatibilityLaunch(defaults, 'policy', env, 'darwin').args.includes('--use-angle=swiftshader'),
  );
});
