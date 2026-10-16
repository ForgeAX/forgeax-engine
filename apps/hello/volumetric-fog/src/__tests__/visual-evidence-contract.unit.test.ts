import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = join(import.meta.dirname, '../../scripts/smoke-falsify.mjs');

const receipt = {
  expectation: {
    backend: 'webgpu',
    pixel: { oracle: 'observed-png', tolerance: 0.05 },
    provenance: {
      guid: '019f0000-0000-7000-8000-0000000003f1',
      generation: 7,
      digest: 'fnv1a:test',
    },
  },
  observed: {
    backend: 'webgpu',
    pixel: { width: 640, height: 360, mean: 0.35, variance: 0.02, nonBackgroundRatio: 0.3 },
    provenance: {
      guid: '019f0000-0000-7000-8000-0000000003f1',
      generation: 7,
      digest: 'fnv1a:test',
      head: '392c11784',
    },
    variant: 'baseline',
    renderer: {
      backendKind: 'webgpu',
      temporal: { mode: 'taa', status: 'available', limits: { maxTextureDimension3D: 256 } },
      volumetricFog: {
        status: 'available',
        resourceStage: 'accepted',
        guid: '019f0000-0000-7000-8000-0000000003f1',
        generation: 7,
        digest: 'fnv1a:test',
        passCount: 4,
        sampleCount: 262144,
        memoryBytes: 8388608,
      },
      volumePasses: ['volume-inject', 'volume-temporal', 'volume-integrate', 'volume-composite'],
      errors: [],
    },
  },
  verdict: 'pass',
  confidence: 0.98,
};

