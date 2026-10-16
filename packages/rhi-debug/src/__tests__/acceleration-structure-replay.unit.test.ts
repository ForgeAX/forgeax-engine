import {
  BLAS_INPUT_BUFFER_USAGE,
  type Blas,
  type RhiDevice,
  type RhiInstance,
  type Tlas,
} from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { openReplay } from '../index';
import { decodeTape, encodeTape } from '../protocol/codec';
import type { Tape } from '../protocol/types';
import { type DebugRhiInstance, wrap, wrapCreateShaderModule } from '../recorder';
import { assembleTape } from '../recorder/assemble';

const RAY_QUERY = {
  maxBlasGeometryCount: 4,
  maxBlasPrimitiveCount: 4096,
  maxTlasInstanceCount: 64,
  maxAccelerationStructuresPerShaderStage: 1,
} as const;
const COPY_DST = 0x08;
const COMPUTE = 0x04;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const SHADER = '@compute @workgroup_size(1) fn main() {}';

function rayQueryInstance(): RhiInstance {
  return { ...rhi, requestAdapter: async () => ok(new RhiNullAdapter({ rayQuery: RAY_QUERY })) };
}

async function replayDevice(rayQuery: boolean): Promise<RhiDevice> {
  return (
    await (rayQuery
      ? new RhiNullAdapter({ rayQuery: RAY_QUERY })
      : (await rhi.requestAdapter()).unwrap()
    ).requestDevice()
  ).unwrap();
}

interface Scene {
  readonly recorder: DebugRhiInstance;
  readonly device: RhiDevice;
  readonly blas: Blas;
  readonly tlas: Tlas;
  build(instanceCount: number): void;
  dispatch(): void;
}

async function scene(): Promise<Scene> {
  const recorder = wrap(rayQueryInstance());
  const device = (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
  const vertices = device
    .createBuffer({ label: 'blas-vertices', size: 36, usage: BLAS_INPUT_BUFFER_USAGE | COPY_DST })
    .unwrap();
  device.queue.writeBuffer(vertices, 0, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const indices = device
    .createBuffer({ label: 'blas-indices', size: 12, usage: BLAS_INPUT_BUFFER_USAGE | COPY_DST })
    .unwrap();
  device.queue.writeBuffer(indices, 0, new Uint32Array([0, 1, 2]));
  const blas = device
    .createBlas({
      label: 'triangle',
      geometries: [
        { vertexFormat: 'float32x3', vertexCount: 3, index: { format: 'uint32', count: 3 } },
      ],
    })
    .unwrap();
  const tlas = device.createTlas({ label: 'scene-tlas', maxInstances: 4 }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: COMPUTE, accelerationStructure: {} }],
    })
    .unwrap();
  const module = (
    await wrapCreateShaderModule(createShaderModule, recorder)(device, { code: SHADER })
  ).unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module, entryPoint: 'main' },
    })
    .unwrap();
  const build = (instanceCount: number): void => {
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder
      .buildAccelerationStructures(
        [
          {
            blas,
            geometries: [{ vertexBuffer: vertices, vertexStride: 12, index: { buffer: indices } }],
          },
        ],
        [
          {
            tlas,
            instances: Array.from({ length: instanceCount }, (_, customIndex) => ({
              blas,
              transform: IDENTITY,
              customIndex,
              mask: 0xff,
            })),
          },
        ],
      )
      .unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  const dispatch = (): void => {
    const bindGroup = device
      .createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'accelerationStructure', value: tlas } }],
      })
      .unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginComputePass({});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  return { recorder, device, blas, tlas, build, dispatch };
}

function capture(recorder: DebugRhiInstance, frame: () => void): Tape {
  recorder.arm(1).unwrap();
  frame();
  recorder.onFrameEnd();
  const tape = decodeTape(assembleTape(recorder).unwrap().bytes).unwrap();
  return decodeTape(encodeTape(tape).unwrap()).unwrap();
}

async function inspectedAccelerationStructure(tape: Tape) {
  const device = await replayDevice(true);
  const created: string[] = [];
  const createBlas = device.createBlas.bind(device);
  const createTlas = device.createTlas.bind(device);
  device.createBlas = (desc) => {
    created.push(`blas:${desc.label ?? ''}`);
    return createBlas(desc);
  };
  device.createTlas = (desc) => {
    created.push(`tlas:${desc.label ?? ''}`);
    return createTlas(desc);
  };
  const replay = (await openReplay(tape, { device, createShaderModule })).unwrap();
  try {
    const work = (await replay.inspectWork(0, ['bindings'])).unwrap();
    const binding = work.bindings?.find((entry) => entry.resourceKind === 'accelerationStructure');
    return { created, accelerationStructure: binding?.accelerationStructure };
  } finally {
    (await replay.dispose()).unwrap();
  }
}

