import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPackageSelection } from '../build-package-selection.mjs';

test('a focused build retains shared transitive owners and excludes unrelated producers', () => {
  const packages = ['types', 'rhi', 'render', 'host', 'compiler', 'desktop'].map((name) => ({
    manifest: { name },
  }));
  const dependencies = new Map([
    ['rhi', ['types']],
    ['render', ['rhi']],
    ['host', ['render']],
    ['compiler', ['types']],
  ]);
  assert.deepEqual(
    buildPackageSelection(packages, dependencies, ['--target=host', '--target=compiler']).map(
      (pkg) => pkg.manifest.name,
    ),
    ['types', 'rhi', 'render', 'host', 'compiler'],
  );
  assert.equal(buildPackageSelection(packages, dependencies, []), packages);
  assert.throws(
    () => buildPackageSelection(packages, dependencies, ['--target=missing']),
    /Unknown build target/,
  );
  assert.throws(
    () => buildPackageSelection(packages, dependencies, ['--skip=types']),
    /Unknown build option/,
  );
});
