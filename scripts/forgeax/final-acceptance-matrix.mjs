#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = resolve(root, 'scripts/forgeax/final-acceptance.schema.json');
const requiredProducts = ['empty', 'game-3d', 'game-capability-lab', 'brotato-3d'];
const requiredDistributions = ['zip', 'npm-carrier', 'offline-store', 'source-sdk'];

function errors(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`);
}

export function validateFinalAcceptance(matrix, schema) {
  const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validator(matrix)) return { ok: false, errors: errors(validator) };
  const findings = [];
  const cellKeys = new Set();
  for (const cell of matrix.cells) {
    const key = `${cell.product}\u0000${cell.distribution}`;
    if (cellKeys.has(key)) findings.push(`duplicate product/distribution cell ${key}`);
    cellKeys.add(key);
    if (cell.status !== 'pass') findings.push(`required cell ${cell.id} is ${cell.status}`);
    if (cell.lane !== 'semantic' && cell.backend.kind !== cell.lane) {
      findings.push(`backend/lane mismatch for ${cell.id}`);
    }
    if (cell.artifact.sha256.length !== 64) findings.push(`artifact digest missing for ${cell.id}`);
  }
  for (const product of requiredProducts) {
    for (const distribution of requiredDistributions) {
      if (!cellKeys.has(`${product}\u0000${distribution}`))
        findings.push(`missing matrix cell ${product}/${distribution}`);
    }
  }
  const visualProducts = new Set();
  for (const record of matrix.visualRecords) {
    if (visualProducts.has(record.product))
      findings.push(`duplicate visual record ${record.product}`);
    visualProducts.add(record.product);
    if (record.verdict !== 'pass')
      findings.push(`visual record ${record.product} is ${record.verdict}`);
    if (record.confidence === 'low')
      findings.push(`visual confidence is low for ${record.product}`);
    if (record.artifact.sha256.length !== 64)
      findings.push(`visual artifact digest missing for ${record.product}`);
  }
  for (const product of requiredProducts)
    if (!visualProducts.has(product)) findings.push(`missing visual record ${product}`);
  return { ok: findings.length === 0, errors: findings };
}

async function main() {
  const index = process.argv.indexOf('--matrix');
  if (index < 0 || process.argv[index + 1] === undefined)
    throw new Error('Usage: node scripts/forgeax/final-acceptance-matrix.mjs --matrix <path>');
  const matrix = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8'));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const result = validateFinalAcceptance(matrix, schema);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
