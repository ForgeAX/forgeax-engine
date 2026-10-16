#!/usr/bin/env node
// Development-only falsifier contract. It refuses to claim a visual failure
// until the app owner exposes a real albedo-blank injection point.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname, '..', '..');
const appEntry = resolve(repoRoot, 'apps', 'hello', 'cube', 'src', 'main.ts');
const artifactDir = resolve(
  process.env.FORGEAX_M7_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m7-backend-recovery', 'falsify-device-loss'),
);
const reportPath = resolve(artifactDir, 'falsify-summary.json');
mkdirSync(artifactDir, { recursive: true });
const source = existsSync(appEntry) ? readFileSync(appEntry, 'utf8') : '';
const injectionMarker = 'FORGEAX_M7_FALSIFY_ALBEDO';
const evidence = {
  status: 'insufficient-evidence',
  falsifier: 'albedo-blank',
  expectation: 'post-recovery-scene-parity',
  observed: {
    appEntryExists: existsSync(appEntry),
    albedoInjectionOwnerHook: source.includes(injectionMarker),
    verdict: 'not-run',
    confidence: 0,
  },
  missingCapability:
    'The app owner exposes no real albedo-blank injection hook; altering a PNG or tape would not falsify scene parity',
  ci: 'excluded-by-design',
};

writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.error(`[m7-falsify-device-loss] INSUFFICIENT_EVIDENCE ${JSON.stringify(evidence)}`);
process.exitCode = 1;
