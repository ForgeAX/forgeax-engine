import type { Buffer } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import {
  createComputeLayout,
  createIrradianceFieldKernel,
  irradianceFieldKernelWgsl,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import {
  IRRADIANCE_FIELD_DEPTH_BYTES,
  IRRADIANCE_FIELD_META_BYTES,
  IRRADIANCE_FIELD_PROBE_BYTES,
} from '../../raytracing/irradiance-field-plan';
import {
  type Point,
  relocationFrame,
  relocationPlan,
  relocationProbe,
  relocationRays,
} from './irradiance-field-relocation-scale.fixture';
import { readBuffer } from './path-tracer.fixture';

const directionSource = `${irradianceFieldKernelWgsl('global-sdf').traceProbes}
@group(1) @binding(0) var<storage,read_write> relocationDirections:array<vec4f>;
@compute @workgroup_size(64) fn auditRelocationDirections(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x<${relocationRays}u){relocationDirections[gid.x]=vec4f(probeDirection(${relocationProbe}u,0u,gid.x,${relocationRays}u),1);}
}`;
export interface RelocationSnapshot {
  readonly irradiance: Float32Array;
  readonly moments: Float32Array;
  readonly meta: Uint32Array;
  readonly origins: Uint8Array;
  readonly point: Point;
}
export async function createRelocationHarness() {
  const recorder = attachRecorder(gpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap() as GPUDevice;
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: Buffer[] = [];
  const make = (name: string, data: ArrayBufferView, uniform = false) => {
    const value = device
      .createBuffer({
        label: `relocation-scale.${name}`,
        size: data.byteLength,
        usage: (uniform ? 64 : 128) | 12,
      })
      .unwrap();
    owned.push(value);
    device.queue.writeBuffer(value, 0, data).unwrap();
    return value;
  };
  const close = async () => {
    try {
      for (const value of owned) device.destroyBuffer(value).unwrap();
    } finally {
      (await recorder.dispose()).unwrap();
    }
  };
  try {
    const resources = {
      irradiance: make('irradiance', new Float32Array((64 * IRRADIANCE_FIELD_PROBE_BYTES) / 4)),
      moments: make('moments', new Float32Array((64 * IRRADIANCE_FIELD_DEPTH_BYTES) / 4)),
      meta: make('meta', new Uint32Array((64 * IRRADIANCE_FIELD_META_BYTES) / 4)),
      probeOrigins: make('origins', new Uint8Array(32)),
      probeRays: make('rays', new Float32Array(relocationRays * 8)),
      probeList: make('list', Uint32Array.of(relocationProbe)),
      frame: make('frame', relocationFrame(1, 0), true),
      field: make(
        'field',
        packIrradianceFieldUniform(relocationPlan(1), [
          { window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] },
        ]),
        true,
      ),
    };
    const source = irradianceFieldKernelWgsl('global-sdf');
    const kernels: Partial<
      Record<
        'updateProbes' | 'deriveProbes' | 'placeProbes',
        Awaited<ReturnType<Awaited<ReturnType<typeof createIrradianceFieldKernel>>['unwrap']>>
      >
    > = {};
    for (const stage of ['updateProbes', 'deriveProbes', 'placeProbes'] as const) {
      const module = (
        await recorder.backend.createShaderModule(device, { code: source[stage] })
      ).unwrap();
      kernels[stage] = (
        await createIrradianceFieldKernel(device, stage, module, 'global-sdf')
      ).unwrap();
    }
    const run = (stages: readonly ('updateProbes' | 'deriveProbes' | 'placeProbes')[]) => {
      const encoder = device
        .createCommandEncoder({ label: 'relocation-scale.production-stages' })
        .unwrap();
      const pass = encoder.beginComputePass({});
      for (const stage of stages) {
        const kernel = kernels[stage];
        if (!kernel) throw new Error('Missing production kernel');
        kernel
          .record(
            pass,
            (name) => {
              if (!(name in resources)) throw new Error(`Unexpected resource ${name}`);
              return { buffer: resources[name as keyof typeof resources] };
            },
            1,
          )
          .unwrap();
      }
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    };
    const snapshot = async (): Promise<RelocationSnapshot> => {
      const bytes = async (name: 'irradiance' | 'moments' | 'meta', size: number) =>
        readBuffer(device, resources[name], size);
      const origins = await readBuffer(device, resources.probeOrigins, 32);
      const p = new Float32Array(origins.buffer);
      return {
        irradiance: new Float32Array(
          (await bytes('irradiance', 64 * IRRADIANCE_FIELD_PROBE_BYTES)).buffer,
        ),
        moments: new Float32Array(
          (await bytes('moments', 64 * IRRADIANCE_FIELD_DEPTH_BYTES)).buffer,
        ),
        meta: new Uint32Array((await bytes('meta', 64 * IRRADIANCE_FIELD_META_BYTES)).buffer),
        origins,
        point: [p[0] ?? Number.NaN, p[1] ?? Number.NaN, p[2] ?? Number.NaN],
      };
    };
    return {
      adapter: native.adapterInfo,
      errors,
      source,
      async directions() {
        const output = make('direction-results', new Float32Array(relocationRays * 4));
        const empty = createComputeLayout(device, []).unwrap(),
          layout = createComputeLayout(device, [[0, 'storage']]).unwrap();
        const module = (
          await recorder.backend.createShaderModule(device, { code: directionSource })
        ).unwrap();
        const pipeline = device
          .createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [empty, layout] }).unwrap(),
            compute: { module, entryPoint: 'auditRelocationDirections' },
          })
          .unwrap();
        const group = device
          .createBindGroup({
            layout,
            entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
          })
          .unwrap();
        const encoder = device.createCommandEncoder({}).unwrap(),
          pass = encoder.beginComputePass({});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: empty, entries: [] }).unwrap());
        pass.setBindGroup(1, group);
        pass.dispatchWorkgroups(relocationRays / 64);
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        return new Float32Array((await readBuffer(device, output, relocationRays * 16)).buffer);
      },
      async reset(scale: number) {
        for (const [name, length] of [
          ['irradiance', 64 * IRRADIANCE_FIELD_PROBE_BYTES],
          ['moments', 64 * IRRADIANCE_FIELD_DEPTH_BYTES],
          ['meta', 64 * IRRADIANCE_FIELD_META_BYTES],
        ] as const)
          device.queue.writeBuffer(resources[name], 0, new Uint8Array(length)).unwrap();
        device.queue
          .writeBuffer(
            resources.field,
            0,
            packIrradianceFieldUniform(relocationPlan(scale), [
              { window: [0, 0, 0], min: [0, 0, 0], max: [4, 4, 4] },
            ]),
          )
          .unwrap();
        device.queue.writeBuffer(resources.frame, 0, relocationFrame(scale, 0)).unwrap();
        run(['placeProbes']);
        return snapshot();
      },
      async step(rays: Float32Array, scale: number, frame: number) {
        device.queue.writeBuffer(resources.probeRays, 0, rays).unwrap();
        device.queue.writeBuffer(resources.frame, 0, relocationFrame(scale, frame)).unwrap();
        run(['updateProbes', 'deriveProbes', 'placeProbes']);
        return snapshot();
      },
      async capture<T>(work: () => Promise<T>) {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const value = await work();
        (await recorder.frameBoundary()).unwrap();
        return { value, tape: (await pending).unwrap().bytes };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
