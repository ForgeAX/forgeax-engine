#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const args = process.argv.slice(2);
const allowBlocked = args.includes('--allow-blocked');
const separator = args.indexOf('--');
const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
const command = commandArgs[0] ?? 'pnpm';
const childArgs =
  commandArgs.length > 0
    ? commandArgs.slice(1)
    : ['--filter', '@forgeax/hello-m7-backend-recovery', 'smoke'];
const artifactRoot = resolve(
  process.env.FORGEAX_M7_ARTIFACT_DIR ??
    resolve(repoRoot, 'artifacts/renderer-device-loss/m7-device-loss'),
);

mkdirSync(artifactRoot, { recursive: true });

const result = spawnSync(command, childArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    INIT_CWD: repoRoot,
    FORGEAX_M7_ARTIFACT_DIR: artifactRoot,
  },
  stdio: 'inherit',
});

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function findLatestEvidence() {
  const candidates = [];
  for (const entry of readdirSync(artifactRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const runRoot = resolve(artifactRoot, entry.name);
    for (const name of ['device-loss-failure.json', 'device-loss-summary.json']) {
      const path = resolve(runRoot, name);
      if (existsSync(path))
        candidates.push({ path, value: readJson(path), mtime: statSync(path).mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime);
  return candidates[0];
}

function writeDecision(decision) {
  writeFileSync(
    resolve(artifactRoot, 'm7-decision.json'),
    `${JSON.stringify(decision, null, 2)}\n`,
  );
}

if (result.status === 0) {
  writeDecision({
    status: 'pass',
    notPassed: false,
    command: [command, ...childArgs],
  });
  process.exit(0);
}

const evidence = findLatestEvidence();
const evidenceIsBlocked = evidence?.value?.status === 'insufficient-evidence';
if (allowBlocked && evidenceIsBlocked) {
  const decision = {
    status: 'blocked',
    notPassed: true,
    reason: 'authorized-ac-19-evidence-gap',
    command: [command, ...childArgs],
    evidencePath: evidence.path,
    evidence: evidence.value,
  };
  writeDecision(decision);
  console.error(`[m7-backend] BLOCKED - AC-19 evidence gap; not counted as pass: ${evidence.path}`);
  process.exit(0);
}

const failure = {
  status: 'failed',
  notPassed: true,
  command: [command, ...childArgs],
  evidencePath: evidence?.path ?? null,
  evidence: evidence?.value ?? null,
  exitCode: result.status,
  signal: result.signal ?? null,
  error: result.error?.message ?? null,
};
writeDecision(failure);
process.exit(result.status ?? 1);
