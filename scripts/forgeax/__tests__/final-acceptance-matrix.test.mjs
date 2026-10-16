import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { validateFinalAcceptance } from '../final-acceptance-matrix.mjs';

const root = resolve(import.meta.dirname, '../../..');
const schema = JSON.parse(
  await readFile(resolve(root, 'scripts/forgeax/final-acceptance.schema.json'), 'utf8'),
);
const products = ['empty', 'game-3d', 'game-capability-lab', 'brotato-3d'];
const distributions = ['zip', 'npm-carrier', 'offline-store', 'source-sdk'];

function matrix() {
  return {
    schemaVersion: '1.0.0',
    matrixKind: 'final-acceptance',
    source: { engineCommit: 'a'.repeat(40), buildId: 'build-1' },
    products,
    distributions,
    cells: products.flatMap((product) =>
      distributions.map((distribution) => ({
        id: `${product}-${distribution}`,
        product,
        distribution,
        lane: 'semantic',
        command: 'forgeax project test',
        artifact: { path: `artifacts/${product}/${distribution}.json`, sha256: 'b'.repeat(64) },
        backend: { kind: 'dawn', identity: 'node-dawn' },
        status: 'pass',
        log: 'completed',
      })),
    ),
    visualRecords: products.map((product) => ({
      product,
      distribution: 'zip',
      artifact: { path: `screenshots/${product}.png`, sha256: 'c'.repeat(64) },
      backend: { kind: 'chromium', identity: 'chrome-beta' },
      expected: 'visible product result',
      observed: 'visible product result',
      verdict: 'pass',
      confidence: 'high',
    })),
  };
}

test('acceptance matrix requires every product/distribution cell and visual product', () => {
  const result = validateFinalAcceptance(matrix(), schema);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('blocked, missing, or low-confidence evidence fails closed', () => {
  const value = matrix();
  value.cells[0].status = 'blocked';
  value.visualRecords[0].confidence = 'low';
  const result = validateFinalAcceptance(value, schema);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('is blocked')));
  assert(result.errors.some((error) => error.includes('confidence is low')));
});

test('duplicate cells and invalid visual verdicts are rejected', () => {
  const value = matrix();
  value.cells[1].product = value.cells[0].product;
  value.cells[1].distribution = value.cells[0].distribution;
  value.visualRecords[0].verdict = 'insufficient-evidence';
  const result = validateFinalAcceptance(value, schema);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.startsWith('duplicate product/distribution')));
  assert(result.errors.some((error) => error.includes('insufficient-evidence')));
});
