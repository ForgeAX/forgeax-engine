import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import common from '../../../shader/src/common.wgsl?raw';
import fogModule from '../../../shader/src/fog.wgsl?raw';
import type { FogFrame } from '../extract/environment';
import { writeViewUbo } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';

// Host fog lanes -> the shipped fog.wgsl law -> GPU readback, compared with the
// Three.js formulas (fog_fragment.glsl: smoothstep(near, far, depth) and
// 1 - exp(-(density * depth)^2) over view depth) and the unchanged exp law.

const STORAGE = 0x80;
const UNIFORM = 0x40;
const COPY_DST = 0x08;
const COPY_SRC = 0x04;
const MAP_READ = 0x01;

/** Points as (x, y, view depth) for a camera at z = 5 looking down -z. */
const POINTS: readonly (readonly [number, number, number])[] = [
  [0, 0, 1],
  [0, 0, 30],
  [0, 0, 65],
  [0, 0, 80],
  [0, 0, 95],
  [3, 0, 4],
  [0, 0, 125],
  [0, 0, 400],
];

function camera(projection: 'perspective' | 'orthographic'): CameraSnapshot {
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 0, 5),
    world,
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 1000,
    projection,
    orthoLeft: -10,
    orthoRight: 10,
    orthoBottom: -10,
    orthoTop: 10,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
}

function viewPayload(projection: 'perspective' | 'orthographic', fog: FogFrame): Float32Array {
  let payload = new Float32Array();
  const queue = {
    writeBuffer: (_buffer: Buffer, offset: number, data: Float32Array) => {
      if (offset === 0 && payload.length === 0) payload = data.slice();
      return { ok: true, value: undefined } as const;
    },
  } as unknown as RhiQueue;
  const light = {
    kind: 'directional',
    direction: vec3.create(0, -1, 0),
    color: vec3.create(0, 0, 0),
    intensity: 0,
    contactShadowLength: 0,
  } as never;
  const lights = { point: [], spot: [] } as never;
  const target = camera(projection);
  writeViewUbo(queue, {} as Buffer, target, light, lights, [], 0, undefined, undefined, fog);
  return payload;
}

const ENTRY = `
#import forgeax_view::common::{View}
#import forgeax_view::fog::{height_fog_with_source}
@group(0) @binding(0) var<uniform> v: View;
@group(0) @binding(1) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> opacity: array<f32>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  opacity[id.x] = 1.0 - height_fog_with_source(v, points[id.x].xyz, vec3<f32>(1.0)).transmittance;
}`;

async function gpuOpacity(
  device: GPUDevice,
  code: string,
  payload: Float32Array,
): Promise<number[]> {
  const view = device.createBuffer({ size: payload.byteLength, usage: UNIFORM | COPY_DST });
  device.queue.writeBuffer(view, 0, payload);
  const points = device.createBuffer({ size: POINTS.length * 16, usage: STORAGE | COPY_DST });
  device.queue.writeBuffer(
    points,
    0,
    new Float32Array(POINTS.flatMap(([x, y, depth]) => [x, y, 5 - depth, 1])),
  );
  const output = device.createBuffer({ size: POINTS.length * 4, usage: STORAGE | COPY_SRC });
  const readback = device.createBuffer({ size: POINTS.length * 4, usage: MAP_READ | COPY_DST });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [view, points, output].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(POINTS.length);
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(MAP_READ);
  const values = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
  readback.unmap();
  return values;
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

const BASE: FogFrame = {
  entityKey: 1,
  color: [1, 1, 1],
  density: 0.02,
  heightFalloff: 0,
  maxOpacity: 0.9,
  mode: 'exp',
  near: 65,
  far: 125,
};

it('evaluates the Three.js linear and exp2 fog laws on the GPU over view depth', async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (adapter === null || adapter === undefined) throw new Error('fog laws need WebGPU');
  const device = await adapter.requestDevice();
  // fog.wgsl's atmosphere-dependent tail is not part of the law under test.
  const fog = fogModule
    .slice(0, fogModule.indexOf('fn height_fog(v:View'))
    .replace(/#import forgeax_view::atmosphere::[^\n]*\n/, '');
  const code = await composeShader(
    ENTRY,
    { 'forgeax_view::common': common, 'forgeax_view::fog': fog },
    {
      STORAGE_BUFFER_AVAILABLE: true,
      EXTENDED_LIGHTING_AVAILABLE: false,
      PER_INSTANCE_REGION: false,
    },
  );
  // Three.js fogs by view depth: the off-axis point keeps depth 4 under both projections.
  const depthOf = (point: (typeof POINTS)[number]) => point[2];
  const euclid = ([x, y, depth]: readonly [number, number, number]) => Math.hypot(x, y, depth);
  const cases: {
    fog: FogFrame;
    ortho: boolean;
    expected: (p: (typeof POINTS)[number]) => number;
  }[] = [
    {
      fog: { ...BASE, mode: 'linear' },
      ortho: false,
      expected: (p) => 0.9 * smoothstep(65, 125, depthOf(p)),
    },
    {
      fog: { ...BASE, mode: 'linear' },
      ortho: true,
      expected: (p) => 0.9 * smoothstep(65, 125, depthOf(p)),
    },
    {
      fog: { ...BASE, mode: 'exp2' },
      ortho: false,
      expected: (p) => 0.9 * (1 - Math.exp(-((0.02 * depthOf(p)) ** 2))),
    },
    {
      // The default law is unchanged: exponential over the Euclidean ray.
      fog: BASE,
      ortho: false,
      expected: (p) => 0.9 * (1 - Math.exp(-0.02 * euclid(p))),
    },
  ];
  try {
    for (const { fog: law, ortho, expected } of cases) {
      const payload = viewPayload(ortho ? 'orthographic' : 'perspective', law);
      const measured = await gpuOpacity(device, code, payload);
      const reference = POINTS.map(expected);
      for (const [index, value] of measured.entries()) {
        expect(value, `${law.mode} ${ortho ? 'ortho' : 'persp'} point ${index}`).toBeCloseTo(
          reference[index] ?? Number.NaN,
          3,
        );
      }
    }
  } finally {
    device.destroy();
  }
});
