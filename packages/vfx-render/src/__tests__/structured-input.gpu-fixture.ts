import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import {
  createVfxStructuredInputBank,
  ParticleEffectPlayer,
  particleEffectContribution,
  vfxGpuRuntimePlugin,
  vfxParticleCoreField,
  vfxPlayerParameters,
} from '@forgeax/engine-vfx';
import { expect } from 'vitest';
import type { RenderFeatureWorkPlan } from '../../../render/src/features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBindingsRef,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuProgramRef,
} from '../../../render/src/features/prepared-gpu-work';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import {
  createStructuredInputProvider,
  createVfxDataInterfaceRegistry,
} from '../host/data-interface-providers';

type Resource = RenderFeatureWorkPlan['resources'][number];
type Pass = RenderFeatureWorkPlan['passes'][number];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing structured GPU resource');
  return value;
}
class NativeCompute {
  readonly owner;
  session;
  readonly programs = new Map<string, RenderFeatureGpuProgramRef>();
  readonly buffers = new Map<string, RenderFeatureGpuBufferRef>();
  readonly bindings = new Map<string, RenderFeatureGpuBindingsRef>();
  constructor(readonly device: RhiDevice) {
    this.owner = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
      }),
    });
    this.session = this.owner.beginFeature('structured-native-test', 0);
  }
  begin() {
    this.session = this.owner.beginFeature('structured-native-test', 0);
    this.programs.clear();
    this.buffers.clear();
    this.bindings.clear();
  }
  prepare(resources: readonly Resource[]) {
    for (const resource of resources) {
      if (resource.kind === 'compute-program') {
        expect(resource.program.entryPoints).toHaveLength(1);
        const count =
          resource.program.bindings
            ?.flatMap((group) => group.entries)
            .filter(
              (row) => row.buffer?.type === 'storage' || row.buffer?.type === 'read-only-storage',
            ).length ?? 0;
        expect(count).toBeLessThanOrEqual(8);
        this.programs.set(
          resource.name,
          this.session.prepareProgram(resource.name, resource.program).unwrap(),
        );
      }
      if (resource.kind === 'buffer')
        this.buffers.set(
          resource.name,
          this.session
            .prepareBuffer(resource.name, {
              ...resource,
              usage: [...new Set([...resource.usage, 'copy-src' as const])],
            })
            .unwrap(),
        );
    }
    for (const resource of resources)
      if (resource.kind === 'compute-bindings')
        this.bindings.set(
          resource.name,
          this.session
            .prepareBindings(resource.name, {
              program: required(this.programs.get(resource.program)),
              entries: resource.entries.map((entry) => ({
                binding: entry.binding,
                buffer: required(this.buffers.get(entry.resource)),
                ...(entry.offset === undefined ? {} : { offset: entry.offset }),
                ...(entry.size === undefined ? {} : { size: entry.size }),
              })),
            })
            .unwrap(),
        );
  }
}
export async function verifyStructuredInputGpu(effect: ParticleEffectAsset): Promise<void> {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap();
  native.pushErrorScope('validation');
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });
  const bank = createVfxStructuredInputBank({ recordStrideBytes: 273 * 16, capacity: 4 }).unwrap();
  const fill = (bias: number) => {
    for (let station = 0; station < 4; station++) {
      const record = Float32Array.from(
        { length: 273 * 4 },
        (_, word) => bias + station + 1 + (word % 13),
      );
      record[0] = bias + station + 1;
      record[65 * 4] = bias + station + 10;
      record[272 * 4] = bias + station + 100;
      bank.write(station, new Uint8Array(record.buffer)).unwrap();
    }
  };
  const handle = assets.create(effect).unwrap();
  for (let station = 0; station < 4; station++)
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, parameters: vfxPlayerParameters({ stationIndex: station }) },
      })
      .unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const registry = createVfxDataInterfaceRegistry([
    createStructuredInputProvider({ snapshot: () => bank.snapshot() }),
  ]);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
  const feature = gpuParticleRenderFeature({
    camera: { read: () => camera },
    dataInterfaces: registry,
  });
  let frameNumber = 0;
  const gpu = new NativeCompute(device);
  try {
    for (const bias of [0, 200]) {
      fill(bias);
      const snapshot = required(bank.snapshot());
      const checksums = [0, 1, 2, 3].map((station) =>
        new Float32Array(snapshot.buffer, snapshot.byteOffset + station * 273 * 16, 273 * 4).reduce(
          (sum, value) => sum + value,
          0,
        ),
      );
      world.update(1 / 60).unwrap();
      const source = feature
        .extract({ world, frameNumber: ++frameNumber, views: [{ identity: 'main', render: true }] })
        .unwrap();
      const frame = { frameNumber } as never;
      const plan = feature
        .plan(structuredClone(source), {
          generation: 0,
          frame,
          caps: device.caps,
          views: [{ identity: 'main', render: true, frame, targets: [], sceneData: {} as never }],
          resolveAsset: (handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
        })
        .unwrap();
      const work = required(plan.work.find((work) => work.scope === 'frame'));
      expect(
        work.resources.some(
          (resource) =>
            resource.kind === 'buffer' &&
            resource.size === 17472 &&
            resource.data instanceof Uint8Array,
        ),
      ).toBe(true);
      if (frameNumber > 1) gpu.begin();
      {
        gpu.prepare(work.resources);
        const encoder = device.createCommandEncoder().unwrap();
        encodePasses(gpu, work.passes, encoder);
        const particles = [...gpu.buffers].filter(([name]) => name.endsWith('.particles'));
        expect(particles).toHaveLength(4);
        const readbacks = particles.map(([, reference]) => {
          const buffer = required(gpu.session.resolveBuffer(reference));
          const readback = device.createBuffer({ size: buffer.size, usage: 1 | 8 }).unwrap();
          encoder.copyBufferToBuffer(buffer.buffer, 0, readback, 0, buffer.size);
          return readback;
        });
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const values: number[][] = [];
        for (const buffer of readbacks) {
          const mapped = (await buffer.mapAsync(1)).unwrap();
          const data = new DataView(mapped.getMappedRange().unwrap());
          values.push([
            ...['position', 'velocity', 'color'].map((name) =>
              data.getFloat32(
                vfxParticleCoreField(name as 'position' | 'velocity' | 'color').offset,
                true,
              ),
            ),
            data.getFloat32(vfxParticleCoreField('color').offset + 12, true),
          ]);
          mapped.unmap();
          device.destroyBuffer(buffer).unwrap();
        }
        values.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
        expect(values).toEqual(
          [0, 1, 2, 3].map((station) => [
            bias + station + 1,
            bias + station + 10,
            bias + station + 100,
            checksums[station],
          ]),
        );
        feature.onFrameSubmitted?.(source, {
          works: [
            {
              scope: 'frame',
              passes: work.passes
                .filter((pass) => pass.enabled !== false)
                .map((pass) => ({ name: pass.name })),
            },
          ],
        });
        feature.onSourceFrameSubmitted?.(source, plan.sourceFeedback);
        for (const lease of gpu.session.commitFrame()) lease.release().unwrap();
      }
    }
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    gpu.owner.dispose().unwrap();
    bank.dispose();
    await ctx.fiber.dispose();
    assets.dispose();
    native.destroy();
  }
}

