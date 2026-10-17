import { verifyPipelineLibraryGpu } from '../../../rhi-webgpu/src/__tests__/pipeline-library.fixture';
import { createShaderModuleImmediate } from '../../../rhi-webgpu/src/index';
import { PreparedRenderPipelineOwner } from '../assembly/material/prepared-pipeline-owner';
import { RenderFeaturePreparationFailedError } from '../errors/render';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';

/** Actual WebGPU completion plus existing pixel/storage output, not a performance benchmark. */
export async function verifyCompletedPipelineAdmissionGpu(gpu: GPU) {
  return verifyPipelineLibraryGpu(gpu, async (device, render, compute) => {
    const library = device.pipelineLibrary;
    if (library === undefined) throw Error('missing physical-device library');
    const before = library.inspect();
    const owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule: (desc) => createShaderModuleImmediate(device, desc),
      }),
    });
    const descriptor = {
      wgsl: '@group(0) @binding(0) var<storage,read_write> value:array<u32>; @compute @workgroup_size(1) fn cs(){value[0]=73u;}',
      entryPoints: ['cs'],
    };
    try {
      const session = owner.beginFeature('first-born-after-prewarm', 0);
      const computeReady = session.prepareProgram('new-compute', descriptor, true);
      if (!computeReady.ok) throw computeReady.error;
      session.commitFrame();
      const graphics = new PreparedRenderPipelineOwner(device, () => true);
      for (const key of ['first-graphics-owner', 'second-graphics-alias']) {
        const ready = graphics.request(key, 'exact-imported-render-source', render);
        if (!ready.ok) throw ready.error;
      }
      const afterReady = library.inspect();
      if (
        afterReady.asynchronousCreations !== before.asynchronousCreations ||
        afterReady.synchronousCreations !== before.synchronousCreations ||
        afterReady.compilationCompleted !== before.compilationCompleted
      )
        throw Error('completed recipe admission issued new native compilation');

      const missDescriptor = { ...descriptor, wgsl: `${descriptor.wgsl}\n// unprepared recipe` };
      const cold = owner.beginFeature('first-born-after-prewarm', 0);
      const miss = cold.prepareProgram('real-miss', missDescriptor, true);
      if (miss.ok) throw Error('unprepared recipe skipped native completion');
      if (
        !(miss.error instanceof RenderFeaturePreparationFailedError) ||
        !miss.error.detail.reason.includes('pipeline-pending')
      )
        throw miss.error;
      cold.abortFrame().unwrap();
      const module = createShaderModuleImmediate(device, { code: missDescriptor.wgsl }).unwrap();
      const create = device.createComputePipelineAsync;
      if (create === undefined) throw Error('missing native completion');
      (await create.call(device, { ...compute, compute: { module, entryPoint: 'cs' } })).unwrap();
      const completed = owner.beginFeature('first-born-after-prewarm', 0);
      completed.prepareProgram('real-miss', missDescriptor, true).unwrap();
      completed.abortFrame().unwrap();
      const afterMiss = library.inspect();
      if (
        afterMiss.synchronousCreations !== before.synchronousCreations ||
        afterMiss.asynchronousCreations !== before.asynchronousCreations + 1
      )
        throw Error('cache miss used sync fallback or duplicate native compile');
      return {
        computeReady: true,
        graphicsReady: 2,
        before,
        afterReady,
        missReason: miss.error.detail,
        afterMiss,
      };
    } finally {
      owner.dispose().unwrap();
    }
  });
}
