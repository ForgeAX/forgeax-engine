import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchBench } from '../run-all.mjs';

let packageRoot;

afterEach(() => {
  if (packageRoot && existsSync(packageRoot)) rmSync(packageRoot, { recursive: true, force: true });
  packageRoot = undefined;
});

function setupPackage() {
  packageRoot = mkdtempSync(`${tmpdir()}/forgeax-gpu-frame-samples-`);
  writeFileSync(
    resolve(packageRoot, 'package.json'),
    JSON.stringify({ name: '@forgeax/hello-lod-occlusion' }),
    'utf8',
  );
  mkdirSync(resolve(packageRoot, 'artifacts'), { recursive: true });
}

function writeEvidence(build = 'head') {
  writeFileSync(
    resolve(packageRoot, 'artifacts/gpu-frame-samples.json'),
    JSON.stringify({
      schema: 'forgeax::hello-lod-occlusion::gpu-frame-samples::v4',
      identity: { build },
      retainedSamples: 128,
      metrics: { timestampAvailable: true, gpuMedianImprovement: 0.5 },
      verdict: 'production-ready',
    }),
    'utf8',
  );
}

const declaration = {
  enabled: true,
  reportPath: 'artifacts/gpu-frame-samples.json',
  reportSchema: 'gpu-frame-samples',
};

describe('gpu-frame-samples reportSchema dispatch', () => {
  it('resolves evidence from the package root and delegates validation', () => {
    setupPackage();
    writeEvidence();
    const validateFn = vi.fn(() => ({ verdict: 'production-ready' }));
    const spawnFn = vi.fn();

    const result = dispatchBench('hello-lod-occlusion', packageRoot, declaration, {
      root: packageRoot,
      currentHead: 'head',
      validateFn,
      spawnFn,
    });

    expect(result.status).toBe('ok');
    expect(result.value).toBe(0.5);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(validateFn).toHaveBeenCalledWith(
      expect.objectContaining({ schema: 'forgeax::hello-lod-occlusion::gpu-frame-samples::v4' }),
      { pkgRoot: packageRoot },
    );
  });

  it('invokes the owning package producer when evidence is missing', () => {
    setupPackage();
    const spawnFn = vi.fn(() => {
      writeEvidence();
      return { status: 0, stdout: '', stderr: '' };
    });
    const validateFn = vi.fn(() => ({ verdict: 'production-ready' }));

    const result = dispatchBench('hello-lod-occlusion', packageRoot, declaration, {
      root: packageRoot,
      currentHead: 'head',
      validateFn,
      spawnFn,
    });

    expect(result.status).toBe('ok');
    expect(spawnFn).toHaveBeenCalledWith(
      'pnpm',
      ['-F', '@forgeax/hello-lod-occlusion', 'bench:json'],
      expect.objectContaining({ cwd: packageRoot, shell: false }),
    );
  });

  it('refreshes stale evidence and rejects a producer that leaves the old head', () => {
    setupPackage();
    writeEvidence('old-head');
    const spawnFn = vi.fn(() => {
      writeEvidence('head');
      return { status: 0, stdout: '', stderr: '' };
    });
    const validateFn = vi.fn(() => ({ verdict: 'production-ready' }));

    const result = dispatchBench('hello-lod-occlusion', packageRoot, declaration, {
      root: packageRoot,
      currentHead: 'head',
      validateFn,
      spawnFn,
    });

    expect(result.status).toBe('ok');
    expect(result.details.producerInvoked).toBe(true);
    expect(result.details.identityBuild).toBe('head');
  });

  it('fails closed when the app validator does not produce a production-ready verdict', () => {
    setupPackage();
    writeEvidence();
    const result = dispatchBench('hello-lod-occlusion', packageRoot, declaration, {
      root: packageRoot,
      currentHead: 'head',
      validateFn: () => ({ verdict: 'not-production-ready' }),
    });

    expect(result.status).toBe('unavailable');
    expect(result.details.verdict).toBe('production-ready');
  });
});
