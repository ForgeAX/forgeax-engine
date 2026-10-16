import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { createRenderFeatureGpuWorkOwner } from '../src/features/prepared-gpu-work';

export const modes = ['small', 'stable', 'resize', 'abort', 'replace'] as const;
export type Mode = (typeof modes)[number];

export async function createCase(mode: Mode) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const descriptor = {
    wgsl: '@group(0) @binding(0) var<storage, read_write> values: array<u32>; @compute @workgroup_size(1) fn main() { values[0] = 1u; }',
    entryPoints: ['main'],
    bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
  };
  const shader = (await rhi.createShaderModule(device, { code: descriptor.wgsl })).unwrap();
  const counters = { creates: 0, destroys: 0, bindings: 0, writes: 0, commits: 0, aborts: 0 };
  const createBuffer = device.createBuffer.bind(device);
  const destroyBuffer = device.destroyBuffer.bind(device);
  const createBindGroup = device.createBindGroup.bind(device);
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  device.createBuffer = (input) => {
    counters.creates++;
    return createBuffer(input);
  };
  device.destroyBuffer = (input) => {
    counters.destroys++;
    return destroyBuffer(input);
  };
  device.createBindGroup = (input) => {
    counters.bindings++;
    return createBindGroup(input);
  };
  device.queue.writeBuffer = (...args) => {
    counters.writes++;
    return writeBuffer(...args);
  };
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('forgeax.vfx-render.gpu-particles', 0);
  const count = mode === 'small' ? 1 : 256;
  const program = session.prepareProgram('program', descriptor).unwrap();
  for (let index = 0; index < count; index++) {
    const buffer = session
      .prepareBuffer(`buffer-${index}`, { size: 64, usage: ['storage'] })
      .unwrap();
    session
      .prepareBindings(`binding-${index}`, {
        program,
        entries: [{ binding: 0, buffer }],
      })
      .unwrap();
  }
  let iteration = 0;
  const release = () => {
    for (const lease of session.commitFrame()) lease.release().unwrap();
    counters.commits++;
  };
  release();
  return {
    run(iterations: number): number {
      let checksum = 0;
      for (let step = 0; step < iterations; step++, iteration++) {
        session.beginFrame();
        if (mode === 'resize' || mode === 'replace') {
          const changed = mode === 'resize' ? 1 : count;
          for (let index = 0; index < changed; index++) {
            const buffer = session
              .prepareBuffer(`buffer-${index}`, {
                size: iteration % 2 === 0 ? 128 : 64,
                usage: ['storage'],
              })
              .unwrap();
            session
              .prepareBindings(`binding-${index}`, {
                program,
                entries: [{ binding: 0, buffer }],
              })
              .unwrap();
            checksum += session.resolveBuffer(buffer)?.size ?? 0;
          }
        }
        session.retainResources(() => true);
        if (mode === 'abort') {
          const temporary = session
            .prepareBuffer('temporary', { size: 64, usage: ['storage'] })
            .unwrap();
          session.abortFrame().unwrap();
          if (session.resolveBuffer(temporary) !== undefined) throw Error('Aborted ref survived');
          counters.aborts++;
        } else release();
        checksum += count;
      }
      return checksum;
    },
    inspect: () => ({ ...counters }),
    dispose: () => owner.dispose().unwrap(),
  };
}
