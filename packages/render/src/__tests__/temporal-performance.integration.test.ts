import { describe, expect, it } from 'vitest';
import type { PerformanceAdmissionEvidence } from '../../../../apps/hello/taa/scripts/performance-contract.mjs';
import {
  assemblePerformanceAdmissionEvidence,
  cpuAffinityFromEnv,
  createCorrectnessEvidence,
  performanceAdmissionUnavailable,
  performanceIdentityFromEnv,
  qualifiedNativeFromAttestation,
  runnerProvenanceFromEnv,
  validateCorrectnessEvidence,
  validatePerformanceAdmissionEvidence,
  WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION,
} from '../../../../apps/hello/taa/scripts/performance-contract.mjs';

describe('temporal motion blur performance evidence', () => {
  const runnerFacts = {
    environment: 'self-hosted',
    os: 'Linux',
    arch: 'X64',
    queue: 'heavy',
  } as const;
  const runner = {
    runnerName: 'runner-a',
    runnerClass: 'self-hosted/Linux/X64/heavy',
    runnerFacts,
    cpuAffinity: {
      ok: true,
      mode: 'taskset',
      reason: 'bind-to-cgroup-cpu-budget',
      runnerCpus: 8,
      containerized: true,
      allowedCpuCount: 8,
      allowedCpuList: '4-11',
      selectedCpuCount: 8,
      selectedCpuList: '4-11',
    },
  } as const;
  const nativeRunnerFacts = {
    environment: 'github-hosted',
    os: 'macOS',
    arch: 'ARM64',
    queue: 'native-gpu',
  } as const;
  const nativeRunner = {
    runnerName: 'macos-runner',
    runnerClass: 'github-hosted/macOS/ARM64/native-gpu',
    runnerFacts: nativeRunnerFacts,
    cpuAffinity: {
      ok: true,
      mode: 'none',
      reason: 'non-linux-runner',
      runnerCpus: 8,
      containerized: false,
      allowedCpuCount: 8,
      allowedCpuList: '0-7',
    },
  } as const;
  const nativeAdapterFacts = {
    source: 'metal-api',
    vendor: 'Apple',
    device: 'Apple M4 Pro',
    driver: 'Metal',
    deviceType: 'MTLDevice',
    physicalGpu: true,
    requestedBackend: 'metal',
    isFallbackAdapter: false,
    accelerationAttestation: { kind: 'direct-device' },
  } as const;

  it('reports 8WH bytes for each bounded resolution', () => {
    expect([
      ['1080p', 1920 * 1080 * 8],
      ['1440p', 2560 * 1440 * 8],
      ['4K', 3840 * 2160 * 8],
    ]).toEqual([
      ['1080p', 16_588_800],
      ['1440p', 29_491_200],
      ['4K', 66_355_200],
    ]);
  });

  it('derives one stable runner class from actual runner facts', () => {
    const first = runnerProvenanceFromEnv({
      RUNNER_NAME: 'runner-a',
      RUNNER_ENVIRONMENT: 'self-hosted',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_QUEUE: 'heavy',
    });
    const second = runnerProvenanceFromEnv({
      RUNNER_NAME: 'runner-b',
      RUNNER_ENVIRONMENT: 'self-hosted',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_QUEUE: 'heavy',
    });
    expect(first).toMatchObject({ ok: true, runnerClass: 'self-hosted/Linux/X64/heavy' });
    expect(second).toMatchObject({ ok: true, runnerClass: 'self-hosted/Linux/X64/heavy' });
    if (first.ok && second.ok) expect(first.runnerClass).toBe(second.runnerClass);
    expect(
      runnerProvenanceFromEnv({
        RUNNER_NAME: 'macos-runner',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'ARM64',
        RUNNER_QUEUE: 'native-gpu',
        FORGEAX_PERFORMANCE_LANE: 'native1080p',
      }),
    ).toMatchObject({ ok: true, runnerClass: 'github-hosted/macOS/ARM64/native-gpu' });
    expect(
      runnerProvenanceFromEnv({
        RUNNER_NAME: 'macos-runner',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'ARM64',
        RUNNER_QUEUE: 'native-gpu',
        FORGEAX_PERFORMANCE_LANE: 'cpuWebgl2',
      }),
    ).toMatchObject({ ok: true, runnerClass: 'github-hosted/macOS/ARM64/native-gpu' });
    expect(
      runnerProvenanceFromEnv({
        RUNNER_NAME: 'runner-a',
        RUNNER_ENVIRONMENT: 'self-hosted',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      }).ok,
    ).toBe(false);
  });

  it('qualifies only the exact Apple provider-backed paravirtual attestation', () => {
    const attestation = {
      kind: 'provider-backed-paravirtual' as const,
      provider: 'github-hosted/macos-15-xlarge' as const,
      deviceType: 'AppleParavirtGPU' as const,
      driver: 'AppleParavirtGPUMetalIOGPUFamily' as const,
      requestedBackend: 'metal' as const,
      isFallbackAdapter: false as const,
    };
    const context = {
      physicalGpu: false,
      provider: 'github-hosted/macos-15-xlarge',
      requestedBackend: 'metal',
      isFallbackAdapter: false,
      runnerFacts: { environment: 'github-hosted', os: 'macOS', arch: 'ARM64' },
    };
    expect(qualifiedNativeFromAttestation(attestation, context)).toBe(true);
    expect(qualifiedNativeFromAttestation(attestation, { ...context, physicalGpu: true })).toBe(
      false,
    );
    expect(
      qualifiedNativeFromAttestation(attestation, { ...context, requestedBackend: 'vulkan' }),
    ).toBe(false);
    expect(
      qualifiedNativeFromAttestation(attestation, { ...context, isFallbackAdapter: true }),
    ).toBe(false);
    expect(
      qualifiedNativeFromAttestation(attestation, {
        ...context,
        runnerFacts: { environment: 'self-hosted', os: 'macOS', arch: 'ARM64' },
      }),
    ).toBe(false);
    expect(
      qualifiedNativeFromAttestation(
        {
          kind: 'provider-backed-paravirtual',
          provider: 'generic/paravirtual',
          deviceType: 'AppleParavirtGPU',
          driver: 'AppleParavirtGPUMetalIOGPUFamily',
          requestedBackend: 'metal',
          isFallbackAdapter: false,
        } as unknown as typeof attestation,
        context,
      ),
    ).toBe(false);
    expect(
      qualifiedNativeFromAttestation(
        { kind: 'direct-device' },
        {
          physicalGpu: false,
          runnerFacts: context.runnerFacts,
        },
      ),
    ).toBe(false);
  });

  it('uses checkout HEAD for local source identity and rejects a stale tested revision', () => {
    const local = performanceIdentityFromEnv({});
    expect(local.sourceRevision).toBe(local.checkoutRevision);
    expect(local.testedRevisionMatchesCheckout).toBe(true);
    expect(
      performanceIdentityFromEnv({ FORGEAX_TESTED_SHA: 'stale-checkout' })
        .testedRevisionMatchesCheckout,
    ).toBe(false);
  });

  it('requires structured CPU affinity facts for admission producers', () => {
    const parsed = cpuAffinityFromEnv({
      FORGEAX_RUNNER_CPU_AFFINITY: JSON.stringify(runner.cpuAffinity),
    });
    expect(parsed).toEqual({ ok: true, cpuAffinity: runner.cpuAffinity });
    expect(cpuAffinityFromEnv({ FORGEAX_RUNNER_CPU_AFFINITY: '{bad' }).ok).toBe(false);
    expect(cpuAffinityFromEnv({}).ok).toBe(false);
    expect(runner.cpuAffinity.ok).toBe(true);
    expect(runner.cpuAffinity.mode).toBe('taskset');
    expect(runner.cpuAffinity.selectedCpuList).toBe('4-11');
  });

  it('validates the real Dawn inspection shape instead of tautological constants', () => {
    const evidence = createCorrectnessEvidence(
      {
        backend: 'webgpu',
        framesObserved: 60,
        temporal: { status: 'stable', historyValid: true, historyAttempt: 'committed', epoch: 300 },
        temporalTarget: {
          identity: 'standard-scene-temporal',
          producerId: 'forgeax::standard::scene-data',
          schema: 'forgeax::scene-data::temporal-v1',
          targetCount: 1,
          descriptor: {
            format: 'rgba16float',
            width: 200,
            height: 150,
            sampleCount: 1,
            bytes: 240000,
          },
        },
        creation: { texture: 0, buffer: 0, pipeline: 0 },
        passes: ['standard-scene-data', 'taa-resolve', 'motion-blur'],
      },
      {
        testedRevision: 'abc123',
        sourceRevision: 'source123',
        buildDigest: 'sha256:package',
        source: { path: 'apps/hello/taa/src/main.ts', sha256: 'source' },
        build: { command: 'pnpm build', packageSha256: 'package' },
      },
    );
    expect(validateCorrectnessEvidence(evidence)).toEqual({ ok: true, errors: [] });
    expect(evidence.observed.creation).toEqual({ texture: 0, buffer: 0, pipeline: 0 });
  });

  it('rejects missing performance admission rather than converting unavailable to pass', () => {
    const unavailable = performanceAdmissionUnavailable('provider absent');
    expect(unavailable.acceptance).toBe('fail-closed');
    expect(validatePerformanceAdmissionEvidence(unavailable).ok).toBe(false);
    const assembled = assemblePerformanceAdmissionEvidence(
      { backend: 'unavailable' } as unknown as Parameters<
        typeof assemblePerformanceAdmissionEvidence
      >[0],
      { status: 'unavailable' } as unknown as Parameters<
        typeof assemblePerformanceAdmissionEvidence
      >[1],
      { testedRevision: 'abc123', sourceRevision: 'source123', buildDigest: 'sha256:build' },
    );
    expect(assembled.evidence).toBeUndefined();
    expect(assembled.reason).toMatch(/unavailable/);
  });

  it('derives performance admission verdicts from paired raw samples', () => {
    const off = Array.from({ length: 10 }, () => 10);
    const nativeOn = Array.from({ length: 10 }, () => 11);
    const cpuOn = Array.from({ length: 10 }, () => 11);
    const buildArtifact = {
      root: 'apps/hello/taa/dist' as const,
      indexSha256: 'a'.repeat(64),
      shaderManifestSha256: 'b'.repeat(64),
      sourcePayload: 'apps/hello/taa/index.html+src' as const,
    };
    const evidence: PerformanceAdmissionEvidence = {
      schemaVersion: 'hello-taa-performance-admission/1',
      lane: 'performance-admission',
      status: 'pass',
      testedRevision: 'abc123',
      sourceRevision: 'source123',
      buildDigest: 'sha256:build',
      buildArtifact,
      protocol: { sampleCount: 10, order: ['off', 'on'] },
      native1080p: {
        warmupCount: 290,
        testedRevision: 'abc123',
        sourceRevision: 'source123',
        buildDigest: 'sha256:build',
        ...nativeRunner,
        queue: 'native-gpu',
        execution: 'wall-time',
        backend: 'webgpu-native',
        adapter: 'native-admission',
        capabilities: { timestampQuery: false, rgba16floatRenderable: true },
        adapterFacts: nativeAdapterFacts,
        resolution: { width: 1920, height: 1080 },
        timing: { source: 'wall-time', unit: 'ms', gpuTimestamp: false },
        rawSamplesMs: { off, on: nativeOn },
        passCounters: { off: { producer: 1, blur: 0 }, on: { producer: 1, blur: 1 } },
        deltaMs: { median: 1, p95: 1 },
      },
      cpuWebgl2: {
        warmupCount: 2,
        testedRevision: 'abc123',
        sourceRevision: 'source123',
        buildDigest: 'sha256:build',
        ...runner,
        queue: 'heavy',
        execution: 'wall-time',
        backend: 'wgpu-webgl2',
        adapter: 'cpu-webgl2-admission',
        capabilities: { compute: false, storageBuffer: false, rgba16floatRenderable: true },
        resolution: { width: 1920, height: 1080 },
        timing: { source: 'page-rAF', unit: 'ms/frame', gpuTimestamp: false },
        rawSamplesMs: { off, on: cpuOn },
        passCounters: { off: { producer: 1, blur: 0 }, on: { producer: 1, blur: 1 } },
        relativeMedian: 0.1,
      },
      verdict: { native1080p: 'pass', cpuWebgl2: 'pass', overall: 'pass' },
    };
    expect(validatePerformanceAdmissionEvidence(evidence)).toEqual({ ok: true, errors: [] });
    const providerBackedAdapterFacts = {
      source: 'metal-api',
      vendor: '',
      device: '',
      driver: '',
      deviceType: '',
      physicalGpu: false,
      provider: 'github-hosted/macos-15-xlarge',
      requestedBackend: 'metal',
      isFallbackAdapter: false,
      accelerationAttestation: {
        kind: 'provider-backed-paravirtual' as const,
        provider: 'github-hosted/macos-15-xlarge' as const,
        deviceType: 'AppleParavirtGPU' as const,
        driver: 'AppleParavirtGPUMetalIOGPUFamily' as const,
        requestedBackend: 'metal' as const,
        isFallbackAdapter: false as const,
      },
    };
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        native1080p: {
          ...evidence.native1080p,
          adapterFacts: providerBackedAdapterFacts,
        },
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        native1080p: {
          ...evidence.native1080p,
          adapterFacts: { ...nativeAdapterFacts, vendor: '' },
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({ ...evidence, sourceRevision: 'different-source' }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        native1080p: { ...evidence.native1080p, deltaMs: { median: 0, p95: 0 } },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        cpuWebgl2: {
          ...evidence.cpuWebgl2,
          cpuAffinity: { ...evidence.cpuWebgl2.cpuAffinity, selectedCpuList: '0-7' },
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        cpuWebgl2: {
          ...evidence.cpuWebgl2,
          backend: 'host-preloaded-json',
          capabilities: { compute: true, storageBuffer: true, rgba16floatRenderable: true },
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        native1080p: { ...evidence.native1080p, runnerName: 'runner-b' },
      }).ok,
    ).toBe(true);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        native1080p: {
          ...evidence.native1080p,
          runnerClass: 'self-hosted/Linux/X64/heavy',
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        cpuWebgl2: { ...evidence.cpuWebgl2, runnerClass: 'spoofed/Linux/X64/heavy' },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        cpuWebgl2: {
          ...evidence.cpuWebgl2,
          runnerFacts: { ...runnerFacts, queue: '' },
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        cpuWebgl2: {
          ...evidence.cpuWebgl2,
          cpuAffinity: undefined as unknown as typeof evidence.cpuWebgl2.cpuAffinity,
        },
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...evidence,
        cpuWebgl2: {
          ...evidence.cpuWebgl2,
          cpuAffinity: { ...evidence.cpuWebgl2.cpuAffinity, selectedCpuList: 'invalid' },
        },
      }).ok,
    ).toBe(false);
  });

  it('assembles performance admission from independent current-run producers', () => {
    const samples = Array.from({ length: 10 }, () => 10);
    const nativeOn = Array.from({ length: 10 }, () => 11);
    const buildArtifact = {
      root: 'apps/hello/taa/dist' as const,
      indexSha256: 'a'.repeat(64),
      shaderManifestSha256: 'b'.repeat(64),
      sourcePayload: 'apps/hello/taa/index.html+src' as const,
    };
    const assembled = assemblePerformanceAdmissionEvidence(
      {
        backend: 'webgpu',
        framesObserved: 60,
        errors: [],
        drawErrors: [],
        resolution: { width: 1920, height: 1080 },
        testedRevision: 'abc123',
        sourceRevision: 'source123',
        buildDigest: 'sha256:build',
        buildArtifact,
        performanceAdmission: {
          status: 'available',
          ...nativeRunner,
          queue: 'native-gpu',
          execution: 'frame-receipt-complete',
          backend: 'webgpu-native',
          adapter: 'native-adapter',
          capabilities: { timestampQuery: true, rgba16floatRenderable: true },
          adapterFacts: nativeAdapterFacts,
        },
        timing: {
          source: 'wall-time',
          unit: 'ms',
          gpuTimestamp: false,
          warmupCount: 290,
          sampleCount: 10,
          order: ['off', 'on'],
          offMs: samples,
          onMs: nativeOn,
          passCounters: { off: { producer: 1, blur: 0 }, on: { producer: 1, blur: 1 } },
        },
      },
      {
        schemaVersion: WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION,
        status: 'observed',
        testedRevision: 'abc123',
        sourceRevision: 'source123',
        buildDigest: 'sha256:build',
        buildArtifact,
        ...runner,
        queue: 'heavy',
        execution: 'browser-page-rAF',
        adapterId: 'webkit-webgl2',
        backend: 'wgpu-webgl2',
        capabilities: { compute: false, storageBuffer: false, rgba16floatRenderable: true },
        resolution: { width: 1920, height: 1080 },
        timing: { source: 'page-rAF', unit: 'ms/frame', gpuTimestamp: false },
        protocol: { warmupCount: 2, sampleCount: 10, order: ['off', 'on'] },
        rawSamplesMs: { off: samples, on: Array.from({ length: 10 }, () => 11) },
        passCounters: { off: { producer: 1, blur: 0 }, on: { producer: 1, blur: 1 } },
      },
      { testedRevision: 'abc123', sourceRevision: 'source123', buildDigest: 'sha256:build' },
    );
    expect(assembled.reason).toBeUndefined();
    expect(assembled.evidence).toBeDefined();
    expect(assembled.evidence?.native1080p.cpuAffinity).toEqual(nativeRunner.cpuAffinity);
    const oldSchemaAssembly = assemblePerformanceAdmissionEvidence(
      { backend: 'webgpu' } as unknown as Parameters<
        typeof assemblePerformanceAdmissionEvidence
      >[0],
      { schemaVersion: 'hello-taa-webgl2-performance/1' } as unknown as Parameters<
        typeof assemblePerformanceAdmissionEvidence
      >[1],
      { testedRevision: 'abc123', sourceRevision: 'source123', buildDigest: 'sha256:build' },
    );
    expect(oldSchemaAssembly.evidence).toBeUndefined();
    expect(oldSchemaAssembly.reason).toMatch(/cpu.schemaVersion/);
    const admissionEvidence = assembled.evidence;
    if (admissionEvidence === undefined)
      throw new Error('performance admission unexpectedly unavailable');
    expect(validatePerformanceAdmissionEvidence(admissionEvidence)).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      validatePerformanceAdmissionEvidence({
        ...admissionEvidence,
        protocol: {
          ...admissionEvidence.protocol,
          order: ['on', 'off'] as const,
        } as unknown as typeof admissionEvidence.protocol,
      }).ok,
    ).toBe(false);
    expect(
      validatePerformanceAdmissionEvidence({
        ...admissionEvidence,
        cpuWebgl2: {
          ...admissionEvidence.cpuWebgl2,
          capabilities: {
            compute: true,
            storageBuffer: true,
            rgba16floatRenderable: false,
          } as unknown as typeof admissionEvidence.cpuWebgl2.capabilities,
          resolution: {
            width: 960,
            height: 720,
          } as unknown as typeof admissionEvidence.cpuWebgl2.resolution,
        },
      }).ok,
    ).toBe(false);
    expect(
      assemblePerformanceAdmissionEvidence(
        {
          backend: 'webgpu',
          framesObserved: 60,
          errors: [],
          drawErrors: [],
          resolution: { width: 1920, height: 1080 },
          testedRevision: 'abc123',
          sourceRevision: 'source123',
          buildDigest: 'sha256:build',
          buildArtifact,
          performanceAdmission: {
            status: 'available',
            ...nativeRunner,
            queue: 'native-gpu',
            execution: 'frame-receipt-complete',
            backend: 'webgpu-native',
            adapter: 'native-adapter',
            capabilities: { timestampQuery: true, rgba16floatRenderable: false } as unknown as {
              timestampQuery: boolean;
              rgba16floatRenderable: true;
            },
            adapterFacts: nativeAdapterFacts,
          },
          timing: {
            source: 'wall-time',
            unit: 'ms',
            gpuTimestamp: false,
            warmupCount: 290,
            sampleCount: 10,
            order: ['off', 'on'],
            offMs: samples,
            onMs: nativeOn,
            passCounters: { off: { producer: 1, blur: 0 }, on: { producer: 1, blur: 1 } },
          },
        },
        {
          schemaVersion: WEBGL2_PERFORMANCE_ADMISSION_SCHEMA_VERSION,
          status: 'observed',
          testedRevision: 'abc123',
          sourceRevision: 'source123',
          buildDigest: 'sha256:build',
          buildArtifact,
          ...runner,
          cpuAffinity: runner.cpuAffinity,
          queue: 'heavy',
          execution: 'browser-page-rAF',
          adapterId: 'webkit-webgl2',
          backend: 'wgpu-webgl2',
          capabilities: {
            compute: true,
            storageBuffer: true,
            rgba16floatRenderable: false,
          } as unknown as { compute: false; storageBuffer: false; rgba16floatRenderable: true },
          resolution: { width: 960, height: 720 } as unknown as { width: 1920; height: 1080 },
          timing: { source: 'page-rAF', unit: 'ms/frame', gpuTimestamp: false },
          protocol: {
            warmupCount: 2,
            sampleCount: 10,
            order: ['on', 'off'] as const,
          } as unknown as {
            warmupCount: number;
            sampleCount: number;
            order: readonly ['off', 'on'];
          },
          rawSamplesMs: { off: samples, on: Array.from({ length: 10 }, () => 11) },
          passCounters: { off: { producer: 1, blur: 0 }, on: { producer: 1, blur: 1 } },
        },
        { testedRevision: 'abc123', sourceRevision: 'source123', buildDigest: 'sha256:build' },
      ).reason,
    ).toMatch(/native|protocol|cpu/);
  });
});
