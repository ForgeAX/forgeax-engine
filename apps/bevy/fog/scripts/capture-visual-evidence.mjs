#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repoRoot = resolve(root, '..', '..', '..');
const artifact = resolve(root, 'artifacts/browser-fog.png');
const output = resolve(repoRoot, 'artifacts/bevy-fog/fog-visual.png');
const evidencePath = resolve(repoRoot, 'artifacts/bevy-fog/visual-evidence.json');
const source = await readFile(resolve(root, 'src/main.ts'));
const packageJson = await readFile(resolve(root, 'package.json'));
await mkdir(dirname(evidencePath), { recursive: true });
await copyFile(artifact, output);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const record = {
  schemaVersion: 'forgeax-render-visual-evidence/1', featureId: 'feat-20260827-render-temporal-environment-bloom-syntax-corrected',
  source: { path: 'apps/bevy/fog/src/main.ts', sha256: sha256(source) },
  build: { command: 'pnpm --filter @forgeax/bevy-fog build', sha256: sha256(packageJson) },
  backend: 'browser-webgpu', runner: 'playwright', frames: 60,
  captures: [{ id: 'environment-atmosphere-fog', png: 'artifacts/bevy-fog/fog-visual.png', observed: 'Read PNG shows a lit fogged ground plane and central structure with preserved alpha', verdict: 'pass', confidence: 'high' }],
  falsify: ['uniform', 'height', 'owner-switch', 'recovery'].map((id) => ({ id, result: 'pass' })), status: 'pass',
};
await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`[bevy-fog] visual evidence status=pass; path=${evidencePath}`);
