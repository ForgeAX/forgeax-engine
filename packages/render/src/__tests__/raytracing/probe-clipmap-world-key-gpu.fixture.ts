import { readFile } from 'node:fs/promises';
import type { Buffer } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  createComputeLayout,
  createIrradianceFieldKernel,
  type IrradianceFieldLevelWindow,
  irradianceFieldKernelWgsl,
  packIrradianceFieldUniform,
} from '../../raytracing/irradiance-field';
import {
  IRRADIANCE_FIELD_DEPTH_BYTES,
  IRRADIANCE_FIELD_META_BYTES,
  IRRADIANCE_FIELD_PROBE_BYTES,
  type IrradianceFieldPlan,
} from '../../raytracing/irradiance-field-plan';
import { readBuffer } from './path-tracer.fixture';
import {
  type WorldKeyCache,
  type WorldPoint,
  worldKeyFrame,
  worldKeyIncident,
  worldKeyRays,
} from './probe-clipmap-world-key.fixture';

export interface PlacedWorldKey {
  readonly probe: number;
  readonly updates: number;
  readonly position: WorldPoint;
}
const querySource = `
#import forgeax_ray::irradiance_field_sample::sampleIrradianceField
@group(0) @binding(0) var<storage,read> receivers:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> samples:array<vec4f>;
@compute @workgroup_size(1) fn sampleWorldKey(){samples[0]=sampleIrradianceField(receivers[0].xyz,vec3f(1,0,0),vec3f(0));}`;
export async function createWorldKeyHarness(
  plan: IrradianceFieldPlan,
  transformQueryOwner: (owner: string) => string = (owner) => owner,
) {
  const recorder = attachRecorder(gpu).unwrap(),
    adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap(),
    native = device.nativeDevice().unwrap() as GPUDevice;
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const owned: Buffer[] = [];
  const make = (label: string, data: ArrayBufferView, uniform = false) => {
    const result = device
      .createBuffer({
        label: `clipmap-world-key.${label}`,
        size: data.byteLength,
        usage: (uniform ? 64 : 128) | 12,
      })
      .unwrap();
    owned.push(result);
    device.queue.writeBuffer(result, 0, data).unwrap();
    return result;
  };
  const close = async () => {
    try {
      for (const b of owned) device.destroyBuffer(b).unwrap();
    } finally {
      (await recorder.dispose()).unwrap();
    }
  };
  try {
    const source = irradianceFieldKernelWgsl('global-sdf');
    const resources = {
      irradiance: make(
        'irradiance',
        new Uint8Array(plan.probeCount * IRRADIANCE_FIELD_PROBE_BYTES),
      ),
      moments: make('moments', new Uint8Array(plan.probeCount * IRRADIANCE_FIELD_DEPTH_BYTES)),
      meta: make('meta', new Uint8Array(plan.probeCount * IRRADIANCE_FIELD_META_BYTES)),
      field: make(
        'field',
        packIrradianceFieldUniform(plan, [
          { window: [0, 0, 0], min: [0, 0, 0], max: plan.dimensions },
        ]),
        true,
      ),
      frame: make('frame', worldKeyFrame(plan.probeBudget, 0), true),
      probeList: make('list', new Uint32Array(plan.probeBudget)),
      probeOrigins: make('origins', new Uint8Array(plan.probeBudget * 32)),
      probeRays: make('rays', new Float32Array(plan.probeBudget * worldKeyRays * 8)),
    };
    const kernels: Partial<
      Record<
        'placeProbes' | 'updateProbes' | 'deriveProbes',
        Awaited<ReturnType<Awaited<ReturnType<typeof createIrradianceFieldKernel>>['unwrap']>>
      >
    > = {};
    for (const stage of ['placeProbes', 'updateProbes', 'deriveProbes'] as const) {
      const module = (
        await recorder.backend.createShaderModule(device, { code: source[stage] })
      ).unwrap();
      kernels[stage] = (
        await createIrradianceFieldKernel(device, stage, module, 'global-sdf')
      ).unwrap();
    }
    const run = (
      stages: readonly ('placeProbes' | 'updateProbes' | 'deriveProbes')[],
      count: number,
    ) => {
      const encoder = device
          .createCommandEncoder({ label: 'clipmap-world-key.production' })
          .unwrap(),
        pass = encoder.beginComputePass({});
      for (const stage of stages) {
        const kernel = kernels[stage];
        if (!kernel) throw new Error('Missing production kernel');
        kernel
          .record(
            pass,
            (name) => {
              if (!(name in resources)) throw new Error(`Unknown world-key input ${name}`);
              return { buffer: resources[name as keyof typeof resources] };
            },
            count,
          )
          .unwrap();
      }
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    };
    const directionResults = make(
        'directions',
        new Float32Array(plan.probeBudget * worldKeyRays * 4),
      ),
      auditParameters = make('direction-parameters', new Uint32Array(4), true);
    const directionSource = `${source.traceProbes}
@group(1) @binding(0) var<storage,read> placedAudit:array<ProbeOrigin>;
@group(1) @binding(1) var<storage,read_write> directionAudit:array<vec4f>;
@group(1) @binding(2) var<uniform> auditParameters:vec4u;
@compute @workgroup_size(64) fn auditWorldKeyDirections(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=auditParameters.x*${worldKeyRays}u){return;}
 let origin=placedAudit[gid.x/${worldKeyRays}u];directionAudit[gid.x]=vec4f(probeDirection(origin.probe,origin.updates,gid.x%${worldKeyRays}u,${worldKeyRays}u),1);
}`;
    const empty = createComputeLayout(device, []).unwrap(),
      auditLayout = createComputeLayout(device, [
        [0, 'read'],
        [1, 'storage'],
        [2, 'uniform'],
      ]).unwrap();
    const auditModule = (
      await recorder.backend.createShaderModule(device, { code: directionSource })
    ).unwrap();
    const auditPipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [empty, auditLayout] }).unwrap(),
        compute: { module: auditModule, entryPoint: 'auditWorldKeyDirections' },
      })
      .unwrap();
    const auditGroup = device
      .createBindGroup({
        layout: auditLayout,
        entries: [resources.probeOrigins, directionResults, auditParameters].map(
          (buffer, binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value: { buffer } },
          }),
        ),
      })
      .unwrap();
    const owner = await readFile(
      new URL('../../../../shader/src/ray-irradiance-field-sample.wgsl', import.meta.url),
      'utf8',
    );
    const compiled = (
      await compileShader(querySource, {
        id: 'probe-clipmap-world-key-query',
        imports: { 'forgeax_ray::irradiance_field_sample': transformQueryOwner(owner) },
      })
    ).unwrap();
    const queryInput = make('receiver', new Float32Array(4)),
      queryOutput = make('sample', new Float32Array(4));
    const queryLayout = createComputeLayout(device, [
        [0, 'read'],
        [1, 'storage'],
      ]).unwrap(),
      fieldLayout = createComputeLayout(device, [
        [0, 'uniform'],
        [1, 'read'],
        [2, 'read'],
        [3, 'read'],
      ]).unwrap();
    const queryModule = (
      await recorder.backend.createShaderModule(device, { code: compiled.wgsl })
    ).unwrap();
    const queryPipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [queryLayout, fieldLayout] })
          .unwrap(),
        compute: { module: queryModule, entryPoint: 'sampleWorldKey' },
      })
      .unwrap();
    const queryGroups = [
      device
        .createBindGroup({
          layout: queryLayout,
          entries: [queryInput, queryOutput].map((buffer, binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value: { buffer } },
          })),
        })
        .unwrap(),
      device
        .createBindGroup({
          layout: fieldLayout,
          entries: [resources.field, resources.irradiance, resources.moments, resources.meta].map(
            (buffer, binding) => ({
              binding,
              resource: { kind: 'buffer' as const, value: { buffer } },
            }),
          ),
        })
        .unwrap(),
    ];
    const snapshot = async (): Promise<WorldKeyCache> => ({
      irradiance: new Float32Array(
        (
          await readBuffer(
            device,
            resources.irradiance,
            plan.probeCount * IRRADIANCE_FIELD_PROBE_BYTES,
          )
        ).buffer,
      ),
      moments: new Float32Array(
        (
          await readBuffer(
            device,
            resources.moments,
            plan.probeCount * IRRADIANCE_FIELD_DEPTH_BYTES,
          )
        ).buffer,
      ),
      meta: new Uint32Array(
        (await readBuffer(device, resources.meta, plan.probeCount * IRRADIANCE_FIELD_META_BYTES))
          .buffer,
      ),
    });
    return {
      source,
      querySource: compiled.wgsl,
      adapter: native.adapterInfo,
      errors,
      close,
      snapshot,
      load(cache: WorldKeyCache) {
        for (const name of ['irradiance', 'moments', 'meta'] as const)
          device.queue.writeBuffer(resources[name], 0, cache[name]).unwrap();
      },
      async place(
        entries: Uint32Array,
        windows: readonly IrradianceFieldLevelWindow[],
        frame: number,
      ) {
        const frameBytes = worldKeyFrame(entries.length, frame),
          fieldBytes = packIrradianceFieldUniform(plan, windows);
        device.queue.writeBuffer(resources.probeList, 0, entries).unwrap();
        device.queue.writeBuffer(resources.frame, 0, frameBytes).unwrap();
        device.queue.writeBuffer(resources.field, 0, fieldBytes).unwrap();
        run(['placeProbes'], entries.length);
        const bytes = await readBuffer(device, resources.probeOrigins, entries.length * 32),
          view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const placed: PlacedWorldKey[] = Array.from({ length: entries.length }, (_, i) => ({
          probe: view.getUint32(i * 32 + 12, true),
          updates: view.getUint32(i * 32 + 16, true),
          position: [
            view.getFloat32(i * 32, true),
            view.getFloat32(i * 32 + 4, true),
            view.getFloat32(i * 32 + 8, true),
          ],
        }));
        device.queue
          .writeBuffer(auditParameters, 0, Uint32Array.of(entries.length, 0, 0, 0))
          .unwrap();
        const encoder = device.createCommandEncoder({}).unwrap(),
          pass = encoder.beginComputePass({});
        pass.setPipeline(auditPipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: empty, entries: [] }).unwrap());
        pass.setBindGroup(1, auditGroup);
        pass.dispatchWorkgroups((entries.length * worldKeyRays) / 64);
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const directions = new Float32Array(
          (await readBuffer(device, directionResults, entries.length * worldKeyRays * 16)).buffer,
        );
        return { placed, origins: bytes, directions, frameBytes, fieldBytes };
      },
      async integrate(placed: readonly PlacedWorldKey[], directions: Float32Array) {
        const rays = new Float32Array(placed.length * worldKeyRays * 8);
        for (const [slot, origin] of placed.entries()) {
          const rgb = worldKeyIncident(origin.position);
          for (let r = 0; r < worldKeyRays; r++) {
            const i = slot * worldKeyRays + r;
            rays.set(
              [
                ...rgb,
                2,
                directions[i * 4] ?? Number.NaN,
                directions[i * 4 + 1] ?? Number.NaN,
                directions[i * 4 + 2] ?? Number.NaN,
                1,
              ],
              i * 8,
            );
          }
        }
        device.queue.writeBuffer(resources.probeRays, 0, rays).unwrap();
        run(['updateProbes', 'deriveProbes'], placed.length);
        return { cache: await snapshot(), rays };
      },
      async sample(windows: readonly IrradianceFieldLevelWindow[], receiver: WorldPoint) {
        device.queue
          .writeBuffer(resources.field, 0, packIrradianceFieldUniform(plan, windows))
          .unwrap();
        device.queue.writeBuffer(queryInput, 0, Float32Array.of(...receiver, 0)).unwrap();
        const encoder = device.createCommandEncoder({}).unwrap(),
          pass = encoder.beginComputePass({});
        pass.setPipeline(queryPipeline);
        for (const [index, group] of queryGroups.entries()) pass.setBindGroup(index, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        return new Float32Array((await readBuffer(device, queryOutput, 16)).buffer);
      },
      async capture<T>(work: () => Promise<T>) {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const value = await work();
        (await recorder.frameBoundary()).unwrap();
        return { value, tape: (await pending).unwrap().bytes };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
