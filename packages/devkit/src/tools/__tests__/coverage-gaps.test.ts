import {
  createArtifactManifest,
  createCarrierStateMachine,
  createToolRuntime,
  type ToolExecutionContext,
} from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import {
  type BenchmarkRecipe,
  type BenchmarkSample,
  createAdmissionReport,
  summarizeBenchmarkSamples,
} from '../benchmark/report.js';
import { calculateSampleStatistics } from '../benchmark/statistics.js';
import {
  authorPluginCreateDescriptor,
  describeTool,
  listTools,
  loadToolCatalog,
  materializeToolCatalog,
  materializeToolDescriptorCatalog,
  previewOfflineAnalysisDescriptor,
  previewRunDescriptor,
  projectBuildDescriptor,
  rebuildToolCatalog,
  type ToolCatalog,
} from '../catalog.js';
import { runGenericTool, runNamedTool } from '../cli-adapter.js';
import {
  createAuthorContribution,
  createBuildContribution,
  createDefaultContributions,
} from '../contributions.js';
import { runLibraryTool } from '../library.js';
import {
  createCapabilityToken,
  createMigrationRecipe,
  createMigrationRoster,
  resolveMigration,
} from '../migration.js';
import { analyzePreviewArtifacts } from '../offline-analysis.js';
import {
  createOfflineAnalysisContribution,
  createPreviewContributions,
} from '../preview-contributions.js';
import {
  type PreviewCarrierRoute,
  runCarrierPreviewRoute,
  runPreviewHost,
} from '../preview-host.js';
import { createResourceProbe } from '../realms.js';
import { createServiceExecutor } from '../service.js';
import { createAuthenticatedLoopbackService } from '../service-transport.js';

const manifest = createArtifactManifest({
  schemaVersion: '1.0.0',
  identity: {
    runId: 'run',
    snapshotDigest: 'sha256:s',
    stepId: 'preview',
    frameId: 0,
    captureId: 'capture',
  },
  artifacts: [
    { owner: 'rhi', kind: 'rhi-tape', uri: 'file:///tape', digest: 'sha256:t', byteLength: 1 },
    { owner: 'visual', kind: 'png', uri: 'file:///frame', digest: 'sha256:p', byteLength: 1 },
    {
      owner: 'profiler',
      kind: 'profile-capture',
      uri: 'file:///profile',
      digest: 'sha256:c',
      byteLength: 1,
    },
  ],
});

const target = {
  recipe: {
    snapshot: { revision: 1, digest: 'sha256:snapshot' },
    backend: 'webgpu' as const,
    presentation: 'hidden' as const,
    viewport: { width: 4, height: 4 },
    frames: 1,
  },
};

