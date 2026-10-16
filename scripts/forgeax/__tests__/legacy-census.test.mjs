import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const consumerRoots = [
  'packages/project/src',
  'packages/devkit/src',
  'packages/engine/src',
  'apps/preview',
  'apps/hello/m2-content-pipeline',
  'packages/runtime/src/__tests__',
];
const consumerFiles = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'bun.lock',
  'scripts/forgeax/sdk-lib.mjs',
  'scripts/forgeax/build-sdk.mjs',
  'scripts/forgeax/verify-sdk.mjs',
  'scripts/game-default-capability-audit.mjs',
  'apps/game-capability-lab/assets/plugins/target-profile-importer.ts',
];
const retiredTokens = [
  'templates/game-default',
  'templates/game-brotato-3d',
  'templates/game-empty',
  'schemaVersion: 1',
  'executionEntry',
  'forgeax.assets',
];

const allowedContractFiles = new Set(['packages/devkit/src/project/lint.ts']);

function isHistoricalInput(file) {
  return file.includes('/__tests__/');
}

async function existingConsumerFiles() {
  const files = (await Promise.all(consumerRoots.map(sourceFiles))).flat();
  for (const file of consumerFiles) {
    try {
      await access(join(root, file));
      files.push(file);
    } catch {}
  }
  return [...new Set(files)];
}

async function sourceFiles(directory) {
  const result = [];
  try {
    await access(join(root, directory));
  } catch {
    return result;
  }
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      result.push(...(await sourceFiles(relative)));
    } else if (/\.(?:ts|tsx|mjs|json)$/.test(entry.name)) {
      result.push(relative);
    }
  }
  return result;
}

test('final runtime census contains no retired project paths or fields', async () => {
  const files = await existingConsumerFiles();
  const findings = [];
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    for (const token of retiredTokens) {
      if (text.includes(token) && !allowedContractFiles.has(file) && !isHistoricalInput(file)) {
        findings.push({ file, token });
      }
    }
  }
  assert.deepEqual(findings, [], 'runtime consumers still contain retired project vocabulary');
});
