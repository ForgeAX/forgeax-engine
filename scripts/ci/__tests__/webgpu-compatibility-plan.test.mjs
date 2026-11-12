import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compatibilityLaunch, compatibilityPhases } from '../webgpu-compatibility-plan.mjs';

test('heavier workloads stay in two of the existing four carriers', () => {
  assert.deepEqual(compatibilityPhases('stable'), ['owners', 'policy', 'compatibility', 'scene']);
  assert.deepEqual(compatibilityPhases('webkit'), ['owners', 'scene']);
  for (const carrier of ['reference', 'legacy'])
    assert.deepEqual(compatibilityPhases(carrier), ['owners']);
  assert.throws(() => compatibilityPhases('latest'), /Unknown/);
});

test('policy execution removes diagnostic overrides and preserves the sandbox', () => {
  const defaults = {
    channel: 'chrome-beta',
    chromiumSandbox: true,
    args: ['--ignore-gpu-blocklist', '--disable-dawn-features=tiered_adapter_limits'],
  };
  const env = { FORGEAX_BROWSER_EXECUTABLE: '/ci/pinned-chrome' };
  for (const phase of ['policy', 'compatibility', 'scene']) {
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
