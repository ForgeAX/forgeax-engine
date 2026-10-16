import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { browserFixtureInputs } from '../browser-fixture-inputs.mjs';

const packages = [
  'apps/bevy/shader-material/src/material.pack.json',
  'apps/hello/physical-material/src/physical.pack.json',
  'apps/game-capability-lab/assets/target.pack.json',
  'packages/runtime/src/__tests__/fixtures/material.pack.json',
];

function fixture(run) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'forgeax-browser-materials-'));
  try {
    for (const owner of [
      'apps/bevy/shader-material',
      'apps/hello/physical-material',
      'apps/game-capability-lab',
      'apps/preview',
      'packages/runtime',
      'packages/app',
    ]) {
      mkdirSync(join(root, owner), { recursive: true });
      writeFileSync(join(root, owner, 'package.json'), '{}');
      writeFileSync(join(root, owner, 'proof.browser.test.ts'), '');
    }
    for (const file of packages) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '{}');
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('procedural tests do not cook unrelated demo materials', () => {
  fixture((root) => {
    assert.deepEqual(
      browserFixtureInputs(root, packages, ['packages/app/proof.browser.test.ts']),
      [],
    );
    assert.deepEqual(
      browserFixtureInputs(root, packages, ['packages/runtime/proof.browser.test.ts']),
      packages.slice(3),
    );
    assert.deepEqual(
      browserFixtureInputs(
        root,
        ['apps/game-capability-lab/assets', 'apps/hello/physical-material/src'],
        ['packages/app/proof.browser.test.ts'],
      ),
      [],
    );
  });
});

test('mixed groups retain each complete owner and explicitly shared source roots', () => {
  fixture((root) => {
    assert.deepEqual(
      browserFixtureInputs(root, packages, [
        'apps/hello/physical-material/proof.browser.test.ts',
        'apps/preview/proof.browser.test.ts',
        'apps/game-capability-lab/assets',
      ]),
      packages.slice(1, 3),
    );
  });
});

test('broad or unknown selection never silently drops material inputs', () => {
  fixture((root) => {
    assert.deepEqual(browserFixtureInputs(root, packages), packages);
    assert.deepEqual(browserFixtureInputs(root, packages, ['**/*.browser.test.ts']), packages);
    assert.deepEqual(browserFixtureInputs(root, packages, ['missing/browser.test.ts']), packages);
  });
});
