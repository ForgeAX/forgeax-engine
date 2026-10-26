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