describe('acceleration-structure capture and replay', () => {
  it('records an in-frame build and replays it before the dispatch that binds the TLAS', async () => {
    const s = await scene();
    const tape = capture(s.recorder, () => {
      s.build(2);
      s.dispatch();
    });
    const kinds = tape.events.map((event) => event.kind);
    expect(kinds.indexOf('createBindGroup')).toBeGreaterThan(
      kinds.indexOf('buildAccelerationStructures'),
    );
    const bootstrapKinds = tape.bootstrap.map((resource) => resource.kind);
    expect(bootstrapKinds.filter((kind) => kind === 'acceleration-structure')).toHaveLength(2);

    const inspected = await inspectedAccelerationStructure(tape);
    expect(inspected.created).toEqual(['blas:triangle', 'tlas:scene-tlas']);
    const blasId = tape.bootstrap.find(
      (resource) => resource.create.kind === 'createBlas',
    )?.handleId;
    expect(inspected.accelerationStructure).toEqual({
      tlasHandleId: expect.any(String),
      label: 'scene-tlas',
      status: 'built',
      instanceCount: 2,
      blasHandleIds: [blasId],
    });
  });

  it('rebuilds a TLAS built before the capture from its bootstrap build state', async () => {
    const s = await scene();
    s.build(3);
    const tape = capture(s.recorder, () => s.dispatch());
    expect(tape.events.some((event) => event.kind === 'buildAccelerationStructures')).toBe(false);
    const inspected = await inspectedAccelerationStructure(tape);
    expect(inspected.created).toEqual(['blas:triangle', 'tlas:scene-tlas']);
    expect(inspected.accelerationStructure).toMatchObject({ status: 'built', instanceCount: 3 });
  });

  it('settles every bootstrap rebuild before the frame traverses the structure', async () => {
    // Metal (wgpu-hal) places no acceleration-structure barrier and references a
    // BLAS from TLAS instances indirectly, so an unsettled rebuild can race the
    // first traversal and return all-miss; the live frame built frames earlier.
    const s = await scene();
    s.build(2);
    const tape = capture(s.recorder, () => s.dispatch());
    const device = await replayDevice(true);
    const order: string[] = [];
    const createCommandEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (desc) => {
      order.push(`encode:${desc?.label ?? ''}`);
      return createCommandEncoder(desc);
    };
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (buffers) => {
      order.push('submit');
      return submit(buffers);
    };
    const settle = device.queue.onSubmittedWorkDone.bind(device.queue);
    device.queue.onSubmittedWorkDone = () => {
      order.push('settled');
      return settle();
    };
    const replay = (await openReplay(tape, { device, createShaderModule })).unwrap();
    try {
      (await replay.inspectWork(0, ['bindings'])).unwrap();
    } finally {
      (await replay.dispose()).unwrap();
    }
    const rebuild = ['encode:rhi-debug:bootstrap-as-build', 'submit', 'settled'];
    const first = order.indexOf(rebuild[0] as string);
    expect(order.slice(first, first + 6)).toEqual([...rebuild, ...rebuild]);
  });

  it('carries an in-frame build into the bootstrap state of the next capture only', async () => {
    const s = await scene();
    s.build(1);
    const first = capture(s.recorder, () => {
      s.build(4);
      s.dispatch();
    });
    const firstTlas = first.bootstrap.find((resource) => resource.create.kind === 'createTlas');
    expect(firstTlas?.create).toMatchObject({ build: { instances: [expect.anything()] } });

    const second = capture(s.recorder, () => s.dispatch());
    const inspected = await inspectedAccelerationStructure(second);
    expect(inspected.accelerationStructure).toMatchObject({ status: 'built', instanceCount: 4 });
  });

  it('reports an unbuilt TLAS in the frame model when no build precedes the binding', async () => {
    const s = await scene();
    const tape = capture(s.recorder, () => {
      s.build(1);
      s.dispatch();
    });
    const tlasId = tape.bootstrap.find((resource) => resource.create.kind === 'createTlas')
      ?.handleId as string;
    const withoutBuild: Tape = {
      ...tape,
      events: tape.events.filter((event) => event.kind !== 'buildAccelerationStructures'),
    };
    const binding = buildFrameModel(withoutBuild).works[0]?.bindings.find(
      (entry) => entry.resourceId === tlasId,
    );
    expect(binding?.accelerationStructure).toEqual({
      tlasHandleId: tlasId,
      label: 'scene-tlas',
      status: 'unbuilt',
      instanceCount: 0,
      blasHandleIds: [],
    });
  });

  it('refuses a replay device without ray query with a structured capability mismatch', async () => {
    const s = await scene();
    const tape = capture(s.recorder, () => {
      s.build(1);
      s.dispatch();
    });
    const opened = await openReplay(tape, {
      device: await replayDevice(false),
      createShaderModule,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe('replay-capability-mismatch');
    expect(opened.error.detail).toMatchObject({
      stage: 'replay',
      cause: expect.stringContaining('caps.rayQuery is unsupported'),
    });
  });
});
