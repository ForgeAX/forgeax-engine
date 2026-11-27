import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../device/gpu-residency.ts', import.meta.url), 'utf8');
const iblSource = readFileSync(new URL('../ibl/IblPipelineCache.ts', import.meta.url), 'utf8');

describe('IBL residency publication', () => {
  it('publishes ready and the idempotent cube only after submission succeeds', () => {
    const precomputeCall = source.indexOf('const runResult = await runIblPrecompute({');
    const precomputeSuccess = source.indexOf('if (!runResult.ok)', precomputeCall);
    const sourceReady = source.indexOf("status: 'ready'", precomputeCall);
    const cubeRegistration = source.indexOf('const cubeHandle = sourceHandle;', precomputeCall);
    const mapPublication = source.indexOf(
      'this.cubemapIdempotentMap.set(sourceId, cubeHandle, namespace);',
      precomputeCall,
    );
    expect(precomputeCall).toBeGreaterThan(-1);
    expect(precomputeSuccess).toBeGreaterThan(precomputeCall);
    expect(sourceReady).toBeGreaterThan(precomputeSuccess);
    expect(cubeRegistration).toBeGreaterThan(precomputeSuccess);
    expect(mapPublication).toBeGreaterThan(precomputeSuccess);
  });

  it('keeps pending publication before asynchronous pipeline work', () => {
    const pending = source.indexOf("status: 'pending'");
    const precompute = source.indexOf('const runResult = await runIblPrecompute({');
    expect(pending).toBeGreaterThan(-1);
    expect(pending).toBeLessThan(precompute);
  });

  it('promotes the IBL candidate only after the completion fence', () => {
    const runStart = iblSource.indexOf('export async function runIblPrecompute(');
    const fence = iblSource.indexOf('await device.queue.onSubmittedWorkDone()', runStart);
    const promotion = iblSource.indexOf('const promoted: IblPrecomputeOutput =', runStart);
    const ready = source.indexOf("status: 'ready'", source.indexOf('_uploadCubemapFromEquirect'));
    expect(runStart).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(runStart);
    expect(promotion).toBeGreaterThan(fence);
    expect(ready).toBeGreaterThan(fence);
    expect(iblSource.slice(runStart, fence)).not.toContain('cache.irradianceTexture =');
    expect(iblSource.slice(runStart, fence)).not.toContain('cache.prefilterTexture =');
    expect(iblSource.slice(runStart, fence)).not.toContain('cache.brdfLutTexture =');
  });

  it('awaits precompute before residency publication', () => {
    const call = source.indexOf('const runResult = await runIblPrecompute({');
    const success = source.indexOf('if (!runResult.ok)', call);
    const ready = source.indexOf("status: 'ready'", call);
    const map = source.indexOf(
      'this.cubemapIdempotentMap.set(sourceId, cubeHandle, namespace);',
      call,
    );
    expect(call).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(call);
    expect(ready).toBeGreaterThan(success);
    expect(map).toBeGreaterThan(success);
  });

  it('keeps candidate and transient resources under the DeviceScope owner', () => {
    expect(iblSource).toContain("scope._adopt('texture', texture");
    expect(source).toContain("scope._adopt('texture', equirectGpuTex");
    expect(source).toContain("scope._adopt('buffer', faceBuf");
    expect(source).toContain("scope._adopt('buffer', prefBuf");
    expect(source).toContain("scope._adopt('buffer', cubeVertex");
    const fence = iblSource.indexOf('await device.queue.onSubmittedWorkDone()');
    const candidateWrites = iblSource.indexOf('candidate.prefilterTexture = adoptIblTexture');
    expect(candidateWrites).toBeLessThan(fence);
  });

  it('does not promote or increment counters after a failed stage', () => {
    const runStart = iblSource.indexOf('export async function runIblPrecompute(');
    const promotion = iblSource.indexOf('const promoted: IblPrecomputeOutput =', runStart);
    const counters = iblSource.indexOf('cache.irradianceBakeCount += 1', runStart);
    const stageFailure = iblSource.indexOf('return err(badAlloc', runStart);
    expect(stageFailure).toBeGreaterThan(runStart);
    expect(stageFailure).toBeLessThan(promotion);
    expect(promotion).toBeLessThan(counters);
    expect(iblSource).toContain('stage}-device-scope-generation');
  });

  it('projects SH from the finished source cube before bounded PMREM submissions', () => {
    const runStart = iblSource.indexOf('export async function runIblPrecompute(');
    const cubeSubmitted = iblSource.indexOf(
      "await submitStage('equirect-to-cube', true)",
      runStart,
    );
    const projected = iblSource.indexOf('projection.record(encoder)', cubeSubmitted);
    const prefilterStart = iblSource.indexOf('// (b) PMREM prefilter', projected);
    expect(cubeSubmitted).toBeGreaterThan(runStart);
    expect(projected).toBeGreaterThan(cubeSubmitted);
    expect(prefilterStart).toBeGreaterThan(projected);
    expect(iblSource.slice(prefilterStart)).toContain('await submitStage(`prefilter-level-');
  });
});
