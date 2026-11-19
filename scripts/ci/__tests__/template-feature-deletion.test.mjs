import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFeatureDeletion } from '../check-template-feature-deletion.mjs';

test('every game-3d feature folder can be deleted on its own without type errors', () => {
  const results = checkFeatureDeletion();
  assert.ok(results.length >= 5);
  for (const result of results)
    assert.ok(result.ok, `without assets/${result.folder}/\n${result.output}`);
});
