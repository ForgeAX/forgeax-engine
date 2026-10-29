import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const action = resolve('.github/actions/setup-node-pnpm/action.yml');

test('workflows install pnpm only through the retrying setup action', () => {
  const workflows = resolve('.github/workflows');
  for (const name of readdirSync(workflows)) {
    const source = readFileSync(resolve(workflows, name), 'utf8');
    assert.doesNotMatch(source, /uses: pnpm\/setup@/, `${name} must use setup-node-pnpm`);
  }
});

test('setup action retries the pinned pnpm download a bounded number of times', () => {
  const source = readFileSync(action, 'utf8');
  assert.equal(source.match(/uses: pnpm\/setup@v3/g)?.length, 3);
  assert.equal(source.match(/continue-on-error: true/g)?.length, 2);
  assert.match(source, /- if: steps\.pnpm-2\.outcome == 'failure'\n {6}uses: pnpm\/setup@v3/);
});
