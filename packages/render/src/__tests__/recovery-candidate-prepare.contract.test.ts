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
const rendererSource = readFileSync(
  resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'),
  'utf8',
);
const rendererRecoverySource = readFileSync(
  resolve(import.meta.dirname, '../assembly/recovery/renderer-recover.ts'),
  'utf8',
);

describe('recovery generation contract', () => {
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
  it('drops the lost device SSR history and builds SSR with the replacement pipeline', () => {
    const start = renderSystemSource.indexOf(
      'resetForRecover(retiringPipelineState?: PipelineState, replacementDevice?: RhiDevice): void {',
    );
    const reset = renderSystemSource.slice(start, renderSystemSource.indexOf('\n    },', start));
    for (const field of ['ssrHistoryOwner', 'ssrSpatialAdmission']) {
      expect(reset).toContain(`frameState.${field} = undefined`);
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

  it('prepares roots from candidate state and switches environment owner only at publish', () => {
    const start = recoveryRootsSource.indexOf('export function prepareRenderSystemRecoveryRoots');
    const roots = recoveryRootsSource.slice(start);

    expect(roots).toContain('runtime.scope');
    expect(roots).toContain('createRecoveryCandidate');
    expect(roots).toContain('candidateEnvironmentGeneration');
    expect(roots).toContain('candidateEnvironmentLifecycle.publish');
    expect(roots).toContain('candidateEnvironmentLifecycle.discard');
    expect(roots).not.toContain('environmentLifecycle.createRecoveryRoot');
    expect(rendererSource).toContain('recoveryRootBundle.publish()');
    expect(rendererRecoverySource).toContain('rootBundle?.discard()');
  });

  // Recovery = clear derived state + rebuild through the ordinary frame path;
  // no frame is replayed from a retained last-submitted seed.
  it('prepares no frame graph from a retained submitted frame before publication', () => {
    for (const source of [renderSystemSource, rendererRecoverySource, rendererSource]) {
      expect(source).not.toMatch(/FrameSeed|RecoveryGraphCandidate|submitCandidateSetup/);
    }
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

  it('keeps render-system residency bindings live across publication', () => {
    const start = rendererSource.indexOf('const renderInternals: RenderSystemInternals = {');
    const end = rendererSource.indexOf('errorRegistry: internals.errorRegistry', start);
    const assembly = rendererSource.slice(start, end);

    expect(assembly).toContain('get gpuStore()');
    expect(assembly).toContain('get dynamicTextureStore()');
    expect(assembly).not.toMatch(/\n\s*gpuStore,\n/);
    expect(assembly).not.toMatch(/\n\s*dynamicTextureStore,\n/);
  });

  it('rebuilds candidate shaders from accepted receipts', () => {
    expect(rendererRecoverySource).toContain('entry.value.receipt === undefined');
    expect(rendererRecoverySource).toContain('{ receipt: entry.value.receipt }');
  });
});
