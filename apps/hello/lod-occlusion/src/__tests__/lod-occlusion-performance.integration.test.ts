import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import evidenceSchema from '../../evidence/gpu-frame-samples.schema.json' with { type: 'json' };

import packageJson from '../../package.json' with { type: 'json' };

const SCRIPT = '../../scripts/smoke-performance.mjs';

describe('hello-lod-occlusion performance evidence contract', () => {
  it('declares a real producer for the enabled benchmark metric', () => {
    expect(packageJson.scripts['bench:json']).toContain('FORGEAX_LOD_GPU_PRODUCER=1');
    expect(packageJson.forgeax.metrics.bench).toMatchObject({
      enabled: true,
      reportPath: 'artifacts/gpu-frame-samples.json',
    });
  });

  it('keeps ProfileCapture diagnostics opt-in, bounded, and paired by order', async () => {
    const {
      LOD_PROFILE_EVENT_LIMIT,
      LOD_PROFILE_FRAME_LIMIT,
      LOD_PROFILE_PHASES,
      buildLodProfileDiagnostics,
      profileCaptureKey,
    } = await import(SCRIPT);
    const { compareProfileCaptures, validateProfileCapture } = await import('@forgeax/engine-profiler');
    const capture = (captureId: string, condition: string) => ({
      schemaVersion: '1.0',
      captureId,
      timeUnit: 'microseconds',
      frameLimit: LOD_PROFILE_FRAME_LIMIT,
      eventLimit: LOD_PROFILE_EVENT_LIMIT,
      phaseCatalog: { app: [], render: LOD_PROFILE_PHASES },
      records:
        condition !== 'baseline'
          ? LOD_PROFILE_PHASES.map((phase: string, index: number) => ({
              kind: 'phase',
              source: 'render',
              frameId: 1,
              phase,
              startMicros: index,
              endMicros: index + 1,
              durationMicros: 1,
            }))
          : [],
      completeness: {
        status: 'complete',
        retainedEventCount: condition !== 'baseline' ? LOD_PROFILE_PHASES.length : 0,
        droppedEventCount: 0,
      },
    });
    const captures: Record<string, unknown> = {};
    for (const order of ['baseline-treatment', 'treatment-baseline']) {
      for (const condition of ['baseline', 'occlusionOnly', 'treatment']) {
        captures[profileCaptureKey(order, condition)] = capture(
          `capture-${String(Object.keys(captures).length + 1).padStart(4, '0')}`,
          condition,
        );
      }
    }
    const diagnostics = buildLodProfileDiagnostics({
      identity: { build: 'test-build' },
      captures,
      validateProfileCapture,
      compareProfileCaptures,
    });
    expect(diagnostics.schema).toBe('forgeax::hello-lod-occlusion::profile-diagnostics::v2');
    expect(diagnostics.keys).toHaveLength(6);
    expect(diagnostics.frameLimit).toBe(32);
    expect(diagnostics.eventLimit).toBe(16_384);
    expect(Object.keys(diagnostics.comparisons)).toEqual([
      'baseline-treatment',
      'treatment-baseline',
    ]);
  });

  const identity = {
    build: 'build-a',
    scene: 'lod-scene',
    sourceKey: 'lod-scene:root',
    sidecarDigest: 'sha256:a',
    packDigest: 'sha256:b',
    seed: 7,
    viewport: '1280x720',
    adapter: 'test',
    backend: 'dawn',
    capabilities: ['timestamp-query'],
    fixture: {
      candidateScale: [0.5, 0.5, 0.5],
      occluderScale: [2, 10, 0.1],
    },
  };

  const rawSamples = () =>
    Array.from({ length: 128 }, (_, index) => ({
      identity,
      frameId: index,
      order: index % 4 < 2 ? 'baseline-treatment' : 'treatment-baseline',
      condition: index % 2 === 0 ? 'baseline' : 'treatment',
      gpuFrameUs: index % 2 === 0 ? 100 : 70,
    }));

  const worldFact = (
    view: string,
    visible: number,
    occluded: number,
    lodHistogram: readonly { level: number; count: number }[],
    primitiveSlot: number,
  ) => ({
    view,
    candidates: 128,
    visible,
    occluded,
    lodHistogram,
    primitiveSlot,
    slotGeneration: 1,
  });
  const falsification = [
    ['forced-lod0', 'lod-selection-policy', ['geometry', 'occlusion', 'view']],
    ['all-visible', 'occluder-absence', ['geometry', 'lod', 'view']],
    ['occlusion-off-on', 'occluder-presence', ['geometry', 'lod', 'view']],
    ['gpu-occlusion-off', 'gpu-occlusion-config', ['geometry', 'lod', 'occluder', 'view']],
    ['world-reorder', 'world-array-order', ['geometry', 'primitive', 'view']],
  ].map(([caseName, intervention, held]) => ({
    case: caseName,
    verdict: 'pass',
    evidence: {
      protocol: { intervention, held },
      ...(caseName === 'occlusion-off-on' || caseName === 'gpu-occlusion-off'
        ? {
            off: {
              count: { candidates: 128, visible: 128, occluded: 0 },
            },
            on: {
              count: { candidates: 128, visible: 16, occluded: 112 },
            },
            settleFrames: 16,
          }
        : {}),
      ...(caseName === 'world-reorder'
        ? {
            attribution: {
              status: 'same-submit',
              forwardSubmit: { frameId: 100, build: 'build-a', deviceGeneration: 1 },
              reverseSubmit: { frameId: 101, build: 'build-a', deviceGeneration: 1 },
            },
            forward: { frameId: 100, view: 'shared-view' },
            reverse: { frameId: 101, view: 'shared-view' },
            sameViewIdentity: true,
            samePrimitiveIdentity: true,
            forwardSlot: { primitiveSlot: 0, slotGeneration: 1 },
            reverseSlot: { primitiveSlot: 0, slotGeneration: 1 },
            worlds: { treatment: 'treatment-world', baseline: 'baseline-world' },
            worldAttribution: {
              treatment: {
                forward: worldFact('treatment-world', 16, 112, [{ level: 1, count: 128 }], 1),
                reverse: worldFact('treatment-world', 16, 112, [{ level: 1, count: 128 }], 1),
              },
              baseline: {
                forward: worldFact('baseline-world', 128, 0, [{ level: 0, count: 128 }], 2),
                reverse: worldFact('baseline-world', 128, 0, [{ level: 0, count: 128 }], 2),
              },
            },
          }
        : {}),
    },
  }));

  const inspection = {
    baseline: {
      frames: 128,
      candidates: 128,
      visible: 128,
      occluded: 0,
      lodHistogram: [{ level: 0, count: 128 }],
      lodCoverage: 0,
      submittedInstanceRatio: 1,
      geometryWorkReduction: 0,
      batchCount: 1,
      indirectDrawCount: 1,
      cpuP50Us: 100,
      cpuP95Us: 120,
    },
    treatment: {
      frames: 128,
      candidates: 128,
      visible: 16,
      occluded: 112,
      lodHistogram: [{ level: 1, count: 128 }],
      lodCoverage: 1,
      submittedInstanceRatio: 0.125,
      geometryWorkReduction: 0.8,
      batchCount: 128,
      indirectDrawCount: 16,
      cpuP50Us: 90,
      cpuP95Us: 110,
    },
  };
  const groups = {
    control: inspection.baseline,
    lodOnly: {
      ...inspection.baseline,
      lodHistogram: [
        { level: 0, count: 64 },
        { level: 1, count: 64 },
      ],
      lodCoverage: 0.5,
      geometryWorkReduction: 0.2,
    },
    occlusionOnly: {
      ...inspection.treatment,
      visible: 16,
      occluded: 112,
      lodHistogram: [{ level: 0, count: 128 }],
      lodCoverage: 0,
      submittedInstanceRatio: 0.125,
      geometryWorkReduction: 0,
      cpuP50Us: 100,
      cpuP95Us: 120,
    },
    treatment: inspection.treatment,
  };

  const rawCpu = (
    facts = {
      baseline: inspection.baseline,
      treatment: inspection.treatment,
      occlusionOnly: groups.occlusionOnly,
    },
  ) => ({
    metric: 'process.cpuUsage',
    timeUnit: 'microseconds',
    samples: ['baseline-treatment', 'treatment-baseline'].flatMap((order, orderIndex) =>
      (['baseline', 'occlusionOnly', 'treatment'] as const).flatMap((condition) => {
        const gpuSamples = rawSamples().filter(
          (sample) => sample.order === order && sample.condition === condition,
        );
        return Array.from({ length: 32 }, (_, index) => {
          const frameId =
            condition === 'occlusionOnly'
              ? 128 + orderIndex * 32 + index
              : gpuSamples[index]?.frameId;
          if (frameId === undefined) throw new Error('missing fixture GPU receipt');
          return {
            condition,
            order,
            frame: 32 + index,
            frameId,
            userUs: index < 28 ? facts[condition].cpuP50Us : facts[condition].cpuP95Us,
            systemUs: 0,
            captureGpuTimings: true,
            observeTimings: true,
            profileCapture: false,
          };
        });
      }),
    ),
  });

  const admittingEvidence = (schema: string, falsificationOverride = falsification) => ({
    schema,
    identity,
    warmupSubmits: 32,
    retainedSamples: 128,
    metrics: {
      timestampAvailable: true,
      settleSubmits: 16,
      lodCoverage: 1,
      submittedInstanceRatio: 0.125,
      geometryWorkReduction: 0.8,
      cpuP50Us: 90,
      cpuP95Us: 110,
      cpuP95Regression: -0.08333333333333333,
      workload: { candidates: 128, visible: 16, occluded: 112 },
      inspection: structuredClone(inspection),
      groups: structuredClone(groups),
      gpuMedianImprovement: 0.3,
      gpuP95Regression: -0.3,
    },
    falsification: falsificationOverride,
    samples: rawSamples(),
    cpu: rawCpu(),
    verdict: 'not-production-ready',
  });

  it('requires v4 raw CPU evidence and receipt links without admitting old summaries', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const evidence = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    const validateSchema = new Ajv2020({ strict: false }).compile(evidenceSchema);
    expect(validateSchema(evidence), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(() =>
      validatePerformanceEvidence({
        ...evidence,
        schema: 'forgeax::hello-lod-occlusion::gpu-frame-samples::v3',
      }),
    ).toThrow('schema mismatch');
    expect(() => validatePerformanceEvidence({ ...evidence, cpu: undefined })).toThrow(
      'raw process.cpuUsage',
    );
    expect(validateSchema({ ...evidence, cpu: undefined })).toBe(false);
    const mismatched = structuredClone(evidence);
    mismatched.samples = mismatched.samples.map((sample, index) =>
      index === 0 ? { ...sample, frameId: 9999 } : sample,
    );
    expect(() => validatePerformanceEvidence(mismatched)).toThrow('matching retained CPU receipt');
  });

  it('rejects asymmetric observation, incomplete windows, duplicated receipts and CPU summary drift', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    for (const field of ['captureGpuTimings', 'observeTimings', 'profileCapture'] as const) {
      const evidence = structuredClone(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA));
      const sample = evidence.cpu.samples.find((sample) => sample.condition === 'occlusionOnly');
      if (sample === undefined) throw new Error('missing fixture CPU control');
      sample[field] = !sample[field];
      expect(() => validatePerformanceEvidence(evidence)).toThrow(
        'identical GPU timing, observation and profile',
      );
    }
    const missing = structuredClone(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA));
    missing.cpu.samples.pop();
    expect(() => validatePerformanceEvidence(missing)).toThrow('32 retained samples');
    const duplicate = structuredClone(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA));
    const [first, second] = duplicate.cpu.samples;
    if (first === undefined || second === undefined) throw new Error('missing fixture CPU samples');
    second.frameId = first.frameId;
    expect(() => validatePerformanceEvidence(duplicate)).toThrow(
      'repeats a retained frame or receipt',
    );
    const drift = structuredClone(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA));
    drift.metrics.inspection.treatment.cpuP50Us += 1;
    expect(() => validatePerformanceEvidence(drift)).toThrow(
      'summary must derive from pooled raw process',
    );
  });

  it('uses nearest-rank statistics over both A/B orders', async () => {
    const { summarize } = await import(SCRIPT);
    const values = Array.from({ length: 128 }, (_, index) => index + 1);
    expect(summarize(values)).toEqual({ medianUs: 64, p95Us: 122, samples: 128 });
  });

  it('fails closed when GPU timestamp evidence is unavailable', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const result = validatePerformanceEvidence({
      schema: GPU_FRAME_SAMPLES_SCHEMA,
      identity,
      warmupSubmits: 32,
      retainedSamples: 128,
      metrics: { timestampAvailable: false },
      falsification,
      samples: [],
      cpu: { metric: 'process.cpuUsage', timeUnit: 'microseconds', samples: [] },
      verdict: 'unavailable',
    });
    expect(result.verdict).toBe('unavailable');
  });

  it('does not accept mismatched identity across samples', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const samples = rawSamples();
    const sample = samples[12];
    if (sample === undefined) throw new Error('test fixture must contain sample 12');
    samples[12] = { ...sample, identity: { ...identity, packDigest: 'sha256:other' } };
    const result = validatePerformanceEvidence({
      schema: GPU_FRAME_SAMPLES_SCHEMA,
      identity,
      warmupSubmits: 32,
      retainedSamples: 128,
      metrics: {
        timestampAvailable: true,
        settleSubmits: 16,
        lodCoverage: 1,
        submittedInstanceRatio: 0.125,
        geometryWorkReduction: 0.2,
        cpuP50Us: 100,
        cpuP95Us: 120,
        cpuP95Regression: -0.08333333333333333,
        workload: { candidates: 128, visible: 16, occluded: 112 },
        inspection,
        groups,
        gpuMedianImprovement: 0.3,
        gpuP95Regression: 0,
      },
      falsification,
      samples,
      cpu: rawCpu(),
      verdict: 'identity-mismatch',
    });
    expect(result.verdict).toBe('identity-mismatch');
  });

  it('gates submitted instances by reduction rather than visibility retention', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const result = validatePerformanceEvidence({
      schema: GPU_FRAME_SAMPLES_SCHEMA,
      identity,
      warmupSubmits: 32,
      retainedSamples: 128,
      metrics: {
        timestampAvailable: true,
        settleSubmits: 16,
        lodCoverage: 1,
        submittedInstanceRatio: 0.125,
        geometryWorkReduction: 0.8,
        cpuP50Us: 90,
        cpuP95Us: 110,
        cpuP95Regression: -0.08333333333333333,
        workload: { candidates: 128, visible: 16, occluded: 112 },
        inspection,
        groups,
        gpuMedianImprovement: 0.3,
        gpuP95Regression: -0.3,
      },
      falsification,
      samples: rawSamples(),
      cpu: rawCpu(),
      verdict: 'not-production-ready',
    });
    expect(result.verdict).toBe('production-ready');
  });

  it('accepts selector batches that contain suppressed-only entries while bounding raster commands', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const sparseDrawEvidence = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    sparseDrawEvidence.metrics.inspection.treatment = {
      ...sparseDrawEvidence.metrics.inspection.treatment,
      batchCount: 128,
      indirectDrawCount: 16,
    };
    const result = validatePerformanceEvidence(sparseDrawEvidence);
    expect(result.verdict).toBe('production-ready');
  });

  it('uses the CPU median for admission while retaining p95 tail evidence', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const noisyTailEvidence = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    noisyTailEvidence.metrics.inspection = {
      baseline: { ...noisyTailEvidence.metrics.inspection.baseline, cpuP95Us: 100 },
      treatment: { ...noisyTailEvidence.metrics.inspection.treatment, cpuP95Us: 300 },
    };
    noisyTailEvidence.metrics.groups.occlusionOnly = {
      ...noisyTailEvidence.metrics.groups.occlusionOnly,
      cpuP95Us: 100,
    };
    noisyTailEvidence.metrics.groups.control = noisyTailEvidence.metrics.inspection.baseline;
    noisyTailEvidence.metrics.groups.treatment = noisyTailEvidence.metrics.inspection.treatment;
    noisyTailEvidence.metrics.cpuP95Us = 300;
    noisyTailEvidence.metrics.cpuP95Regression = 2;
    noisyTailEvidence.cpu = rawCpu({
      ...noisyTailEvidence.metrics.inspection,
      occlusionOnly: noisyTailEvidence.metrics.groups.occlusionOnly,
    });
    const result = validatePerformanceEvidence(noisyTailEvidence);
    expect(result.verdict).toBe('production-ready');
  });

  it('holds occlusion cost constant for CPU median admission and rejects incremental LOD regression', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const evidence = structuredClone(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA));
    evidence.metrics.inspection.baseline.cpuP50Us = 40;
    evidence.metrics.groups.control.cpuP50Us = 40;
    evidence.cpu = rawCpu({
      ...evidence.metrics.inspection,
      occlusionOnly: evidence.metrics.groups.occlusionOnly,
    });
    // The no-occluder GPU control is cheaper, but the same-HZB CPU control
    // proves that adding LOD stays inside the existing 20% CPU limit.
    expect(validatePerformanceEvidence(evidence).verdict).toBe('production-ready');
    evidence.metrics.groups.occlusionOnly.cpuP50Us = 70;
    evidence.cpu = rawCpu({
      ...evidence.metrics.inspection,
      occlusionOnly: evidence.metrics.groups.occlusionOnly,
    });
    expect(validatePerformanceEvidence(evidence).verdict).toBe('not-production-ready');
  });

  it('rejects a cold short CPU control instead of admitting against its inflated cost', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const evidence = structuredClone(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA));
    evidence.metrics.groups.occlusionOnly.frames = 16;
    expect(() => validatePerformanceEvidence(evidence)).toThrow('same warm-up and retained frame windows');
  });

  it('admits the machine-stable GPU median floor while retaining the p95 gate', async () => {
    const {
      GPU_FRAME_SAMPLES_SCHEMA,
      GPU_MEDIAN_IMPROVEMENT_LIMIT,
      validatePerformanceEvidence,
    } = await import(SCRIPT);
    expect(GPU_MEDIAN_IMPROVEMENT_LIMIT).toBe(0.15);
    const atFloor = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    atFloor.samples = atFloor.samples.map((sample) =>
      sample.condition === 'treatment' ? { ...sample, gpuFrameUs: 85 } : sample,
    );
    atFloor.metrics.gpuMedianImprovement = 0.15;
    atFloor.metrics.gpuP95Regression = -0.15;
    expect(validatePerformanceEvidence(atFloor).verdict).toBe('production-ready');

    const belowFloor = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    belowFloor.samples = belowFloor.samples.map((sample) =>
      sample.condition === 'treatment' ? { ...sample, gpuFrameUs: 86 } : sample,
    );
    belowFloor.metrics.gpuMedianImprovement = 0.14;
    belowFloor.metrics.gpuP95Regression = -0.14;
    expect(validatePerformanceEvidence(belowFloor).verdict).toBe('not-production-ready');
  });

  it('admits one stable raster command per LOD level of a selector batch', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA, BENCHMARK_LOD_LEVEL_SLOTS } =
      await import(SCRIPT);
    const evidence = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    evidence.metrics.groups.lodOnly = {
      ...evidence.metrics.groups.lodOnly,
      batchCount: 1,
      indirectDrawCount: BENCHMARK_LOD_LEVEL_SLOTS,
    };
    expect(validatePerformanceEvidence(evidence).verdict).toBe(
      validatePerformanceEvidence(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA)).verdict,
    );
    evidence.metrics.groups.lodOnly = {
      ...evidence.metrics.groups.lodOnly,
      indirectDrawCount: BENCHMARK_LOD_LEVEL_SLOTS + 1,
    };
    expect(() => validatePerformanceEvidence(evidence)).toThrow(
      'performance lodOnly group is not linked to the locked workload',
    );
  });

  it('rejects raster command counts that exceed selector batch LOD slots', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const invalidEvidence = admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA);
    invalidEvidence.metrics.inspection.treatment = {
      ...invalidEvidence.metrics.inspection.treatment,
      batchCount: 16,
      indirectDrawCount: 128,
    };
    expect(() => validatePerformanceEvidence(invalidEvidence)).toThrow(
      'performance treatment inspection is not linked to its candidate workload',
    );
  });

  it('fails closed when World-reorder attribution is not renderer-owned', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const withoutRendererAttribution = falsification.map((entry) => {
      if (entry.case !== 'world-reorder') return entry;
      return {
        ...entry,
        evidence: {
          ...entry.evidence,
          attribution: { ...entry.evidence.attribution, status: 'unavailable' },
        },
      };
    }) as unknown as typeof falsification;
    expect(() =>
      validatePerformanceEvidence(
        admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA, withoutRendererAttribution),
      ),
    ).toThrow('world-reorder pass requires renderer-owned same-submit attribution');
  });

  it('fails closed when World-reorder changes a per-World tuple across array order', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const changedWorldFacts = falsification.map((entry) => {
      if (entry.case !== 'world-reorder') return entry;
      const worldAttribution = entry.evidence.worldAttribution;
      if (worldAttribution === undefined) return entry;
      return {
        ...entry,
        evidence: {
          ...entry.evidence,
          worldAttribution: {
            ...worldAttribution,
            treatment: {
              ...worldAttribution.treatment,
              reverse: {
                ...worldAttribution.treatment.reverse,
                visible: 15,
                occluded: 113,
              },
            },
          },
        },
      };
    }) as unknown as typeof falsification;
    expect(() =>
      validatePerformanceEvidence(
        admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA, changedWorldFacts),
      ),
    ).toThrow('world-reorder treatment attribution changed across worlds[] reorder');
  });

  it('fails closed when World-reorder submits use a different build identity', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const changedBuild = falsification.map((entry) => {
      if (entry.case !== 'world-reorder') return entry;
      const attribution = entry.evidence.attribution;
      if (attribution === undefined) return entry;
      return {
        ...entry,
        evidence: {
          ...entry.evidence,
          attribution: {
            ...attribution,
            reverseSubmit: { ...attribution.reverseSubmit, build: 'build-b' },
          },
        },
      };
    }) as unknown as typeof falsification;
    expect(() =>
      validatePerformanceEvidence(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA, changedBuild)),
    ).toThrow('world-reorder pass requires same-identity attribution evidence');
  });

  it('fails closed when World-reorder reports a false stable-view summary', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const falseSummary = falsification.map((entry) => {
      if (entry.case !== 'world-reorder') return entry;
      return {
        ...entry,
        evidence: { ...entry.evidence, sameViewIdentity: false },
      };
    }) as unknown as typeof falsification;
    expect(() =>
      validatePerformanceEvidence(admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA, falseSummary)),
    ).toThrow('world-reorder pass requires same-identity attribution evidence');
  });

  it('requires complete World-reorder identity before declaring the phase pass', async () => {
    const { worldReorderAttributionIsValid } = await import(SCRIPT);
    const worldEntry = falsification.find((entry) => entry.case === 'world-reorder');
    if (
      worldEntry === undefined ||
      worldEntry.evidence === undefined ||
      worldEntry.evidence.attribution === undefined ||
      worldEntry.evidence.forward === undefined ||
      worldEntry.evidence.reverse === undefined ||
      worldEntry.evidence.forwardSlot === undefined ||
      worldEntry.evidence.reverseSlot === undefined ||
      worldEntry.evidence.worlds === undefined ||
      worldEntry.evidence.worldAttribution === undefined
    ) {
      throw new Error('world-reorder fixture is incomplete');
    }
    const worldEvidence = worldEntry.evidence;
    const attribution = worldEntry.evidence.attribution;
    const forward = worldEntry.evidence.forward;
    const reverse = worldEntry.evidence.reverse;
    const validInput = {
      expectedBuild: identity.build,
      forwardSubmit: attribution.forwardSubmit,
      reverseSubmit: attribution.reverseSubmit,
      forwardView: forward.view,
      reverseView: reverse.view,
      forwardSlot: worldEvidence.forwardSlot,
      reverseSlot: worldEvidence.reverseSlot,
      worldIdentities: worldEvidence.worlds,
      worldAttribution: worldEvidence.worldAttribution,
    };
    expect(worldReorderAttributionIsValid(validInput)).toBe(true);
    expect(
      worldReorderAttributionIsValid({ ...validInput, expectedBuild: 'different-build' }),
    ).toBe(false);
    expect(worldReorderAttributionIsValid({ ...validInput, reverseSlot: undefined })).toBe(false);
    expect(worldReorderAttributionIsValid({ ...validInput, reverseView: 'different-view' })).toBe(
      false,
    );
  });

  it('fails closed when occlusion-off-on does not settle to the locked workload', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    const incompleteToggle = falsification.map((entry) => {
      if (entry.case !== 'occlusion-off-on') return entry;
      return {
        ...entry,
        evidence: {
          ...entry.evidence,
          on: { count: { candidates: 128, visible: 15, occluded: 113 } },
          settleFrames: 50,
        },
      };
    });
    expect(() =>
      validatePerformanceEvidence(
        admittingEvidence(GPU_FRAME_SAMPLES_SCHEMA, incompleteToggle),
      ),
    ).toThrow('occlusion-off-on falsification must settle to the locked 16/112 workload');
  });

  it('rejects empty raw samples and incomplete falsification instead of false-green', async () => {
    const { validatePerformanceEvidence, GPU_FRAME_SAMPLES_SCHEMA } = await import(SCRIPT);
    expect(() =>
      validatePerformanceEvidence({
        schema: GPU_FRAME_SAMPLES_SCHEMA,
        identity,
        warmupSubmits: 32,
        retainedSamples: 128,
        metrics: {
          timestampAvailable: true,
          settleSubmits: 16,
          lodCoverage: 0.9,
          submittedInstanceRatio: 0.9,
          geometryWorkReduction: 0.1,
          cpuP50Us: 100,
          cpuP95Us: 120,
          cpuP95Regression: 0,
          gpuMedianImprovement: 0.9,
          gpuP95Regression: 0,
        },
        falsification: [],
        samples: [],
        verdict: 'production-ready',
      }),
    ).toThrow('exactly 128 raw samples');
  });
});
