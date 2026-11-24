import { writeFileSync } from 'node:fs';
import { RAY_QUERY_FEATURE } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { prepareComputePipeline } from '../../raytracing/prepare-pipeline';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { worldRayQueryMotionTraversalWgsl } from '../../raytracing/world-traversal';
import { readBuffer } from './path-tracer.fixture';

const HIT_COUNT = 5;
const ROW_BYTES = 64;
const PROBE_DEPTH = 2;
const transform = (x: number, rotate = false) =>
  rotate
    ? [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]
    : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

function motionWitness(useDenseRowAsIdentity: boolean) {
  const traversal = worldRayQueryMotionTraversalWgsl();
  const anchor = 'worldRayQueryHitMotion(c.instance_custom_data, localHit, result.position.xyz)';
  expect(traversal.split(anchor)).toHaveLength(2);
  const source = useDenseRowAsIdentity
    ? traversal.replace(
        anchor,
        'wrongHitMotion(c.instance_custom_data, localHit, result.position.xyz)',
      )
    : traversal;
  return `${source}
struct PreviousInstance { x: vec4f, y: vec4f, z: vec4f, valid: vec4u }
struct MotionObservation { velocity: vec4f, identity: vec4u }
@group(0) @binding(7) var<storage, read> witnessRays: array<Ray>;
@group(0) @binding(8) var<storage, read> previousInstances: array<PreviousInstance>;
@group(0) @binding(9) var<storage, read_write> observations: array<MotionObservation>;
fn wrongHitMotion(row: u32, objectHit: vec4f, worldHit: vec3f) -> vec4f {
 let prior = previousInstances[row];
 let previousHit = vec3f(dot(prior.x, objectHit), dot(prior.y, objectHit), dot(prior.z, objectHit));
 return vec4f(select(vec3f(0), worldHit - previousHit, prior.valid.x != 0u), f32(prior.valid.x));
}
@compute @workgroup_size(1) fn witnessMotion(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&witnessRays)) { return; }
  let ray = witnessRays[gid.x];
  let result = traceWorldWithHitMotion(ray, 128u);
  if (result.instanceRow == 0u) {
    observations[gid.x] = MotionObservation(vec4f(0), vec4u(0));
    return;
  }
  let motion = result.displacement;
  let probeSpeed = bitcast<f32>(ray.mask.z);
  let depth = bitcast<f32>(ray.mask.w);
  let moved = abs(length(motion.xyz) - probeSpeed) / max(depth, 1.0) > 0.005;
  observations[gid.x] = MotionObservation(
    vec4f(motion.xyz, select(0.0, 1.0, moved && motion.w != 0.0)),
    vec4u(result.hit.state.w, result.instanceRow, u32(motion.w), 1u));
}
`;
}

