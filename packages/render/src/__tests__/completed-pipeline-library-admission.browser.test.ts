import { expect, it } from 'vitest';
import { verifyCompletedPipelineAdmissionGpu } from './completed-pipeline-library-admission.fixture';

it('admits fresh compute and graphics owners from real completed recipes without an extra frame', async () => {
  const evidence = await verifyCompletedPipelineAdmissionGpu(navigator.gpu);
  expect(evidence.errors).toEqual([]);
  expect(evidence.pixel).toEqual([64, 128, 191, 255]);
  expect(evidence.computed).toBe(73);
  expect(evidence.admission).toMatchObject({ computeReady: true, graphicsReady: 2 });
});
