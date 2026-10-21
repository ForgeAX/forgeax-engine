import type { RenderPipeline } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import type { MaterialSnapshot } from '../../render-system-extract';
import { createDrawObservation } from '../draw-observation';

it('records the encoded material version after the live shared resource advances', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const entry = receiptRow();
  const material: MaterialSnapshot = {
    ...entry.source.material.snapshot,
    materialPublication: {
      identity: {
        materialGuid: 'material',
        publicationGeneration: 1,
        specializationKey: 'set',
        artifactHash: 'set-hash',
      },
      programs: [
        {
          pass: 'forward',
          address: 'direct',
          specializationKey: 'program',
          artifactHash: 'program-hash',
          context: {
            backend: 'webgpu',
            capability: 'storage-buffer',
            pipeline: 'forward',
            geometry: 'mesh',
            pass: 'forward',
            profile: 'forgeax-material-wgsl-v1',
            toolchain: 'naga-oil',
            instrumentation: 'none',
          },
        },
      ],
    },
  };
  entry.source.material.adopt({ ...material, materialPublication: undefined });
  const live = vi.spyOn(entry.source.material, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('observations must use the encoded version');
  });
  try {
    const pipeline = {} as RenderPipeline;
    const reference = { captureGeneration: 3, handleId: 'pipeline' };
    const resolve = vi.fn(() => reference);
    const observation = createDrawObservation({ device, resolvePipelineReference: resolve });
    observation.record(
      entry,
      2,
      { material, pipeline, programKey: 'program', passIndex: 0, lane: 'cpu', ready: true },
      { identity: 'world' },
    );
    expect(observation.commit(true)).toMatchObject({
      status: 'complete',
      draws: [
        {
          submeshIndex: 2,
          publication: material.materialPublication?.identity,
          pipeline: reference,
        },
      ],
    });
    expect(resolve).toHaveBeenCalledWith(device, pipeline);
    expect(live).not.toHaveBeenCalled();
  } finally {
    live.mockRestore();
  }
});
