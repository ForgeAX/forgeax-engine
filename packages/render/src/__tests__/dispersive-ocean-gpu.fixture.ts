import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '../features/plan';
import { validateRenderFeaturePlan } from '../features/plan';

/** Executes the real declarative compute work on the test project's native GPU. */
export async function dispersiveGpuFixture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dispersive numerical acceptance requires a native GPU');
  const device = await adapter.requestDevice();
  const textures = new Map<
    string,
    { key: string; texture: GPUTexture; width: number; height: number; lanes: number }
  >();
  const pipelines = new Map<string, GPUComputePipeline>();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  return {
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    },
    async run(
      resources: readonly RenderFeatureResourceDeclaration[],
      passes: readonly RenderFeaturePassDeclaration[],
    ) {
      const validateDispersiveNativePlan = () => {
        const targets = resources.flatMap((row) =>
          row.kind === 'graph-texture'
            ? [
                {
                  name: row.name,
                  kind: 'color' as const,
                  format: row.descriptor.format,
                  sampleCount: 1 as const,
                },
              ]
            : [],
        );
        const admission = validateRenderFeaturePlan(
          'dispersive-native-fixture',
          { resources, passes },
          targets,
        );
        if (!admission.ok) {
          const resource = resources.find(
            (_, index) =>
              !validateRenderFeaturePlan(
                'dispersive-native-fixture',
                {
                  resources: resources.slice(0, index + 1),
                  passes: [],
                },
                targets,
              ).ok,
          );
          const pass = passes.find(
            (pass) =>
              !validateRenderFeaturePlan(
                'dispersive-native-fixture',
                { resources, passes: [pass] },
                targets,
              ).ok,
          );
          throw new Error(
            `Invalid native plan: ${resource?.name ?? pass?.name ?? 'duplicate pass'}`,
            { cause: admission.error },
          );
        }
      };
      validateDispersiveNativePlan();
      const buffers = new Map<string, GPUBuffer>();
      const views = new Map<string, GPUTextureView>();
      const programs = new Map<string, GPUComputePipeline>();
      const bindings = new Map<string, GPUBindGroup>();
      try {
        const allocateDispersiveNativeResources = () => {
          for (const row of resources) {
            if (row.kind === 'graph-texture') {
              const old = textures.get(row.name);
              if (old?.key === row.allocationKey) continue;
              old?.texture.destroy();
              const descriptor = row.descriptor;
              const width = descriptor.size.width,
                height = descriptor.size.height ?? 1;
              const texture = device.createTexture({
                format: descriptor.format as GPUTextureFormat,
                size: [width, height, 1],
                usage: descriptor.usage ?? 0,
              });
              textures.set(row.name, {
                key: row.allocationKey ?? row.name,
                texture,
                width,
                height,
                lanes: descriptor.format === 'r32float' ? 1 : 4,
              });
            } else if (row.kind === 'buffer') {
              const buffer = device.createBuffer({
                size: row.size,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              });
              buffers.set(row.name, buffer);
              if (row.data)
                device.queue.writeBuffer(buffer, 0, row.data as GPUAllowSharedBufferSource);
            }
          }
        };
        allocateDispersiveNativeResources();
        for (const row of resources) {
          if (row.kind === 'prepared-gpu-resource' && row.logicalTarget) {
            if (typeof row.logicalTarget !== 'string')
              throw new Error('Numerical fixture requires a named texture target');
            const target = textures.get(row.logicalTarget);
            if (!target) throw new Error(`Missing declared texture ${row.logicalTarget}`);
            views.set(row.name, target.texture.createView());
          } else if (row.kind === 'compute-program') {
            const key = JSON.stringify(row.program);
            let pipeline = pipelines.get(key);
            if (!pipeline) {
              const module = device.createShaderModule({
                code:
                  typeof row.program.wgsl === 'string' ? row.program.wgsl : row.program.wgsl.read(),
              });
              const info = await module.getCompilationInfo();
              const compilationErrors = info.messages.filter((message) => message.type === 'error');
              if (compilationErrors.length)
                throw new Error(
                  `${row.name}: ${compilationErrors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n')}`,
                );
              const entries = row.program.bindings?.[0]?.entries;
              if (!entries)
                throw new Error('A compute program requires its declared binding layout');
              const layout = device.createBindGroupLayout({
                entries: Array.from(entries) as GPUBindGroupLayoutEntry[],
              });
              pipeline = await device.createComputePipelineAsync({
                layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                compute: {
                  module,
                  ...(row.program.entryPoints[0] === undefined
                    ? {}
                    : { entryPoint: row.program.entryPoints[0] }),
                },
              });
              pipelines.set(key, pipeline);
            }
            programs.set(row.name, pipeline);
          }
        }
        const bindDispersiveNativePrograms = () => {
          for (const row of resources)
            if (row.kind === 'compute-bindings') {
              const pipeline = programs.get(row.program);
              if (!pipeline) throw new Error(`Missing declared program ${row.program}`);
              const entries = row.entries.map(({ binding, resource }) => {
                const textureView = views.get(resource);
                const buffer = buffers.get(resource);
                if (!textureView && !buffer)
                  throw new Error(`Missing declared binding ${resource}`);
                return { binding, resource: textureView ?? { buffer: buffer as GPUBuffer } };
              });
              bindings.set(
                row.name,
                device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
              );
            }
        };
        bindDispersiveNativePrograms();
        const submitDispersiveNativePasses = () => {
          const encoder = device.createCommandEncoder();
          for (const row of passes)
            if (row.kind === 'compute' && row.enabled !== false) {
              const pipeline = programs.get(row.program),
                group = bindings.get(row.bindings);
              if (!pipeline || !group) throw new Error(`Missing compiled work ${row.name}`);
              const pass = encoder.beginComputePass({ label: row.name });
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group);
              for (const dispatch of row.dispatches) {
                if (dispatch.kind !== 'direct')
                  throw new Error('Numerical fixture expects direct compute dispatch');
                pass.dispatchWorkgroups(...dispatch.workgroups);
              }
              pass.end();
            }
          device.queue.submit([encoder.finish()]);
        };
        submitDispersiveNativePasses();
        await device.queue.onSubmittedWorkDone();
        if (errors.length) throw new Error(errors.join('\n'));
      } finally {
        for (const buffer of buffers.values()) buffer.destroy();
      }
    },
    async read(name: string): Promise<Float32Array> {
      const target = textures.get(name);
      if (!target) throw new Error(`No produced native target ${name}`);
      const pixelBytes = target.lanes * 4;
      const bytesPerRow = Math.ceil((target.width * pixelBytes) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * target.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target.texture }, { buffer, bytesPerRow }, [
          target.width,
          target.height,
          1,
        ]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(buffer.getMappedRange());
        const packed = new Uint8Array(target.width * target.height * pixelBytes);
        for (let y = 0; y < target.height; y++)
          packed.set(
            bytes.subarray(y * bytesPerRow, y * bytesPerRow + target.width * pixelBytes),
            y * target.width * pixelBytes,
          );
        buffer.unmap();
        return new Float32Array(packed.buffer);
      } finally {
        buffer.destroy();
      }
    },
    write(name: string, values: Float32Array) {
      const target = textures.get(name);
      if (!target) throw new Error(`No allocated native target ${name}`);
      device.queue.writeTexture(
        { texture: target.texture },
        values,
        { bytesPerRow: target.width * target.lanes * 4 },
        [target.width, target.height, 1],
      );
    },
    dispose() {
      for (const target of textures.values()) target.texture.destroy();
      device.destroy();
    },
  };
}
