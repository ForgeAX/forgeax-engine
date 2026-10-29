import { expect, it } from 'vitest';
import { WebGpuPipelineLibrary } from '../pipeline-library';
import { verifyPipelineLibraryGpu } from './pipeline-library.fixture';

it('receives raw background WGSL in fresh Workers without runtime fragmentation or hashing', async () => {
  const code = 'fn background() {}\n\n'.repeat(16_000);
  for (let realm = 0; realm < 3; realm++) {
    const worker = new Worker(
      new URL('./fixtures/pipeline-library-source.worker.ts', import.meta.url),
      {
        type: 'module',
      },
    );
    try {
      const result = new Promise<unknown>((resolve, reject) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
      });
      worker.postMessage({
        version: 1,
        backend: 'webgpu',
        shaders: [{ code }, { code, label: 'same source' }],
        bindGroupLayouts: [],
        pipelineLayouts: [],
        renderPipelines: [],
        computePipelines: [],
      });
      expect(await result).toEqual({
        reception: { encodes: 0, copies: 0 },
        repeatedIdentity: true,
        encodes: 1,
        copies: 0,
        shared: true,
        code,
      });
    } finally {
      worker.terminate();
    }
  }
});

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

it('prepares and dispatches projected compute after legal source inputs exceed the former device total', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('WebGPU adapter unavailable');
  const raw = await adapter.requestDevice();
  const library = new WebGpuPipelineLibrary(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const compute =
    '@group(0) @binding(0) var<storage,read_write> value:array<u32>; @compute @workgroup_size(1) fn cs(){value[0]=91u;}';
  const held = library.createShaderModule({ code: `/*${'a'.repeat(30 * 1024 * 1024)}*/` });
  const original = `/*${'b'.repeat(3 * 1024 * 1024)}*/\n${compute}`;
  const storage = raw.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = raw.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const prepared = await library.prepare({
      version: 1,
      backend: 'webgpu',
      shaders: [{ code: original }, { code: compute }],
      bindGroupLayouts: [],
      pipelineLayouts: [],
      renderPipelines: [],
      computePipelines: [{ layout: 'auto', compute: { module: 0, entryPoint: 'cs' } }],
      computeEntryModules: [{ module: 0, entryPoint: 'cs', specializedModule: 1 }],
    });
    expect(prepared.ok).toBe(true);
    const module = library.createShaderModule({ code: original });
    const pipeline = await library.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'cs' },
    });
    expect(library.inspect().asynchronousCreations).toBe(1);
    const encoder = raw.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      raw.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: storage } }],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, 4);
    raw.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    expect(new Uint32Array(readback.getMappedRange())[0]).toBe(91);
    readback.unmap();
    expect(errors).toEqual([]);
    // Keep the earlier runtime object alive through dispatch: this is a
    // cumulative-device regression, not two independent empty devices.
    expect(held).toBeDefined();
  } finally {
    storage.destroy();
    readback.destroy();
    library.dispose();
    raw.destroy();
  }
}, 120_000);
