#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runCarrier } from './smoke-carrier.mjs';
import {
  assemblePerformanceAdmissionEvidence,
  createCorrectnessEvidence,
  performanceAdmissionUnavailable,
  performanceIdentityFromEnv,
  validateCorrectnessEvidence,
  validatePerformanceAdmissionEvidence,
} from './performance-contract.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const performanceAdmission = process.argv.includes('--performance-admission');
const outputPath = process.env.FORGEAX_PERFORMANCE_ADMISSION_OUTPUT;
const cpuRuntimeProbePath = process.env.FORGEAX_PERFORMANCE_ADMISSION_WEBGL2_EVIDENCE;
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashVitePayload = (root) => {
  const hash = createHash('sha256');
  const add = (path, relative) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(resolve(path, name), `${relative}/${name}`);
      return;
    }
    hash.update(relative).update('\0').update(readFileSync(path));
  };
  add(resolve(root, 'index.html'), 'index.html');
  add(resolve(root, 'src'), 'src');
  add(resolve(root, 'dist', 'index.html'), 'dist/index.html');
  add(resolve(root, 'dist', 'shaders', 'manifest.json'), 'dist/shaders/manifest.json');
  return hash.digest('hex');
};
const performanceIdentity = performanceIdentityFromEnv();
const { testedRevision, sourceRevision } = performanceIdentity;
if (!performanceIdentity.testedRevisionMatchesCheckout) {
  throw new Error(`testedRevision does not match checkout HEAD: ${testedRevision} !== ${performanceIdentity.checkoutRevision}`);
}
const buildDigest = hashVitePayload(appRoot);
const buildArtifact = {
  root: 'apps/hello/taa/dist',
  indexSha256: sha256File(resolve(appRoot, 'dist', 'index.html')),
  shaderManifestSha256: sha256File(resolve(appRoot, 'dist', 'shaders', 'manifest.json')),
  sourcePayload: 'apps/hello/taa/index.html+src',
};

function emit(evidence) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputPath !== undefined) writeFileSync(outputPath, serialized);
  process.stdout.write(serialized);
}

if (performanceAdmission) {
  if (typeof process.env.RUNNER_QUEUE !== 'string' || process.env.RUNNER_QUEUE.length === 0) {
    emit({
      ...performanceAdmissionUnavailable('performance-admission runner is unavailable: RUNNER_QUEUE is required'),
      testedRevision,
      sourceRevision,
      buildDigest,
      buildArtifact,
    });
    process.exitCode = 1;
  } else {
    let nativeStdout;
    try {
      nativeStdout = runCarrier('smoke-dawn.mjs', {
        SMOKE_CASE: 'performance',
        SMOKE_PERFORMANCE_ADMISSION: '1',
        SMOKE_BUILD_DIGEST: buildDigest,
        SMOKE_PERF_TIMING: '1',
      });
    } catch (error) {
      emit({
        ...performanceAdmissionUnavailable(`native performance-admission producer unavailable: ${error.message}`),
        testedRevision,
        sourceRevision,
        buildDigest,
        buildArtifact,
      });
      process.exitCode = 1;
    }
    if (nativeStdout !== undefined) {
      const nativeLine = nativeStdout
        .split('\n')
        .find((entry) => entry.startsWith('[hello-taa] dawnSummary='));
      const nativeSummary = nativeLine === undefined
        ? undefined
        : JSON.parse(nativeLine.slice('[hello-taa] dawnSummary='.length));
      const unavailableWithProducers = (reason, cpuProducer = null) => ({
        ...performanceAdmissionUnavailable(reason),
        testedRevision,
        sourceRevision,
        buildDigest,
        buildArtifact,
        nativeRuntimeProbe: {
          status: nativeSummary?.timing === undefined ? 'unavailable' : 'observed',
          backend: nativeSummary?.backend ?? 'unavailable',
          timing: nativeSummary?.timing ?? null,
          performanceAdmission: nativeSummary?.performanceAdmission ?? {
            status: 'unavailable',
            reason: 'Dawn correctness smoke did not run a performance-admission native producer',
          },
        },
        cpuProducer,
      });
      if (cpuRuntimeProbePath === undefined) {
        emit({
          ...unavailableWithProducers('performance-admission CPU-WebGL2 current-run producer artifact was not supplied'),
        });
        process.exitCode = 1;
      } else {
        let cpuProducer;
        try {
          cpuProducer = JSON.parse(readFileSync(cpuRuntimeProbePath, 'utf8'));
        } catch (error) {
          emit(unavailableWithProducers(`performance-admission CPU-WebGL2 producer artifact could not be read: ${error.message}`));
          process.exitCode = 1;
        }
        if (cpuProducer !== undefined) {
          const attested =
            cpuProducer.status === 'observed' &&
            cpuProducer.testedRevision === testedRevision &&
            cpuProducer.sourceRevision === sourceRevision &&
            cpuProducer.buildDigest === buildDigest &&
            cpuProducer.backend === 'wgpu-webgl2' &&
            cpuProducer.timing?.source === 'page-rAF' &&
            cpuProducer.timing?.unit === 'ms/frame';
          if (!attested) {
            emit(unavailableWithProducers('performance-admission CPU-WebGL2 producer attestation did not match this run', cpuProducer));
            process.exitCode = 1;
          } else {
            const assembled = assemblePerformanceAdmissionEvidence(nativeSummary, cpuProducer, { testedRevision, sourceRevision, buildDigest });
            if (assembled.evidence === undefined) {
              emit(unavailableWithProducers(assembled.reason, cpuProducer));
              process.exitCode = 1;
            } else {
              const evidence = assembled.evidence;
              const validation = validatePerformanceAdmissionEvidence(evidence);
              if (evidence.testedRevision !== testedRevision) validation.errors.push('testedRevision');
              if (evidence.sourceRevision !== sourceRevision) validation.errors.push('sourceRevision');
              if (evidence.buildDigest !== buildDigest) validation.errors.push('buildDigest');
              validation.ok = validation.errors.length === 0;
              emit({ ...evidence, validation, nativeRuntimeProbe: nativeSummary, cpuRuntimeProbe: cpuProducer });
              if (!validation.ok) process.exitCode = 1;
            }
          }
        }
      }
    }
  }
} else {
  const stdout = runCarrier('smoke-dawn.mjs', { SMOKE_CASE: 'performance' });
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith('[hello-taa] dawnSummary='));
  if (line === undefined) throw new Error('Dawn carrier did not publish a structured summary');
  const summary = JSON.parse(line.slice('[hello-taa] dawnSummary='.length));
  const evidence = createCorrectnessEvidence(summary, {
    testedRevision,
    sourceRevision,
    buildDigest: sha256File(resolve(appRoot, 'package.json')),
    source: {
      path: 'apps/hello/taa/src/main.ts',
      sha256: sha256File(resolve(appRoot, 'src', 'main.ts')),
    },
    build: {
      command: 'pnpm --filter @forgeax/hello-taa build',
      packageSha256: sha256File(resolve(appRoot, 'package.json')),
    },
  });
  const validation = validateCorrectnessEvidence(evidence);
  emit({ ...evidence, validation, producer: 'Dawn smoke readback/inspection' });
  if (!validation.ok) process.exitCode = 1;
}