describe('DevKit tool coverage contracts', () => {
  it('covers provider, resource ownership, cache, and realm capability', () => {
    const machine = createCarrierStateMachine({
      projectId: 'p',
      consumerId: 'c',
      endpoint: 'http://127.0.0.1:1',
      now: 0,
      ttlMs: 100,
    });
    const accepted = machine.lease({
      consumerId: 'c',
      bearerToken: machine.offer.bearerToken,
      now: 1,
    });
    const acceptedLeaseId = accepted.ok ? accepted.value.leaseId : undefined;
    expect(accepted).toMatchObject({ ok: true, value: { leaseId: expect.any(String) } });
    if (acceptedLeaseId !== undefined) {
      expect(machine.started(acceptedLeaseId)).toMatchObject({ ok: true });
      expect(machine.exit(acceptedLeaseId)).toMatchObject({ ok: true });
    }
    expect(machine.lease({ consumerId: 'wrong', bearerToken: 'wrong', now: 1 })).toMatchObject({
      ok: false,
    });
    const probe = createResourceProbe();
    probe.observe('page', 'unowned');
    const owner = probe.owner('host');
    owner.observe('process', 'p1');
    owner.observe('port', 'port1');
    owner.release('port', 'port1');
    expect(probe.snapshot()).toMatchObject({ process: ['p1'], port: [], page: ['unowned'] });
    owner.stop();
    expect(probe.snapshot().process).toEqual([]);
    expect(() => probe.owner('host')).not.toThrow();
    expect(() => probe.owner('host')).toThrow('resource-owner-duplicate');
    probe.release('page', 'unowned');
    expect(() => owner.observe('fiber', 'after-stop')).toThrow('resource-owner-stopped');
  });

  it('covers preview contributions, offline analysis, and child composition', async () => {
    const contributions = createPreviewContributions();
    expect(contributions).toHaveLength(2);
    const runtime = createToolRuntime(contributions);
    const preview = contributions[0];
    expect(preview).toBeDefined();
    if (preview === undefined) return;
    const result = await runtime.run(preview, target, {
      evidence: ['rhi-tape', 'png', 'profile-capture'],
    }).terminal;
    expect(result).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed', detail: { code: 'preview-operation-migrated' } },
    });
    const offline = createOfflineAnalysisContribution();
    expect(
      await runtime.run(offline, { manifest, required: ['png'] }, { evidence: [] }).terminal,
    ).toMatchObject({ outcome: 'failed', failure: { code: 'tool-artifact-incomplete' } });
    expect(analyzePreviewArtifacts({ manifest, required: ['missing' as never] })).toMatchObject({
      ok: false,
    });
    expect(runtime.list()).toHaveLength(2);
  });

  it('covers carrier pre-start fallback, lease, started, exit, and ordinary paths', async () => {
    expect(
      await runCarrierPreviewRoute('hidden', undefined, async () => ({
        ok: true as const,
        value: 'hidden',
      })),
    ).toEqual({ ok: true, value: 'hidden' });
    expect(
      await runCarrierPreviewRoute('visible', undefined, async () => ({
        ok: true as const,
        value: 'x',
      })),
    ).toEqual({ ok: true, value: 'x' });
    const offer = {
      projectId: 'project',
      consumerId: 'consumer',
      bearerToken: 'token',
      offerId: 'offer',
      schemaVersion: '1.0.0' as const,
      endpoint: 'http://127.0.0.1:1',
      livenessToken: 'live',
      expiresAt: 10,
      state: 'offered' as const,
    };
    const base: PreviewCarrierRoute = {
      lookup: () => offer,
      now: () => 1,
      lease: () => ({
        ok: false as const,
        error: { code: 'carrier-lease-required', expected: 'lease', hint: 'lease', detail: {} },
      }),
      started: () => ({
        ok: true as const,
        value: { state: 'started' as const, leaseId: 'lease' },
        state: 'started' as const,
      }),
      execute: async () => ({
        ok: false as const,
        error: { code: 'unused', expected: 'unused', hint: 'unused', detail: {} },
      }),
      exit: () => ({
        ok: true as const,
        value: { state: 'exited' as const, leaseId: 'lease' },
        state: 'exited' as const,
      }),
    };
    expect(
      await runCarrierPreviewRoute('visible', { ...base, lookup: () => undefined }, async () => ({
        ok: true as const,
        value: 'x',
      })),
    ).toEqual({ ok: true, value: 'x' });
    expect(
      await runCarrierPreviewRoute('visible', base, async () => ({
        ok: true as const,
        value: 'x',
      })),
    ).toEqual({ ok: true, value: 'x' });
    const startedFail: PreviewCarrierRoute = {
      ...base,
      lease: () => ({ ok: true as const, value: { leaseId: 'lease' }, state: 'leased' as const }),
      started: () => ({
        ok: false as const,
        error: { code: 'carrier-started', expected: 'started', hint: 'started', detail: {} },
      }),
    };
    expect(
      await runCarrierPreviewRoute('visible', startedFail, async () => ({
        ok: true as const,
        value: 'x',
      })),
    ).toEqual({ ok: true, value: 'x' });
    const exitFail: PreviewCarrierRoute = {
      ...base,
      lease: () => ({ ok: true as const, value: { leaseId: 'lease' }, state: 'leased' as const }),
      started: () => ({
        ok: true as const,
        value: { state: 'started' as const, leaseId: 'lease' },
        state: 'started' as const,
      }),
      exit: () => ({
        ok: false as const,
        error: { code: 'carrier-exited', expected: 'exit', hint: 'exit', detail: {} },
      }),
    };
    expect(
      await runCarrierPreviewRoute(
        'visible',
        exitFail,
        async () => ({ ok: true as const, value: 'private' }),
        async () => ({ ok: true as const, value: 'consumer' }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'carrier-exited' } });
  });

  it('covers bootstrap validation, run-command, library, and command parse failures', {
    timeout: 30_000,
  }, async () => {
    const contribution = {
      descriptor: {
        id: 'coverage.tool',
        title: 'Coverage',
        summary: 'Coverage',
        realm: 'build' as const,
        argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        evidence: [],
      },
      execute: async (value: unknown) => value,
    };
    const runtime = createToolRuntime([contribution]);
    expect(await runNamedTool(runtime, 'missing', {})).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-capability-unavailable' },
    });
    const generic = await runGenericTool(runtime, 'coverage.tool', '{"value":true}');
    expect(generic).toMatchObject({ outcome: 'succeeded' });
    expect(await runGenericTool(runtime, 'coverage.tool', 'invalid')).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-invalid-args' },
    });
    expect(await runLibraryTool(contribution, { value: true })).toMatchObject({
      outcome: 'succeeded',
    });
    await expect(runPreviewHost(target, {} as ToolExecutionContext)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      createBuildContribution().execute({ root: '/missing-project' }, {} as ToolExecutionContext),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      createAuthorContribution().execute({ path: '', module: '' }, {} as ToolExecutionContext),
    ).resolves.toMatchObject({ ok: false });
    expect(
      createDefaultContributions().some((tool) => tool.descriptor.id === 'project.migrate'),
    ).toBe(true);
    expect(createBuildContribution().descriptor.id).toBe('project.build');
    expect(createAuthorContribution().descriptor.id).toBe('asset.plugin.create');
  });

  it('covers authenticated service transport and executor fallback/error paths', async () => {
    const service = await createAuthenticatedLoopbackService({
      bearerToken: 'service-token',
      handler: async (request) => ({ outcome: 'succeeded', result: request.args, artifacts: [] }),
      expectedDescriptorDigest: 'descriptor',
      expectedRecipeDigest: 'recipe',
    });
    try {
      const serviceIdentity = {
        descriptorDigest: 'descriptor',
        recipeDigest: 'recipe',
        workloadClass: 'preview.real-project-webgpu',
        codeDigest: 'sha256:code',
        browserVersion: 'Chromium 140',
      };
      const serviceContribution = createOfflineAnalysisContribution();
      const executor = createServiceExecutor({
        contribution: serviceContribution,
        privateExecutor: async () => ({
          outcome: 'succeeded',
          result: { runId: 'private' },
          artifacts: [],
        }),
        transport: service.transport,
        admission: {
          schema: 'forgeax.tool-service-admission-ref.v1',
          reportDigest: `sha256:${'a'.repeat(64)}`,
          toolId: serviceContribution.descriptor.id,
          ...serviceIdentity,
          backend: 'webgpu',
          frameCount: 300,
          samples: { privateCold: 30, privateWarm: 30, serviceCold: 30, serviceWarm: 30 },
          correctness: {
            terminalEquivalent: true,
            artifactIntegrity: true,
            freshReplay: true,
            hiddenParity: true,
            drawCalls: 2,
            nonBlackPixels: 100,
          },
          performance: {
            privateMedianMs: 100,
            privateP95Ms: 120,
            privateMaxMs: 140,
            privateRssBytes: 1000,
            serviceMedianMs: 70,
            serviceP95Ms: 90,
            serviceMaxMs: 145,
            serviceRssBytes: 1100,
          },
          cleanupPassed: true,
          evictionPassed: true,
        },
        ...serviceIdentity,
        bearerToken: 'service-token',
      });
      expect(await executor.run({ manifest })).toMatchObject({ outcome: 'succeeded' });
      expect(await executor.run({ manifest }, { recipeDigest: 'wrong' })).toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-domain-failed' },
      });
      expect(
        (await fetch(service.endpoint.replace('/run', '/wrong'), { method: 'GET' })).status,
      ).toBe(404);
      expect(
        (
          await fetch(service.endpoint, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(service.endpoint, {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { authorization: 'Bearer service-token', 'content-type': 'application/json' },
          })
        ).status,
      ).toBe(400);
      await service.close();
      expect(await executor.run({ manifest })).toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-run-disconnected' },
      });
      const privateExecutor = createServiceExecutor({
        contribution: createOfflineAnalysisContribution(),
        privateExecutor: async () => ({
          outcome: 'succeeded',
          result: { runId: 'private' },
          artifacts: [],
        }),
        transport: service.transport,
        descriptorDigest: 'd',
        recipeDigest: 'r',
        workloadClass: 'preview.real-project-webgpu',
        codeDigest: 'sha256:code',
        browserVersion: 'Chromium 140',
      });
      expect(await privateExecutor.run({ manifest })).toMatchObject({
        outcome: 'succeeded',
        result: { runId: 'private' },
      });
    } finally {
      await service.close();
    }
  });

  it('covers catalog projections and malformed authority inputs', async () => {
    expect(projectBuildDescriptor.argsSchema.parse(null)).toMatchObject({ ok: false });
    expect(projectBuildDescriptor.argsSchema.parse({ sourcemap: 'hidden' })).toMatchObject({
      ok: true,
      value: { sourcemap: 'hidden' },
    });
    expect(projectBuildDescriptor.argsSchema.parse({ sourcemap: true })).toMatchObject({
      ok: false,
    });
    expect(authorPluginCreateDescriptor.argsSchema.parse(null)).toMatchObject({ ok: false });
    expect(previewRunDescriptor.argsSchema.parse({})).toMatchObject({ ok: false });
    expect(previewRunDescriptor.argsSchema.parse({ recipe: 1 })).toMatchObject({ ok: false });
    expect(previewOfflineAnalysisDescriptor.argsSchema.parse(null)).toMatchObject({ ok: false });
    expect(previewOfflineAnalysisDescriptor.argsSchema.parse({ manifest: 1 })).toMatchObject({
      ok: false,
    });
    const descriptor = createBuildContribution().descriptor;
    if (descriptor === undefined) throw new Error('descriptor missing');
    const catalog = materializeToolCatalog([createBuildContribution()], {
      authorityDigest: 'sha256:a',
    });
    const projected = materializeToolDescriptorCatalog([descriptor], {
      authorityDigest: 'sha256:b',
    });
    expect(listTools(catalog)).toHaveLength(1);
    expect(describeTool(catalog, 'missing')).toBeUndefined();
    expect(
      rebuildToolCatalog([createBuildContribution()], catalog, { authorityDigest: 'sha256:a' }),
    ).toEqual(catalog);
    expect(
      rebuildToolCatalog([createBuildContribution()], undefined, { authorityDigest: 'sha256:b' }),
    ).toMatchObject({ authorityDigest: 'sha256:b' });
    expect(projected.entries.some((entry) => entry.id === 'project.build')).toBe(true);
    const noSchemaDescriptor = {
      id: 'coverage.no-schema',
      title: 'No schema',
      summary: 'No schema',
      realm: 'build' as const,
      argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
      resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
      evidence: [],
    };
    expect(
      materializeToolDescriptorCatalog([noSchemaDescriptor], {
        authorityDigest: 'sha256:no-schema',
      }).entries[0],
    ).not.toHaveProperty('argsSchema');
    expect(() => materializeToolCatalog([null], { authorityDigest: 'sha256:a' })).toThrow();
    expect(() => materializeToolCatalog([], {})).toThrow();
    expect(await loadToolCatalog({ authorityDigest: 'sha256:a' })).toMatchObject({ ok: true });
    expect(await loadToolCatalog({})).toMatchObject({
      ok: false,
      error: { code: 'tool-catalog-authority-unreadable' },
    });
    const invalid = await loadToolCatalog({
      read: async () => {
        throw new Error('read failed');
      },
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'tool-catalog-authority-unreadable' },
    });
    const badProjection = await loadToolCatalog({
      authorityDigest: 'sha256:a',
      projectionPath: '/dev/null/catalog.json',
    });
    expect(badProjection).toMatchObject({ ok: true });
    const custom: ToolCatalog = { ...catalog, digest: 'wrong' };
    expect(
      rebuildToolCatalog([createBuildContribution()], custom, { authorityDigest: 'sha256:a' }),
    ).toMatchObject({ digest: expect.stringMatching(/^sha256:/) });
    expect(() => rebuildToolCatalog([], undefined, {})).toThrow();
    const migrationRoster = createMigrationRoster();
    const probe = {
      realm: 'host' as const,
      catalogDigest: 'sha256:c',
      rhiBackend: 'webgpu' as const,
      evidence: ['rhi-tape', 'profile-capture'] as const,
      carrier: false,
      service: true,
    };
    expect(() =>
      createCapabilityToken('preview.run', { ...probe, catalogDigest: '' }, '1.0.0', probe),
    ).toThrow();
    expect(() =>
      createMigrationRecipe({ operation: 'preview.run', args: { world: true } }),
    ).toThrow();
    expect(
      resolveMigration(migrationRoster, 'preview.run', { ...probe, rhiBackend: 'null' }),
    ).toMatchObject({ ok: false });
    expect(
      resolveMigration(migrationRoster, 'preview.run', { ...probe, realm: 'engine' }),
    ).toMatchObject({ ok: false });
    expect(
      resolveMigration(migrationRoster, 'preview.run', { ...probe, evidence: [] }),
    ).toMatchObject({ ok: false });
  });

  it('covers benchmark statistics and admission rejection reasons', () => {
    expect(() => calculateSampleStatistics([])).toThrow();
    expect(calculateSampleStatistics([1, 3])).toMatchObject({ median: 2, p95: 3, max: 3 });
    expect(summarizeBenchmarkSamples([])).toMatchObject({ samples: 0, cleanupPassed: false });
    const recipe: BenchmarkRecipe = {
      snapshotDigest: 's',
      backend: 'webgpu',
      viewport: [1, 1],
      inputDigest: 'i',
      frameCount: 1,
      rhiDebug: true,
      profiler: true,
      carrierRendezvous: false,
      digest: 'recipe',
    };
    const sample = (
      mode: BenchmarkSample['mode'],
      phase: BenchmarkSample['phase'],
      overrides: Partial<BenchmarkSample> = {},
    ): BenchmarkSample => ({
      mode,
      phase,
      durationMs: mode === 'private' ? 100 : 50,
      peakRssBytes: mode === 'private' ? 100 : 90,
      exclusivePhasesMs: { execute: 1, capture: 2 },
      rhiDebugOverheadMs: 1,
      carrierRendezvousMs: 1,
      cleanupPassed: true,
      evictionPassed: true,
      recipeDigest: recipe.digest,
      ...overrides,
    });
    const incomplete = createAdmissionReport(recipe, [sample('private', 'cold')], {
      sampleCountPerPhase: 1,
      medianImprovement: 0.2,
      p95Improvement: 0.1,
      maxRegression: 0.1,
      peakRssMultiplier: 1.25,
    });
    expect(incomplete.valid).toBe(false);
    expect(incomplete.reasons).toContain('sample count is incomplete');
    const rejected = createAdmissionReport(
      recipe,
      [
        sample('private', 'cold', { recipeDigest: 'wrong', cleanupPassed: false }),
        sample('private', 'warm', { evictionPassed: false }),
        sample('service', 'cold', { durationMs: 200, peakRssBytes: 200 }),
        sample('service', 'warm', { durationMs: 200, peakRssBytes: 200 }),
      ],
      {
        sampleCountPerPhase: 1,
        medianImprovement: 0.2,
        p95Improvement: 0.1,
        maxRegression: 0.1,
        peakRssMultiplier: 1.25,
      },
    );
    expect(rejected.reasons).toEqual(
      expect.arrayContaining([
        'recipe identity drifted',
        'cleanup failed',
        'eviction failed',
        'private and service samples were not alternated',
        'median improvement threshold missed',
        'p95 improvement threshold missed',
        'max regression threshold exceeded',
        'peak RSS threshold exceeded',
      ]),
    );
  });
});
