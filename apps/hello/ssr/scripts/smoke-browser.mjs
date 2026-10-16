#!/usr/bin/env node
import { SSR_FIXTURE_REVISION } from '../src/reflection-scene.mjs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveReflectionFallbackEvidence,
  parseReflectionFallbackReport,
  reflectionFallbackValidationLog,
} from './ssr-fallback-evidence.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/smoke-reflection-probe-browser.mjs'], {
  cwd: appDir,
  encoding: 'utf8',
  env: { ...process.env, VITE_REFLECTION_PROBE_EVIDENCE: '1' },
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error !== undefined) throw result.error;
if (result.signal !== null) throw new Error(`Browser evidence subprocess terminated by ${result.signal}`);

if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const runId = output.match(/runId=([A-Za-z0-9-]+)/)?.[1] ?? `browser-${Date.now()}`;
  const report = parseReflectionFallbackReport(output);
  if (report === undefined || report.reflectionProbe === undefined) {
    throw new Error('ReflectionProbe browser smoke did not publish a completed producer report');
  }
  const completedFrames = report.reflectionProbe.frames ??
    Number(output.match(/completedFrames["']?:\s*(\d+)/)?.[1] ?? 0);
  if (completedFrames !== 60) {
    throw new Error(`ReflectionProbe browser report completed ${completedFrames} frames; expected 60`);
  }
  const evidence = deriveReflectionFallbackEvidence(report);
  if (evidence.status !== 'pass') {
    console.error(`[smoke] FAIL - SSR fallback evidence is blocked: ${JSON.stringify(evidence.failures)}`);
    process.exitCode = 1;
  }
  const rootDir = resolve(appDir, '../../..');
  const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifestDir = resolve(rootDir, 'artifacts/ssr-fallback/browser');
  mkdirSync(manifestDir, { recursive: true });
  const identity = {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
    sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: rootDir, encoding: 'utf8' }).trim(),
    lockSha256: hashFile(resolve(rootDir, 'pnpm-lock.yaml')),
    buildSha256: hashFile(resolve(rootDir, 'packages/render/dist/index.mjs')),
  };
  writeFileSync(
    resolve(manifestDir, 'ssr-dependencies-input.json'),
    `${JSON.stringify({
      identity,
      ssrDependencies: report.reflectionProbe.ssrDependencies,
      ssr: report.reflectionProbe.ssr,
      passRoster: report.reflectionProbe.ssr?.passRoster ?? [],
      readbackHash: report.reflectionProbe.reflectionFallbackReadback?.readbackHash ?? null,
    }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(manifestDir, 'validation.log'),
    reflectionFallbackValidationLog('browser', report, evidence),
  );
  writeFileSync(resolve(manifestDir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'ssr-fallback-evidence/1',
    featureId: 'feat-20260831-ssr-probe-environment-fallback',
    lane: 'browser',
    status: evidence.status,
    identity,
    fixture: { revision: SSR_FIXTURE_REVISION, frames: completedFrames },
    execution: {
      url: report.launchUrl,
      backend: 'webgpu',
      frames: completedFrames,
    },
    readback: {
      locator: `.forgeax-debug/${runId}/live.png`,
      byteLength: report.reflectionProbe.pngByteLength,
      validationLog: 'artifacts/ssr-fallback/browser/validation.log',
    },
    png: { locator: `.forgeax-debug/${runId}/live.png`, width: 256, height: 256 },
    thresholds: { linearHdrAbsErrorMax: 0.05, hdrLumaRelativeErrorMax: 0.02 },
    expectations: evidence.expectations,
    ...(evidence.failures.length === 0 ? {} : { failures: evidence.failures }),
  }, null, 2)}\n`);
}
