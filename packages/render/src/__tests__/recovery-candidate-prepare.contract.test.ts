import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const renderSystemSource = readFileSync(
  resolve(import.meta.dirname, '../render-system.ts'),
  'utf8',
);
const recoveryRootsSource = readFileSync(
  resolve(import.meta.dirname, '../recovery/render-system-roots.ts'),
  'utf8',
);
const recoveryCandidateSource = readFileSync(
  resolve(import.meta.dirname, '../recovery/render-system-candidate.ts'),
  'utf8',
);
const rendererSource = readFileSync(
  resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'),
  'utf8',
);
const rendererRecoverySource = readFileSync(
  resolve(import.meta.dirname, '../assembly/recovery/renderer-recover.ts'),
  'utf8',
);
const recoveryPipelineSource = readFileSync(
  resolve(import.meta.dirname, '../record/recovery-pipeline.ts'),
  'utf8',
);

describe('recovery candidate preparation contract', () => {
  it('retires capture state on both device recovery and final disposal', () => {
    for (const method of [
      'disposeFrameState(): void {',
      'resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {',
    ]) {
      const start = renderSystemSource.indexOf(method);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(
        renderSystemSource.slice(start, renderSystemSource.indexOf('\n    },', start)),
      ).toContain('disposeTargetCaptures(cubeCaptureState)');
    }
  });
  it('does not restore the lost device SSR history when publishing a detached candidate', () => {
    const start = recoveryCandidateSource.indexOf('const createRecoveryCandidateFrameState');
    const end = recoveryCandidateSource.indexOf('const publishRecoveryGraphCandidate', start);
    const candidate = recoveryCandidateSource.slice(start, end);
    for (const field of ['ssrHistoryOwner', 'ssrSpatialAdmission', 'ssrTemporalParamsPayload']) {
      expect(candidate).toContain(`${field}: undefined`);
    }
    // Initial readiness and recovery await the same pipeline preparation owner.
    expect(rendererSource).toContain('await renderSystem.initializeSsr(device)');
    expect(rendererSource).not.toContain('initializeSsr(internals.device)');
    expect(rendererRecoverySource).toContain(
      'await buildPipeline(recoveryScope, device, candidateGpuStore)',
    );
    expect(rendererRecoverySource).not.toContain('initializeSsr(');
    expect(renderSystemSource).toContain('format: ssrFormatReceipts.get(internals.device)');
  });

  it('keeps graph preparation outside draw, record, execute, and submit', () => {
    const start = recoveryCandidateSource.indexOf('const prepareRecoveryGraphCandidate');
    const end = recoveryCandidateSource.indexOf('const submitCandidateSetup', start);
    const prepare = recoveryCandidateSource.slice(start, end);

    expect(prepare).toContain('prepareFrameLighting');
    expect(prepare).toContain('ensureCompiledFrameGraph');
    expect(prepare).toContain("kind: 'no-seed'");
    expect(prepare).toContain("kind: 'failed'");
    expect(prepare).toContain("kind: 'ready'");
    expect(prepare).not.toMatch(
      /\.draw\(|recordFrame\(|executeCompiledFrameGraph|queue\.submit|\.finish\(/,
    );
  });

  it('keeps active generation bindings unchanged until publication', () => {
    const start = rendererRecoverySource.indexOf('const candidateInternals =');
    const end = rendererRecoverySource.indexOf('const preparedRecoveryRoots =', start);
    const candidate = rendererRecoverySource.slice(start, end);

    expect(candidate).toContain('prepareRecoveryGraphCandidate');
    expect(candidate).toContain("graphPreparation.kind === 'failed'");
    expect(candidate).toContain("graphPreparation.kind === 'ready'");
    expect(candidate).toContain('submitCandidateSetup');
    expect(candidate).not.toMatch(/internals\.device\s*=/);
    expect(candidate).not.toMatch(/internals\.generationState\.current\s*=/);
    expect(candidate).not.toContain('renderSystem.resetForRecover');
    expect(candidate).not.toContain('featureHost?.recover');
    expect(candidate).not.toContain('renderTargetHost.beginFrame');
    expect(rendererRecoverySource.indexOf('submitCandidateSetup', start)).toBeLessThan(
      rendererRecoverySource.indexOf('const preparedRecoveryRoots', start),
    );
    expect(rendererRecoverySource).toContain('recoveryRootBundle');
    expect(rendererSource).toContain('publishAndRetireRendererGeneration');
  });

  it('prepares roots from candidate state and switches environment owner only at publish', () => {
    const start = recoveryRootsSource.indexOf('export function prepareRenderSystemRecoveryRoots');
    const roots = recoveryRootsSource.slice(start);

    expect(roots).toContain('runtime.scope');
    expect(roots).toContain('createRecoveryCandidate');
    expect(roots).toContain('candidateEnvironmentGeneration');
    expect(roots).toContain('candidateEnvironmentLifecycle.publish');
    expect(roots).toContain('candidateEnvironmentLifecycle.discard');
    expect(roots).toContain('graphCandidate.featureHost.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.featureGpuWork.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.gpuDrivenProduction.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.gpuDrivenScene.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.pointsLines.createRecoveryRoot');
    expect(roots).toContain('runtime.gpuStore.createRecoveryRoot');
    expect(roots).toContain('return compiledGraph');
    expect(roots).not.toContain('environmentLifecycle.createRecoveryRoot');
    expect(roots).not.toContain('featureCount');
    expect(roots).not.toContain("owner: 'gpu-driven-production'");
    expect(rendererSource).toContain('recoveryRootBundle.publish()');
    expect(rendererRecoverySource).toContain('rootBundle.discard()');
    expect(roots).toContain('cleanup: releaseGraphCandidate');
  });

  it('submits only explicit mip setup work without creating frame evidence', () => {
    const start = recoveryCandidateSource.indexOf('const submitCandidateSetup');
    const end = recoveryCandidateSource.indexOf('\n  return {', start);
    const setup = recoveryCandidateSource.slice(start, end);

    expect(setup).toContain('work.finish()');
    expect(setup).toContain('candidate.device.queue.submit');
    expect(setup).toContain('candidate.device.queue.onSubmittedWorkDone');
    expect(setup.match(/candidate\.device\.queue\.submit/g)).toHaveLength(1);
    expect(setup).not.toContain('submittedFrameCount');
    expect(setup).not.toContain('directFrameId');
    expect(setup).not.toContain('frameState');
    expect(setup).not.toContain('recordFrame');
  });

  it('checks the candidate cache before publication', () => {
    expect(recoveryCandidateSource).toContain('candidate.recoveryReadiness.assertPreparedCache()');
    expect(recoveryCandidateSource).toContain('pointsLinesOwner.prepareRecoveryCandidate');
    expect(renderSystemSource).toContain('pointsLinesOwner.abandonForDeviceLoss');
    expect(recoveryCandidateSource).toContain('const previousFeatureHost = internals.featureHost');
    expect(recoveryCandidateSource).toContain('const disposed = previousFeatureHost.dispose()');
    expect(recoveryCandidateSource).toContain('previousFeatureHost !== candidate.featureHost');
  });

  it('keeps material pipelines scoped to the active recovery generation', () => {
    expect(rendererSource).toContain('currentPipelineCacheState().materialShaderPipelineCache');
    expect(rendererSource).not.toMatch(/\n\s*materialShaderPipelineCache\.(get|set|has)\(/);
  });

  it('forks the validated shader catalog onto a recovery device', () => {
    expect(rendererSource).toContain('activeCatalog.forkForDevice(getShaderModuleAdapter())');
    expect(rendererSource).toContain('state === candidateShaderState && activeCatalog !== null');
  });

  it('resolves recovery variants from the candidate device capabilities', () => {
    const start = rendererSource.indexOf('const resolveCachedMaterialShaderVariantSet');
    const end = rendererSource.indexOf('\n  };', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const resolver = rendererSource.slice(start, end);

    expect(resolver).toContain('const device = currentBuildDevice()');
    expect(resolver).not.toContain('internals.device.caps');
    expect(resolver).not.toContain('internals.device.limits');
  });

  it('rehydrates capability variants before copying late-installed material declarations', () => {
    const preparation = rendererRecoverySource.indexOf('await prepareMaterialShaders(');
    const copy = rendererRecoverySource.indexOf(
      'const activeShaderCatalog = getActiveShaderState().shaderInstance',
    );
    expect(preparation).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(preparation);
    const copyBlock = rendererRecoverySource.slice(copy);
    expect(copyBlock).toContain('candidateShaderCatalog.findMaterialArtifact(identifier).ok');
    expect(copyBlock).toContain('candidateShaderCatalog.installMaterialArtifact(identifier');
  });

  it('rehydrates Surface dynamic page bytes before candidate GPU preparation', () => {
    const start = recoveryCandidateSource.indexOf('let recoverySurfaceDynamicInput =');
    const end = recoveryCandidateSource.indexOf(
      'if (candidateGpuDrivenScene.state !== undefined)',
      start,
    );
    const surface = recoveryCandidateSource.slice(start, end);
    expect(surface).toContain('candidateSurfacePage.bytes.set(source.page.bytes)');
    expect(surface.indexOf('candidateSurfacePage.bytes.set(source.page.bytes)')).toBeLessThan(
      surface.indexOf('recoverySurfaceDynamicInput = {'),
    );
  });

  it('keeps render-system residency bindings live across publication', () => {
    const start = rendererSource.indexOf('const renderInternals: RenderSystemInternals = {');
    const end = rendererSource.indexOf('errorRegistry: internals.errorRegistry', start);
    const assembly = rendererSource.slice(start, end);

    expect(assembly).toContain('get gpuStore()');
    expect(assembly).toContain('get dynamicTextureStore()');
    expect(assembly).not.toMatch(/\n\s*gpuStore,\n/);
    expect(assembly).not.toMatch(/\n\s*dynamicTextureStore,\n/);
  });

  it('rebuilds candidate shaders from accepted receipts with candidate-bound adapters', () => {
    expect(rendererRecoverySource).toContain('entry.value.receipt === undefined');
    expect(rendererRecoverySource).toContain('{ receipt: entry.value.receipt }');
    expect(rendererRecoverySource).toContain(
      'getShaderModuleAdapter().createShaderModule(descriptor)',
    );
    expect(rendererRecoverySource).toContain(
      'getImmediateShaderModuleAdapter().createShaderModule(descriptor)',
    );
    expect(renderSystemSource).toContain('materialArtifacts: frameState.recoveryMaterialArtifacts');
    expect(recoveryCandidateSource).toContain('materialArtifacts.size === 0');
    expect(recoveryCandidateSource).toContain('{ materialArtifacts }');
    expect(recoveryCandidateSource).toContain('domain: range.domain');
    expect(recoveryCandidateSource).not.toContain('recovery-water-domain');
  });

  it('prepares the submitted forward specialization with the direct Surface ABI', () => {
    expect(recoveryPipelineSource).toContain('readonly dispatch: readonly DispatchEntry[]');
    expect(recoveryPipelineSource).toContain(
      "candidate.tags.LightMode !== 'Forward' || candidate.materialShaderId === undefined",
    );
    expect(recoveryPipelineSource).toContain('forwardProgram?.materialShaderId');
    expect(recoveryPipelineSource).toContain("'surface-direct-cluster-pbr' as const");
    expect(recoveryPipelineSource).toContain("'surface-direct-pbr' as const");
    expect(recoveryPipelineSource).toContain("'immediate',");
  });

  it('retires the candidate display view before publishing its prepared owners', () => {
    const start = recoveryCandidateSource.indexOf('const publishRecoveryGraphCandidate');
    const publish = recoveryCandidateSource.slice(start);
    const retire = publish.indexOf('candidateDisplayGraph?.retire()');
    const publication = publish.indexOf('Object.assign(frameState, candidate.frameState)');

    expect(retire).toBeGreaterThanOrEqual(0);
    expect(publication).toBeGreaterThan(retire);
    expect(publish).toContain('candidate.frameState.compiledFrameGraph = null');
  });
});
