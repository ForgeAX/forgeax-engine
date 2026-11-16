import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import {
  type AdvancedCollisionSnapshot,
  advancedCollisionHistory,
} from '../water/advanced-collisions';
import { ADVANCED_RIGID_COLLISION_WGSL } from '../water/advanced-rigid-collision-shader';

function snapshot(
  position: readonly [number, number, number],
  rotation: readonly [number, number, number, number],
  motionDiscontinuity = 0,
  originM: readonly [number, number, number] = [0, 0, 0],
): AdvancedCollisionSnapshot {
  const transform = mat4.compose(
    mat4.create(),
    [position[0] - originM[0], position[1] - originM[1], position[2] - originM[2]],
    rotation,
    [1, 1, 1],
  );
  return {
    originM,
    primitives: new Float32Array([
      ...mat4.invert(mat4.create(), transform),
      ...transform,
      2,
      7,
      1.2,
      2,
      0,
      0,
      0,
      0,
    ]),
    sdfInstances: new Uint8Array(144),
    sdfFields: new Uint8Array(4),
    roster: [
      {
        entity: 1,
        bodyGeneration: 1,
        completedStep: 1,
        motionDiscontinuity,
        identity: { kind: 'native-collider', colliderId: 'hull', generation: 1, elementIndex: 0 },
        representation: 'box',
      },
    ],
  };
}

it('preserves GPU point motion while suppressing only an explicit native pose discontinuity', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Rigid pose history requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  try {
    const dt = 1 / 15;
    const angle = 0.12;
    const identity = [0, 0, 0, 1] as const;
    const reset = snapshot([0, 0.9, 0], identity, 1, [8, 0, 0]);
    const rest = snapshot([0, 0.9, 0], identity);
    const histories = [
      advancedCollisionHistory(
        reset,
        snapshot([20.5632515, 0.87330735, -6.01888657], identity, 0, [27.5, 0, -9.5]),
      ),
      advancedCollisionHistory(snapshot([0.4, 0.9, 0], identity, 1, [8.5, 0, 0]), reset),
      advancedCollisionHistory(
        snapshot([0, 0.9, 0], [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]),
        rest,
      ),
      advancedCollisionHistory(
        snapshot([0, 0.9, 0], [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]),
        rest,
      ),
    ];
    const module = device.createShaderModule({
      code: `
@group(0) @binding(0) var<storage,read> p:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4<f32>>;
fn rotate(value:vec2<f32>,angle:f32)->vec2<f32>{
  return vec2<f32>(cos(angle)*value.x-sin(angle)*value.y,sin(angle)*value.x+cos(angle)*value.y);
}
${ADVANCED_RIGID_COLLISION_WGSL}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>){
  output[id.x]=vec4<f32>(rigidPointVelocity(rigidPrimitives[id.x],vec3<f32>(2.0,1.0,-1.0)),1.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((row) => row.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const makeBuffer = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      buffers.push(buffer);
      return buffer;
    };
    const params = makeBuffer(25 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const parameters = new Float32Array(100);
    parameters[97] = dt;
    device.queue.writeBuffer(params, 0, parameters);
    const primitives = makeBuffer(
      histories.length * 160,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(
      primitives,
      0,
      new Float32Array(histories.flatMap((row) => Array.from(row.primitives))),
    );
    const output = makeBuffer(
      histories.length * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const readback = makeBuffer(
      histories.length * 16,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: output } },
          { binding: 17, resource: { buffer: primitives } },
        ],
      }),
    );
    pass.dispatchWorkgroups(histories.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, histories.length * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange());
    const expected = [
      [0, 0, 0],
      [6, 0, 0],
      [
        (2 * Math.cos(angle) - Math.sin(angle) - 2) / dt,
        0,
        (-2 * Math.sin(angle) - Math.cos(angle) + 1) / dt,
      ],
      [
        0,
        (Math.cos(angle) + Math.sin(angle) - 1) / dt,
        (Math.sin(angle) - Math.cos(angle) + 1) / dt,
      ],
    ];
    for (const [index, velocity] of expected.entries())
      for (const [axis, value] of velocity.entries())
        expect(result[index * 4 + axis]).toBeCloseTo(value, 4);
    readback.unmap();
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
});