describe('volumetric fog visual evidence contract', () => {
  it('requires distinct renderer frame ids for the settled browser receipt', async () => {
    const source = await readFile(join(import.meta.dirname, '../../scripts/smoke-browser.mjs'), 'utf8');
    expect(source).toContain('frameId <= lastFrameId');
    expect(source).toContain('distinctCount: frameIds.length');
    expect(source).toContain("temporal?.mode === 'taa'");
    expect(source).toContain("temporal?.status === 'off'");

    const samples = [12, 12, 13, 13, 14];
    const distinct = samples.filter((frameId, index) => index === 0 || frameId > (samples[index - 1] ?? -1));
    expect(distinct).toEqual([12, 13, 14]);
    expect(distinct).not.toHaveLength(samples.length);
  });

  it('requires structured expectation, observation, provenance, verdict and confidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-fog-evidence-'));
    const path = join(directory, 'receipt.json');
    await writeFile(path, JSON.stringify(receipt), 'utf8');
    const result = await execFileAsync(process.execPath, [script, '--receipt', path]);
    expect(result.stdout).toContain('FALSIFY PASS');
  });

  it('accepts the current authored-off FXAA temporal inspection without TAA limits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-fog-falsify-fxaa-off-'));
    const path = join(directory, 'receipt.json');
    const authoredOff = structuredClone(receipt);
    authoredOff.observed.renderer.temporal = { mode: 'fxaa', status: 'off' };
    await writeFile(path, JSON.stringify(authoredOff), 'utf8');
    const result = await execFileAsync(process.execPath, [script, '--receipt', path]);
    expect(result.stdout).toContain('FALSIFY PASS');
  });

  it('keeps baseline temporal validation fail-closed for unknown modes', async () => {
    const invalid = structuredClone(receipt);
    invalid.observed.renderer.temporal = { mode: 'unknown', status: 'off' };
    await expectInvalidReceipt('temporal-mode', () => undefined, invalid);
  });

  it('fails when the observed backend or provenance does not match expectation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-fog-falsify-'));
    const path = join(directory, 'receipt.json');
    await writeFile(
      path,
      JSON.stringify({ ...receipt, observed: { ...receipt.observed, backend: 'dawn' } }),
      'utf8',
    );
    await expect(execFileAsync(process.execPath, [script, '--receipt', path])).rejects.toMatchObject({
      code: 1,
    });
  });

  it('fails when renderer volume identity diverges from observed provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-fog-renderer-authority-'));
    const path = join(directory, 'receipt.json');
    await writeFile(
      path,
      JSON.stringify({
        ...receipt,
        observed: {
          ...receipt.observed,
          renderer: {
            ...receipt.observed.renderer,
            volumetricFog: { ...receipt.observed.renderer.volumetricFog, digest: 'fnv1a:other' },
          },
        },
      }),
      'utf8',
    );
    await expect(execFileAsync(process.execPath, [script, '--receipt', path])).rejects.toMatchObject({
      code: 1,
    });
  });

  async function expectInvalidReceipt(label, mutate, source = receipt) {
    const directory = await mkdtemp(join(tmpdir(), `forgeax-fog-missing-${label}-`));
    const path = join(directory, 'receipt.json');
    const invalid = structuredClone(source);
    mutate(invalid);
    await writeFile(path, JSON.stringify(invalid), 'utf8');
    await expect(execFileAsync(process.execPath, [script, '--receipt', path])).rejects.toMatchObject({
      code: 1,
    });
  }

  it('fails when baseline temporal inspection is missing', async () => {
    await expectInvalidReceipt('temporal', (invalid) => {
      delete invalid.observed.renderer.temporal;
    });
  });

  it('fails when observed digest identity is missing', async () => {
    await expectInvalidReceipt('digest', (invalid) => {
      delete invalid.observed.provenance.digest;
    });
  });

  it('fails when observed generation identity is missing', async () => {
    await expectInvalidReceipt('generation', (invalid) => {
      delete invalid.observed.provenance.generation;
    });
  });

  it('requires the paired runner to bind the pinned manifest and headed raw captures', async () => {
    const runner = await readFile(join(import.meta.dirname, '../../scripts/threejs-parity-evidence.mjs'), 'utf8');
    const manifest = JSON.parse(
      await readFile(join(import.meta.dirname, '../../threejs-volume-lighting-parity.json'), 'utf8'),
    );
    expect(manifest.evidence.requiredBackend).toBe('headed-webgpu');
    expect(manifest.evidence.width).toBe(1920);
    expect(manifest.evidence.height).toBe(1080);
    expect(manifest.evidence.pairedRawPng).toBe(true);
    expect(manifest.oracle.commit).toBe('ad005397bbd15b0a9fcd5159c782eba56e1cba2a');
    expect(runner).toContain('--manifest');
    expect(runner).toContain('pairedRawPng');
    expect(runner).toContain('headed-webgpu');
  });

  it('requires causal variants and identity drift to be fail-closed', async () => {
    const [runner, falsifier] = await Promise.all([
      readFile(join(import.meta.dirname, '../../scripts/threejs-parity-evidence.mjs'), 'utf8'),
      readFile(join(import.meta.dirname, '../../scripts/smoke-falsify.mjs'), 'utf8'),
    ]);
    for (const variant of [
      'point-off',
      'spot-off',
      'projector-off',
      'shadow-off',
      'occluder-remove',
      'density-zero',
      'camera-drift',
      'time-drift',
      'projector-hash-drift',
    ]) {
      expect(runner).toContain(variant);
    }
    expect(runner).toContain('expectation');
    expect(runner).toContain('confidence');
    expect(falsifier).toContain('self-comparison');
    expect(falsifier).toContain('synthetic');
  });

  it('joins paired captures by normalized ordinal while retaining raw internal frames', async () => {
    const runner = await readFile(join(import.meta.dirname, '../../scripts/threejs-parity-evidence.mjs'), 'utf8');
    expect(runner).toContain("'normalizedFrame'");
    expect(runner).toContain("'internalFrame'");
    expect(runner).toContain('paired capture identity mismatch: ${key}');
    expect(runner).not.toContain("'frame', 'history'");
  });

  it('keeps frozen-time drift in the shared identity contract', async () => {
    const runner = await readFile(join(import.meta.dirname, '../../scripts/threejs-parity-evidence.mjs'), 'utf8');
    expect(runner).toContain("'frozenTime'");
    expect(runner).toContain("'settleFrames'");
    expect(runner).toContain("'history'");
  });

  it('requires browser capture metadata to come from an explicit frozen capture request', async () => {
    const [smoke, main] = await Promise.all([
      readFile(join(import.meta.dirname, '../../scripts/smoke-browser.mjs'), 'utf8'),
      readFile(join(import.meta.dirname, '../main.ts'), 'utf8'),
    ]);
    expect(smoke).toContain('FORGEAX_FOG_CAPTURE_META');
    expect(smoke).toContain('captureOrdinal');
    expect(smoke).toContain('internalFrame');
    expect(smoke).toContain('window.devicePixelRatio');
    expect(main).toContain('captureTime');
    expect(main).toContain('captureOrdinal');
    expect(main).toContain('frozenTime');
  });

  it('reads causal PNGs from both producers instead of accepting variant names alone', async () => {
    const runner = await readFile(join(import.meta.dirname, '../../scripts/threejs-parity-evidence.mjs'), 'utf8');
    expect(runner).toContain('--forgeax-variant-dir');
    expect(runner).toContain('--threejs-variant-dir');
    expect(runner).toContain('causalDelta');
    expect(runner).toContain('causal variant receipts are required');
  });
});