function encodePasses(
  gpu: NativeCompute,
  passes: readonly Pass[],
  encoder: RhiCommandEncoder,
): void {
  for (const pass of passes) {
    if (pass.enabled === false) continue;
    if (pass.kind === 'copy')
      for (const copy of pass.copies) {
        if (copy.enabled === false) continue;
        const source = required(gpu.session.resolveBuffer(required(gpu.buffers.get(copy.source))));
        const target = required(
          gpu.session.resolveBuffer(required(gpu.buffers.get(copy.destination))),
        );
        encoder.copyBufferToBuffer(
          source.buffer,
          copy.sourceOffset ?? 0,
          target.buffer,
          copy.destinationOffset ?? 0,
          copy.size,
        );
      }
    else if (pass.kind === 'compute') encodeCompute(gpu, pass, encoder);
  }
}
function encodeCompute(
  gpu: NativeCompute,
  pass: Extract<Pass, { kind: 'compute' }>,
  encoder: RhiCommandEncoder,
): void {
  const resolved = gpu.session
    .resolveComputePass('structured-native-test', {
      program: required(gpu.programs.get(pass.program)),
      bindings: required(gpu.bindings.get(pass.bindings)),
      dispatches: pass.dispatches.map((dispatch) => {
        if (dispatch.kind !== 'direct') throw new Error('Unexpected structured indirect dispatch');
        return {
          entryPoint: dispatch.entryPoint,
          workgroups: dispatch.workgroups,
          ...(dispatch.bindings === undefined
            ? {}
            : { bindings: required(gpu.bindings.get(dispatch.bindings)) }),
        };
      }),
    })
    .unwrap();
  const compute = encoder.beginComputePass();
  for (const dispatch of resolved.dispatches) {
    if (!('workgroups' in dispatch)) throw new Error('Unexpected structured indirect command');
    compute.setPipeline(dispatch.pipeline);
    compute.setBindGroup(0, dispatch.bindGroup);
    compute.dispatchWorkgroups(...dispatch.workgroups);
  }
  compute.end();
}
