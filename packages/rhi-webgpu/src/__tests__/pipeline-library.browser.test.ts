import { expect, it } from 'vitest';
import { WebGpuPipelineLibrary } from '../pipeline-library';
import { verifyPipelineLibraryGpu } from './pipeline-library.fixture';

it('imports a captured library on a fresh WebGPU device and reuses actual graphics and compute output', async () => {
  const evidence = await verifyPipelineLibraryGpu(navigator.gpu);
  expect(evidence.errors).toEqual([]);
  expect(evidence.sourceInvalidation.synchronousCreations).toBe(1);
});

it('exposes a cloneable native compilation recipe before GPU creation settles', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU adapter unavailable');
  const raw = await adapter.requestDevice();
  const library = new WebGpuPipelineLibrary(raw);
  try {
    const module = library.createShaderModule({
      label: 'inspection-compute',
      code: '@compute @workgroup_size(1) fn cs() {}',
    });
    const pending = library.createComputePipelineAsync({
      label: 'inspection-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'cs' },
    });
    const inspection = structuredClone(library.inspect());
    expect(inspection.pending).toMatchObject({
      unidentified: 0,
      pipelines: [
        {
          kind: 'compute',
          origin: 'runtime',
          preload: 'absent',
          stage: 'queued',
          identity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          recipe: { label: 'inspection-pipeline', layout: 'auto', compute: { entryPoint: 'cs' } },
          shaders: [
            {
              label: 'inspection-compute',
              sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            },
          ],
        },
      ],
    });
    await pending;
    expect(library.inspect().pending).toEqual({ unidentified: 0, pipelines: [] });
  } finally {
    library.dispose();
    raw.destroy();
  }
});

it('preserves a real completed native request before the first history inspection', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU adapter unavailable');
  const raw = await adapter.requestDevice(),
    library = new WebGpuPipelineLibrary(raw);
  try {
    const module = library.createShaderModule({
      label: 'late-inspection-shader',
      code: '@compute @workgroup_size(1) fn cs() {}',
    });
    const descriptor = {
      label: 'late-inspection',
      layout: 'auto' as const,
      compute: { module, entryPoint: 'cs' },
    };
    const native = library.createComputePipelineAsync(descriptor);
    const early = library.inspect({ runtimeRequests: true });
    expect(early.pending).toBeUndefined();
    expect(early.runtimeRequests?.requests[0]?.pipeline?.shaders[0]?.sourceDigest).toBeNull();
    await native;
    expect(library.inspect().runtimeRequests).toBeUndefined();
    const snapshot = structuredClone(library.inspect({ runtimeRequests: true }));
    expect(snapshot.pending).toBeUndefined();
    expect(snapshot.runtimeRequests?.requests).toMatchObject([
      {
        sequence: 1,
        outcome: 'completed',
        mode: 'async',
        pipeline: {
          localIdentity: 1,
          identity: null,
          kind: 'compute',
          preload: 'absent',
        },
      },
    ]);
    for (let i = 0; i < 1000; i++) library.createComputePipelineAsync(descriptor);
    expect(library.inspect({ runtimeRequests: true }).runtimeRequests?.latestSequence).toBe(1);
  } finally {
    library.dispose();
    raw.destroy();
  }
});