export async function verifyHardwareHitMotion() {
  const adapter = (
    await webgpu.rhi.requestAdapter({ powerPreference: 'high-performance' })
  ).unwrap();
  const device = (
    await adapter.requestDevice({ requiredFeatures: [RAY_QUERY_FEATURE as GPUFeatureName] })
  ).unwrap();
  const raw = device.nativeDevice().unwrap();
  if (!raw) throw new Error('Hit motion requires a real Ray Query device');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const world = createWorldAcceleration(device, {
    maxInstances: 8,
    maxTriangles: 1,
    maxBlasBuildsPerFrame: 1,
  }).unwrap();
  const prior = device.createBuffer({ size: 6 * ROW_BYTES, usage: 128 | 8 }).unwrap();
  const rays = device.createBuffer({ size: HIT_COUNT * 48, usage: 128 | 8 }).unwrap();
  const output = device.createBuffer({ size: HIT_COUNT * 32, usage: 128 | 4 }).unwrap();
  try {
    const geometry = {
      geometryId: 0,
      positions: new Float32Array([-1, -1, -2, 1, -1, -2, 0, 1, -2]),
    };
    const set = (id: number, x: number) =>
      world
        .set({ instanceId: id, geometryId: 0, mask: 255, transform: transform(x) }, geometry)
        .unwrap();
    for (const [id, x] of [
      [1, 0],
      [2, 4],
      [3, 8],
      [4, 12],
    ] as const)
      set(id, x);
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, accelerationStructure: {} },
          ...[2, 3, 7, 8].map((binding) => ({
            binding,
            visibility: 4,
            buffer: { type: 'read-only-storage' as const },
          })),
          { binding: 9, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const pipelines = await Promise.all(
      [false, true].map(async (negative) => {
        const module = (
          await webgpu.createShaderModule(device, { code: motionWitness(negative) })
        ).unwrap();
        return (
          await prepareComputePipeline(device, {
            layout: pipelineLayout,
            compute: { module, entryPoint: 'witnessMotion' },
          })
        ).unwrap();
      }),
    );
    const group = () =>
      device
        .createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { kind: 'accelerationStructure', value: world.tlas } },
            ...(
              [
                [2, world.traversalInstances],
                [3, world.faceNormals],
                [7, rays],
                [8, prior],
                [9, output],
              ] as const
            ).map(([binding, buffer]) => ({
              binding,
              resource: { kind: 'buffer' as const, value: { buffer } },
            })),
          ],
        })
        .unwrap();
    const writeRays = (moved: boolean, cameraZ: number, receiverSpeed = 0.25, hitX = 4.25) => {
      const bytes = new ArrayBuffer(HIT_COUNT * 48);
      const floats = new Float32Array(bytes),
        words = new Uint32Array(bytes);
      const samples = moved
        ? [
            [hitX, 0, 0],
            [8, 0.25, 0],
            [12, 0, 0],
            [16, 0, 0],
            [hitX, 0, receiverSpeed],
          ]
        : [
            [4, 0, 0],
            [8.25, 0, 0],
            [12, 0, 0],
            [16, 0, 0],
            [4, 0, 0],
          ];
      for (const [i, point] of samples.entries()) {
        floats.set([point[0] ?? 0, point[1] ?? 0, cameraZ, 0, 0, 0, -1, 10], i * 12);
        words.set([255, i], i * 12 + 8);
        floats.set([point[2] ?? 0, PROBE_DEPTH], i * 12 + 10);
      }
      device.queue.writeBuffer(rays, 0, new Uint8Array(bytes)).unwrap();
    };
    const writePrevious = (placed: readonly (readonly [number, readonly number[]])[]) => {
      const bytes = new ArrayBuffer(6 * ROW_BYTES);
      const floats = new Float32Array(bytes),
        words = new Uint32Array(bytes);
      for (const [id, matrix] of placed) {
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 4; col++) {
            floats[id * 16 + row * 4 + col] = matrix[col * 4 + row] ?? 0;
          }
        }
        words[id * 16 + 12] = 1;
      }
      device.queue.writeBuffer(prior, 0, new Uint8Array(bytes)).unwrap();
    };
    const capture = async (negative = false) => {
      const encoder = device.createCommandEncoder({}).unwrap();
      const build = world.update(encoder).unwrap();
      const pass = encoder.beginComputePass({});
      const pipeline = pipelines[negative ? 1 : 0];
      if (pipeline === undefined) throw new Error('Missing World motion witness pipeline');
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group());
      pass.dispatchWorkgroups(HIT_COUNT);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      world.track(device.queue.onSubmittedWorkDone());
      const bytes = await readBuffer(device, output, HIT_COUNT * 32);
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      return {
        tlasBuilt: build.tlasBuilt,
        bytesUploaded: build.bytesUploaded,
        hits: Array.from({ length: HIT_COUNT }, (_, i) => ({
          velocity: Array.from(floats.subarray(i * 8, i * 8 + 4)),
          identity: Array.from(words.subarray(i * 8 + 4, i * 8 + 8)),
        })),
      };
    };
    writeRays(false, 0);
    const seed = await capture();
    expect(seed.hits.map(({ identity }) => identity)).toEqual([
      [2, 2, 0, 1],
      [3, 3, 0, 1],
      [4, 4, 0, 1],
      [0, 0, 0, 0],
      [2, 2, 0, 1],
    ]);
    expect(seed.hits.map(({ velocity }) => velocity)).toEqual(Array(HIT_COUNT).fill([0, 0, 0, 0]));

    writePrevious([
      [1, transform(0)],
      [2, transform(4)],
      [3, transform(8)],
      [4, transform(12)],
    ]);
    world.remove(1);
    // Only the submitted placement owns history, even with several edits this frame.
    world.move(2, transform(4.125)).unwrap();
    world.move(2, transform(4.25)).unwrap();
    world.move(3, transform(8, true)).unwrap();
    set(5, 16);
    writeRays(true, 0);
    const moving = await capture();
    expect(moving.tlasBuilt).toBe(1);
    expect(moving.hits.map(({ identity }) => identity)).toEqual([
      [2, 2, 1, 1],
      [3, 3, 1, 1],
      [4, 1, 1, 1],
      [5, 4, 0, 1],
      [2, 2, 1, 1],
    ]);
    expect(moving.hits.map(({ velocity }) => velocity)).toEqual([
      [0.25, 0, 0, 1],
      [-0.25, 0.25, 0, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.25, 0, 0, 0],
    ]);
    // Move the camera in world space while retaining the same receiver and hit geometry.
    expect(world.motionPending).toBe(true);
    writeRays(true, 1, 0);
    const stopped = await capture();
    expect(stopped.tlasBuilt).toBe(0);
    expect(stopped.hits.map(({ velocity }) => velocity)).toEqual(
      Array(HIT_COUNT).fill([0, 0, 0, 0]),
    );
    expect(stopped.hits.map(({ identity }) => identity[2])).toEqual([1, 1, 1, 1, 1]);
    expect(world.motionPending).toBe(false);
    const still = await capture();
    expect(still.bytesUploaded).toBe(0);

    const wrongRow = await capture(true);
    expect(wrongRow.hits[2]?.velocity).toEqual([12, 0, 0, 1]);
    expect(wrongRow.hits[3]?.identity[2]).toBe(1);

    // Encode and abandon a move. Recovery must retain the last submitted placement.
    world.move(2, transform(4.5)).unwrap();
    world.update(device.createCommandEncoder({}).unwrap()).unwrap();
    world.recover().unwrap();
    world.move(2, transform(4.75)).unwrap();
    writeRays(true, 1, 0, 4.75);
    const recovered = await capture();
    expect(recovered.hits[0]?.identity[0]).toBe(2);
    expect(recovered.hits[0]?.velocity).toEqual([0.5, 0, 0, 1]);

    expect(errors).toEqual([]);
    const evidence = process.env.FORGEAX_WORLD_HIT_MOTION_OUTPUT;
    if (evidence) {
      writeFileSync(
        evidence,
        JSON.stringify(
          { adapter: raw.adapterInfo, seed, moving, wrongRow, stopped, still, recovered },
          null,
          2,
        ),
      );
    }
  } finally {
    world.dispose();
    for (const buffer of [prior, rays, output]) device.destroyBuffer(buffer);
    raw.destroy();
  }
}
