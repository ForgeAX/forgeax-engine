import { expect, it } from 'vitest';
import { verifyPipelineLibraryGpu } from './pipeline-library.fixture';

it('imports a captured library on a fresh WebGPU device and reuses actual graphics and compute output', async () => {
  const evidence = await verifyPipelineLibraryGpu(navigator.gpu);
  expect(evidence.errors).toEqual([]);
  expect(evidence.sourceInvalidation.synchronousCreations).toBe(1);
});
