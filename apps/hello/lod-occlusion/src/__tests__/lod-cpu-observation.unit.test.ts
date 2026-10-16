import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, expect, it, vi } from 'vitest';
import evidenceSchema from '../../evidence/gpu-frame-samples.schema.json' with { type: 'json' };

const SCRIPT = '../../scripts/smoke-performance.mjs';

afterEach(() => vi.restoreAllMocks());

function fixture(profile: boolean) {
  let capture = false;
  let frameId = 0;
  const draws: { capture: boolean; include?: readonly string[] }[] = [];
  const beginProfile = vi.fn(() => ({
    ok: true,
    value: { finish: () => ({ ok: true, value: { captureId: 'test-profile' } }) },
  }));
  const world = { world: { update: () => ({ unwrap: () => undefined }) }, lease: {} };
  return {
    baseline: world,
    treatment: world,
    occlusionOnly: world,
    identity: {
      build: 'test-build',
      scene: 'lod-scene',
      sourceKey: 'lod-scene:root',
      sidecarDigest: 'sha256:a',
      packDigest: 'sha256:b',
      seed: 7,
      viewport: '200x150',
      adapter: 'test',
      backend: 'test',
      capabilities: ['timestamp-query'],
      fixture: { candidateScale: [0.5, 0.5, 0.5], occluderScale: [2, 10, 0.1] },
    },
    rendererErrors: [],
    profiler: profile ? { startCapture: beginProfile } : undefined,
    beginProfile,
    draws,
    setGpuTimingCapture: (enabled: boolean) => {
      capture = enabled;
    },
    renderer: {
      draw: () => {
        draws.push({ capture });
        return { ok: true, value: { frameId: frameId++ } };
      },
      observe: async (_receipt: unknown, options: { include: readonly string[] }) => {
        const draw = draws.at(-1);
        if (draw === undefined) throw Error('missing draw');
        draw.include = options.include;
        return { ok: true, value: { volumeTimings: { status: 'ready', frameMs: 1 } } };
      },
    },
    debugDrawHost: {
      inspectLodOcclusion: () => ({
        lodOcclusion: {
          count: { candidates: 128, visible: 16, occluded: 112 },
          lodHistogram: [{ level: 0, count: 128 }],
        },
        gpuDriven: { geometryWork: 1, rootGeometryWork: 2, batchCount: 1, indirectDrawCount: 1 },
      }),
    },
  };
}

it.each([
  false,
  true,
])('gives every retained CPU condition the same timing and profile burden (profile=%s)', async (profile) => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const { captureCondition, WARMUP_SUBMITS, RETAINED_SAMPLES_PER_ORDER } = await import(SCRIPT);
  const retained = RETAINED_SAMPLES_PER_ORDER / 2;
  for (const order of ['baseline-treatment', 'treatment-baseline']) {
    for (const condition of ['occlusionOnly', 'baseline', 'treatment']) {
      const f = fixture(profile);
      const captured = await captureCondition(f, condition, order);
      expect(f.draws.slice(0, WARMUP_SUBMITS)).toEqual(
        Array.from({ length: WARMUP_SUBMITS }, () => ({ capture: false, include: [] })),
      );
      expect(f.draws.slice(WARMUP_SUBMITS)).toEqual(
        Array.from({ length: retained }, () => ({ capture: true, include: ['timings'] })),
      );
      expect(f.beginProfile).toHaveBeenCalledTimes(profile ? 1 : 0);
      expect(captured.samples).toHaveLength(condition === 'occlusionOnly' ? 0 : retained);
      expect(captured.facts.cpuSamples).toHaveLength(retained);
      expect(captured.facts.cpuSamples[0]).toMatchObject({
        condition,
        order,
        frame: WARMUP_SUBMITS,
        frameId: WARMUP_SUBMITS,
        captureGpuTimings: true,
        observeTimings: true,
        profileCapture: profile,
      });
    }
  }
});

it('persists completed CPU and GPU observations when a retained timing read fails', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const { captureCondition, writeUnavailableEvidence, WARMUP_SUBMITS, RETAINED_SAMPLES_PER_ORDER } =
    await import(SCRIPT);
  const f = fixture(false);
  const first = await captureCondition(f, 'treatment', 'treatment-baseline');
  const failedReceipt = WARMUP_SUBMITS * 2 + RETAINED_SAMPLES_PER_ORDER / 2 + 1;
  const observe = f.renderer.observe;
  vi.spyOn(f.renderer, 'observe').mockImplementation(async (...args) => {
    if (f.draws.length === failedReceipt + 1) throw Error('retained timing read failed');
    return observe(...args);
  });
  await expect(
    captureCondition(f, 'treatment', 'baseline-treatment', first.facts, first.samples),
  ).rejects.toThrow('retained timing read failed');

  const directory = mkdtempSync(join(tmpdir(), 'forgeax-lod-cpu-failure-'));
  try {
    const path = join(directory, 'gpu-frame-samples.json');
    writeUnavailableEvidence(
      'retained timing read failed',
      'test-build',
      {
        identity: f.identity,
        samples: first.samples,
        cpuSamples: first.facts.cpuSamples,
      },
      path,
    );
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    expect(evidence.verdict).toBe('unavailable');
    expect(evidence.metrics).toMatchObject({
      timestampAvailable: false,
      reason: 'retained timing read failed',
    });
    expect(evidence.samples).toHaveLength(RETAINED_SAMPLES_PER_ORDER / 2 + 1);
    expect(evidence.samples.at(-1)).toMatchObject({
      condition: 'treatment',
      frameId: failedReceipt - 1,
    });
    expect(evidence.cpu.samples).toHaveLength(RETAINED_SAMPLES_PER_ORDER / 2 + 2);
    expect(evidence.cpu.samples.at(-1)).toMatchObject({
      condition: 'treatment',
      frameId: failedReceipt,
    });
    expect(evidence.cpu.samples).toEqual(first.facts.cpuSamples);
    expect(evidence.samples).toEqual(first.samples);
    expect(new Ajv2020({ strict: false }).compile(evidenceSchema)(evidence)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
