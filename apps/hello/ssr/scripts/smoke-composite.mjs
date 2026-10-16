#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDirectory = resolve(packageRoot, '../../../artifacts/ssr-fallback/dawn');
const passPattern = /\[smoke\] PASS - targetId=target-hello-ssr, frames=(\d+)\b/g;
const lanes = [
  {
    id: 'ssr',
    env: { SMOKE_ANIMATE_RECEIVER: '1', VITE_SSR_EVIDENCE: '1' },
  },
  {
    id: 'reflection-probe',
    env: { VITE_REFLECTION_PROBE_EVIDENCE: '1' },
  },
];

async function runLane(lane) {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-ssr-composite-'));
  const stdoutPath = resolve(directory, 'stdout.log');
  const stderrPath = resolve(directory, 'stderr.log');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let spawnError = null;
  const result = await new Promise((resolveResult) => {
    const child = spawn(process.execPath, ['scripts/smoke-dawn.mjs'], {
      cwd: packageRoot,
      env: { ...process.env, ...lane.env },
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const output = {
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  rmSync(directory, { recursive: true, force: true });
  const text = `${output.stdout}${output.stderr}`;
  if (spawnError !== null) {
    process.stderr.write(`[ssr-composite] lane=${lane.id} spawn-error=${spawnError}\n`);
  }
  const frames = [...text.matchAll(passPattern)].map((match) => Number(match[1]));
  return {
    id: lane.id,
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError,
    framesObserved: frames.at(-1) ?? null,
    passLineCount: frames.length,
    outputSha256: createHash('sha256').update(text).digest('hex'),
  };
}

const results = [];
for (const lane of lanes) {
  process.stdout.write(`[ssr-composite] lane=${lane.id}\n`);
  results.push(await runLane(lane));
}
const failed = results.filter(
  (result) => result.exitCode !== 0 || result.signal !== null || result.spawnError !== null,
);
const missingFrames = results.filter(
  (result) => result.framesObserved === null || result.passLineCount !== 1,
);
const framesObserved = Math.min(...results.map((result) => result.framesObserved ?? 0));
const report = {
  schemaVersion: 1,
  kind: 'hello-ssr-composite-smoke',
  gateId: 'hello-ssr/smoke',
  commandId: 'smoke',
  lanes: results,
  framesObserved,
  status: failed.length === 0 && missingFrames.length === 0 ? 'pass' : 'fail',
};
mkdirSync(artifactDirectory, { recursive: true });
writeFileSync(
  resolve(artifactDirectory, 'composite-receipt.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
if (report.status !== 'pass') {
  console.error(`[ssr-composite] FAIL - ${JSON.stringify(report)}`);
  process.exitCode = 1;
} else {
  emitSmokeReceipt('hello-ssr/smoke', framesObserved);
}
