import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');

test('visual evidence schema binds observations to artifact and backend identity', async () => {
  const schema = JSON.parse(
    await readFile(resolve(root, 'scripts/forgeax/visual-evidence.schema.json'), 'utf8'),
  );
  assert.equal(schema.properties.evidenceKind.const, 'visual-evidence');
  assert.deepEqual(schema.properties.records.items.required, [
    'product',
    'artifact',
    'backend',
    'expected',
    'observed',
    'verdict',
    'confidence',
  ]);
  assert.deepEqual(schema.$defs.backend.properties.kind.enum, ['chromium', 'dawn']);
});

test('insufficient evidence remains a terminal negative verdict', async () => {
  const schema = JSON.parse(
    await readFile(resolve(root, 'scripts/forgeax/visual-evidence.schema.json'), 'utf8'),
  );
  assert.deepEqual(schema.properties.records.items.properties.verdict.enum, [
    'pass',
    'fail',
    'insufficient-evidence',
  ]);
  assert.deepEqual(schema.properties.records.items.properties.confidence.enum, [
    'high',
    'medium',
    'low',
  ]);
});
