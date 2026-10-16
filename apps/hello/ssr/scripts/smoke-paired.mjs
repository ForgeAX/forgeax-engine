#!/usr/bin/env node

import { SSR_FIXTURE_REVISION } from '../src/reflection-scene.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(appDir, '../../..');
const artifactDir = resolve(rootDir, 'artifacts/ssr-fallback');
const env = { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1', SMOKE_MIN_FRAMES: '60' };

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: appDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return result;
}

const browser = run('scripts/smoke-browser.mjs');
const dawn = run('scripts/smoke-dawn.mjs', { VITE_REFLECTION_PROBE_EVIDENCE: '1' });
const errors = [];
if (browser.status !== 0) errors.push(`browser exit=${browser.status}`);
if (dawn.status !== 0) errors.push(`dawn exit=${dawn.status}`);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`missing or invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const browserManifest = readJson(resolve(artifactDir, 'browser/manifest.json'));
const dawnManifest = readJson(resolve(artifactDir, 'dawn/manifest.json'));
const browserInput = readJson(resolve(artifactDir, 'browser/ssr-dependencies-input.json'));
const dawnInput = readJson(resolve(artifactDir, 'dawn/ssr-dependencies-input.json'));
if (browserManifest?.status !== 'pass') errors.push('browser evidence is not pass');
if (dawnManifest?.status !== 'pass') errors.push('dawn evidence is not pass');
if (JSON.stringify(browserManifest?.identity) !== JSON.stringify(dawnManifest?.identity)) {
  errors.push('browser/dawn manifest identity mismatch');
}
if (JSON.stringify(browserInput?.identity) !== JSON.stringify(dawnInput?.identity)) {
  errors.push('browser/dawn dependency identity mismatch');
}
if (browserManifest?.fixture?.frames !== 60 || dawnManifest?.fixture?.frames !== 60) {
  errors.push('paired fixture frame count is not 60');
}
if (JSON.stringify(browserInput?.passRoster) !== JSON.stringify(dawnInput?.passRoster)) {
  errors.push('browser/dawn SSR pass roster mismatch');
}
if (typeof browserInput?.readbackHash !== 'string' || typeof dawnInput?.readbackHash !== 'string') {
  errors.push('paired raw readback hash missing');
}

const identity = browserManifest?.identity ?? dawnManifest?.identity ?? {
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
};
const artifact = {
  schemaVersion: 'hello-ssr-paired/1',
  featureId: 'feat-20260831-ssr-probe-environment-fallback',
  status: errors.length === 0 ? 'pass' : 'blocked',
  identity,
  fixture: { revision: SSR_FIXTURE_REVISION, frames: 60 },
  lanes: {
    browser: {
      manifest: 'artifacts/ssr-fallback/browser/manifest.json',
      input: 'artifacts/ssr-fallback/browser/ssr-dependencies-input.json',
      readbackHash: browserInput?.readbackHash ?? null,
      passRoster: browserInput?.passRoster ?? [],
      visualEvidence: browserManifest?.expectations ?? [],
    },
    dawn: {
      manifest: 'artifacts/ssr-fallback/dawn/manifest.json',
      input: 'artifacts/ssr-fallback/dawn/ssr-dependencies-input.json',
      readbackHash: dawnInput?.readbackHash ?? null,
      passRoster: dawnInput?.passRoster ?? [],
      visualEvidence: dawnManifest?.expectations ?? [],
    },
  },
  ...(errors.length === 0 ? {} : { errors }),
};
mkdirSync(artifactDir, { recursive: true });
writeFileSync(resolve(artifactDir, 'paired.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[hello-ssr] paired=${JSON.stringify(artifact)}`);
process.exitCode = errors.length === 0 ? 0 : 1;
