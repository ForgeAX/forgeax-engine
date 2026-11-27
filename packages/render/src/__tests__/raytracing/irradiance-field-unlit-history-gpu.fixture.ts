import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import {
  createComputeLayout,
  createIrradianceFieldKernel,
  IRRADIANCE_FIELD_DERIVE_WGSL,
  IRRADIANCE_FIELD_FAR_RADIANCE,
  IRRADIANCE_FIELD_ORIGIN_BYTES,
  IRRADIANCE_FIELD_UPDATE_WGSL,
  irradianceFieldKernelWgsl,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import {
  IRRADIANCE_FIELD_DEPTH_BYTES,
  IRRADIANCE_FIELD_META_BYTES,
  IRRADIANCE_FIELD_PROBE_BYTES,
} from '../../raytracing/irradiance-field-plan';
import {
  emptyHistory,
  type HistorySnapshot,
  historyFrame,
  historyOrdinals,
  historyProbeCount,
  historyProbeIds,
  historyRays,
} from './irradiance-field-unlit-history.fixture';
import { readBuffer } from './path-tracer.fixture';

const directionSource = `${irradianceFieldKernelWgsl('global-sdf').traceProbes}
@group(1) @binding(0) var<storage,read> directionInputs: array<vec4u>;
@group(1) @binding(1) var<storage,read_write> directionResults: array<vec4f>;
@compute @workgroup_size(64) fn auditHistoryDirections(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&directionInputs)){return;}
 let p=directionInputs[gid.x];
 directionResults[gid.x]=vec4f(probeDirection(p.x,p.y,p.z,p.w),1.0);
}`;

async function readHistory(
  device: RhiDevice,
  buffers: Record<keyof HistorySnapshot, Buffer>,
): Promise<HistorySnapshot> {
  const irradiance = await readBuffer(
    device,
    buffers.irradiance,
    historyProbeCount * IRRADIANCE_FIELD_PROBE_BYTES,
  );
  const moments = await readBuffer(
    device,
    buffers.moments,
    historyProbeCount * IRRADIANCE_FIELD_DEPTH_BYTES,
  );
  const meta = await readBuffer(
    device,
    buffers.meta,
    historyProbeCount * IRRADIANCE_FIELD_META_BYTES,
  );
  return {
    irradiance: new Float32Array(irradiance.buffer),
    moments: new Float32Array(moments.buffer),
    meta: new Uint32Array(meta.buffer),
  };
}

export async function createHistoryHarness(
  updateSource = IRRADIANCE_FIELD_UPDATE_WGSL,
  farRadiance = false,
) {
  const recorder = attachRecorder(gpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap() as GPUDevice;
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: Buffer[] = [];
  const close = async () => {
    try {
      for (const value of owned) device.destroyBuffer(value).unwrap();
    } finally {
      (await recorder.dispose()).unwrap();
    }
  };
  const make = (label: string, data: ArrayBufferView, uniform = false) => {
    const value = device
      .createBuffer({ label, size: data.byteLength, usage: (uniform ? 64 : 128) | 12 })
      .unwrap();
    owned.push(value);
    device.queue.writeBuffer(value, 0, data).unwrap();
    return value;
  };
  try {
    const initial = emptyHistory();
    const state = {
      irradiance: make('unlit-history.irradiance', initial.irradiance),
      moments: make('unlit-history.moments', initial.moments),
      meta: make('unlit-history.meta', initial.meta),
    };
    const fieldUniform = packIrradianceFieldUniform(
      { origin: [0, 0, 0], spacing: 4, dimensions: [8, 1, 1], probeCount: 8, levels: 1 },
      [{ window: [0, 0, 0], min: [0, 0, 0], max: [8, 1, 1] }],
      farRadiance,
    );
    if (farRadiance) new Uint32Array(fieldUniform.buffer)[15] = IRRADIANCE_FIELD_FAR_RADIANCE;
    const resources = {
      ...state,
      probeRays: make(
        'unlit-history.probe-rays',
        new Float32Array(historyProbeIds.length * historyRays * 8),
      ),
      frame: make('unlit-history.frame', historyFrame(0), true),
      probeList: make('unlit-history.probe-list', Uint32Array.from(historyProbeIds)),
      probeOrigins: make(
        'unlit-history.probe-origins',
        new Uint8Array(historyProbeIds.length * IRRADIANCE_FIELD_ORIGIN_BYTES),
      ),
      field: make('unlit-history.field', fieldUniform, true),
    };
    const placementModule = (
      await recorder.backend.createShaderModule(device, {
        code: irradianceFieldKernelWgsl('global-sdf').placeProbes,
      })
    ).unwrap();
    const placement = (
      await createIrradianceFieldKernel(device, 'placeProbes', placementModule, 'global-sdf')
    ).unwrap();
    const kernels: Awaited<
      ReturnType<Awaited<ReturnType<typeof createIrradianceFieldKernel>>['unwrap']>
    >[] = [];
    for (const [stage, code] of [
      ['updateProbes', updateSource],
      ['deriveProbes', IRRADIANCE_FIELD_DERIVE_WGSL],
    ] as const) {
      const module = (await recorder.backend.createShaderModule(device, { code })).unwrap();
      kernels.push(
        (await createIrradianceFieldKernel(device, stage, module, 'global-sdf')).unwrap(),
      );
    }
    const resource = (name: string) => {
      if (!(name in resources)) throw new Error(`Unexpected producer resource ${name}`);
      return { buffer: resources[name as keyof typeof resources] };
    };
    return {
      adapter: native.adapterInfo,
      errors,
      async directions(updates = 1) {
        if (!Number.isSafeInteger(updates) || updates < 1 || updates > 256)
          throw new Error('Direction window requires 1..256 accepted-update ordinals');
        const parameters = Uint32Array.from(
          Array.from({ length: updates }, (_, update) =>
            historyProbeIds.flatMap((probe, index) =>
              Array.from({ length: historyRays }, (_, ray) => [
                probe,
                (historyOrdinals[index] ?? 0) + update,
                ray,
                historyRays,
              ]).flat(),
            ),
          ).flat(),
        );
        const input = make('unlit-history.direction-inputs', parameters);
        const output = make('unlit-history.direction-results', new Float32Array(parameters.length));
        const empty = createComputeLayout(device, []).unwrap();
        const layout = createComputeLayout(device, [
          [0, 'read'],
          [1, 'storage'],
        ]).unwrap();
        const module = (
          await recorder.backend.createShaderModule(device, { code: directionSource })
        ).unwrap();
        const pipeline = device
          .createComputePipeline({
            label: 'unlit-history.production-directions',
            layout: device.createPipelineLayout({ bindGroupLayouts: [empty, layout] }).unwrap(),
            compute: { module, entryPoint: 'auditHistoryDirections' },
          })
          .unwrap();
        const group = device
          .createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { kind: 'buffer', value: { buffer: input } } },
              { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
            ],
          })
          .unwrap();
        const encoder = device
          .createCommandEncoder({ label: 'unlit-history.direction-audit' })
          .unwrap();
        const pass = encoder.beginComputePass({});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: empty, entries: [] }).unwrap());
        pass.setBindGroup(1, group);
        pass.dispatchWorkgroups(parameters.length / 4 / 64);
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        return new Float32Array((await readBuffer(device, output, parameters.byteLength)).buffer);
      },
      load(snapshot: HistorySnapshot) {
        for (const name of ['irradiance', 'moments', 'meta'] as const)
          device.queue.writeBuffer(state[name], 0, snapshot[name]).unwrap();
      },
      async place() {
        device.queue.writeBuffer(resources.frame, 0, historyFrame(0)).unwrap();
        const encoder = device.createCommandEncoder({ label: 'unlit-history.place' }).unwrap();
        const pass = encoder.beginComputePass({});
        placement.record(pass, resource, historyProbeIds.length).unwrap();
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        return readBuffer(
          device,
          resources.probeOrigins,
          historyProbeIds.length * IRRADIANCE_FIELD_ORIGIN_BYTES,
        );
      },
      async step(rays: Float32Array, hysteresis: number, fresh = false, frameIndex = 0) {
        device.queue.writeBuffer(resources.probeRays, 0, rays).unwrap();
        device.queue.writeBuffer(resources.frame, 0, historyFrame(hysteresis, frameIndex)).unwrap();
        device.queue
          .writeBuffer(
            resources.probeList,
            0,
            Uint32Array.from(historyProbeIds, (id) => (id | (fresh ? 0x80000000 : 0)) >>> 0),
          )
          .unwrap();
        const encoder = device
          .createCommandEncoder({ label: 'unlit-history.production-update-derive' })
          .unwrap();
        const pass = encoder.beginComputePass({});
        for (const kernel of kernels)
          kernel.record(pass, resource, historyProbeIds.length).unwrap();
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        return readHistory(device, state);
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
