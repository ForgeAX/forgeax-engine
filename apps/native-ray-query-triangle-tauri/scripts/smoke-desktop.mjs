#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePackagedExecutable } from './packaged-executable.mjs';
import { verifyReport } from './verify-report.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const reportDir = resolve(appRoot, 'report/native-ray-query-triangle');
const reportPath = resolve(reportDir, 'report.json');
mkdirSync(reportDir, { recursive: true });

function packagedExecutable() {
  if (process.env.FORGEAX_NATIVE_RAY_QUERY_EXECUTABLE) {
    return resolve(process.env.FORGEAX_NATIVE_RAY_QUERY_EXECUTABLE);
  }
  return resolvePackagedExecutable({
    appRoot,
    cargoTargetDir: process.env.CARGO_TARGET_DIR,
    platform: process.platform,
  });
}

const executable = packagedExecutable();
const result = spawnSync(executable, ['--smoke', '--report-dir', reportDir], {
  cwd: appRoot,
  encoding: 'utf8',
  timeout: 120_000,
  env: { ...process.env, FORGEAX_RAY_QUERY_SMOKE: '1' },
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

const allowUnsupported = process.argv.includes('--allow-unsupported');
const report = verifyReport(reportPath, { allowUnsupported });
if (report.verdict === 'ok' && result.status !== 0) {
  throw new Error(`packaged executable reported ok but exited ${result.status}`);
}
if (report.verdict === 'unsupported' && (!allowUnsupported || result.status !== 2)) {
  throw new Error(`unsupported run exited ${result.status}; expected 2`);
}
process.stdout.write(`${JSON.stringify({ executable, verdict: report.verdict, reportPath })}\n`);
