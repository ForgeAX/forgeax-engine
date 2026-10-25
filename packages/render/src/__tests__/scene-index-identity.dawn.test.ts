import { readFileSync } from 'node:fs';
import { vec3 } from '@forgeax/engine-math';
import type { BindGroupLayout, Buffer, ComputePipeline } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { GpuScene } from '../gpu-scene';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { nativeDeviceFixture } from './native-device-fixture';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const rootA = new Float32Array([0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 0.5, 0, 4, -2, 7, 1]);
const rootB = new Float32Array([1, 0.5, 0, 0, 0, -2, 0, 0, 0, 0, 4, 0, -3, 6, 2, 1]);
const localA = new Float32Array([0.5, 0, 0, 0, 0, 0, 2, 0, 0, -1, 0, 0, 5, 3, -2, 1]);
const material = new MaterialResource({
  baseColor: vec3.create(0.25, 0.5, 0.75),
  metallic: 0.2,
  roughness: 0.8,
  materialHandle: 17,
  passes: [],
});

function snapshot(
  entityKey: number,
  world: Float32Array,
  locals?: readonly Float32Array[],
): RenderableSnapshot {
  return {
    assetHandle: 9,
    worldId: 0,
    entityKey,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    lightingChannels: 0x80000001,
    shadowReceiver: false,
    ...(locals === undefined
      ? {}
      : {
          instances: {
            transforms: new Float32Array(locals.flatMap((value) => [...value])),
            generations: new Uint32Array(locals.map((_, index) => index + 1)),
            instanceCount: locals.length,
            cacheKey: entityKey,
            archVersion: 1,
          },
        }),
  };
}

const update = (value: RenderableSnapshot) => ({
  kind: 'update' as const,
  worldId: value.worldId,
  entityKey: value.entityKey,
  snapshot: value,
});

const witness = `
#import forgeax_view::common::{sceneIndexDraw, sceneIndexLocalLoads, sceneInstances, scenePrimitives, sceneTransformPrevious, sceneTransforms}
struct ResultRow {
  current: mat4x4<f32>,
  previous: mat4x4<f32>,
  referenceCurrent: mat4x4<f32>,
  referencePrevious: mat4x4<f32>,
  identityCurrent: mat4x4<f32>,
  identityPrevious: mat4x4<f32>,
  facts: vec4<u32>,
}
@group(0) @binding(0) var<storage, read_write> output: array<ResultRow>;
@group(0) @binding(1) var<storage, read> rows: array<u32>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  let row = rows[id.x];
  let instance = sceneInstances[row];
  let primitive = scenePrimitives[instance.primitiveIndex];
  let root = sceneTransforms[primitive.transformIndex];
  let local = sceneTransforms[instance.transformIndex];
  let draw = sceneIndexDraw(row);
  let frame = sceneTransforms[0u].stamp;
  // The pre-optimization formula is evaluated independently on the same GPU.
  output[id.x] = ResultRow(draw.world, draw.previousWorld,
    root.currentWorld * local.currentWorld,
    sceneTransformPrevious(root, frame) * sceneTransformPrevious(local, frame),
    sceneTransforms[0u].currentWorld, sceneTransformPrevious(sceneTransforms[0u], frame),
    vec4<u32>(sceneIndexLocalLoads(), instance.transformIndex,
      draw.lightingChannels, select(0u, 1u, draw.receivesShadows)));
}
`;

it('skips the reserved identity row while preserving real GPU Scene transforms through growth, motion and rebuild', async () => {
  const common = readFileSync(new URL('../../../shader/src/common.wgsl', import.meta.url), 'utf8');
  const localRead = 'let local = sceneTransforms[instance.transformIndex];';
  expect(common.split(localRead)).toHaveLength(2);
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const buffers: Buffer[] = [];
  const scenes: GpuScene[] = [];
  const buffer = (size: number, usage: number) => {
    const value = device.createBuffer({ size, usage }).unwrap();
    buffers.push(value);
    return value;
  };
  const createScene = () => {
    const created = GpuScene.create(device, 1).unwrap();
    if (created.status !== 'available') throw new Error('Dawn must provide GPU Scene storage');
    scenes.push(created.scene);
    return created.scene;
  };
  try {
    // Both the unchanged production kernel and an operation-count witness run
    // on Dawn. Instrument only the local-row read; keep all matrix arithmetic.
    const pipelines: {
      pipeline: ComputePipeline;
      layouts: BindGroupLayout[];
      counted: boolean;
    }[] = [];
    for (const counted of [false, true]) {
      const source = counted
        ? `${common.replace(localRead, `sceneIndexLocalReadCount += 1u;\n  ${localRead}`)}
var<private> sceneIndexLocalReadCount: u32;
fn sceneIndexLocalLoads() -> u32 { return sceneIndexLocalReadCount; }`
        : `${common}\nfn sceneIndexLocalLoads() -> u32 { return 0u; }`;
      const result = await compileShader(witness, {
        id: 'scene-index-identity-witness',
        imports: { 'forgeax_view::common': source },
        defines: { GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true, STORAGE_BUFFER_AVAILABLE: true },
      });
      if (!result.ok) throw result.error;
      const compiled = result.value;
      expect(compiled.bindings).toHaveLength(3);
      // The compiler returns occupied groups; preserve the physical group-1 gap.
      const layouts = [
        compiled.bindings[0],
        { entries: [] },
        compiled.bindings[1],
        compiled.bindings[2],
      ].map((descriptor) => {
        if (descriptor === undefined) throw new Error('Missing reflected witness group');
        return device
          .createBindGroupLayout({
            entries: descriptor.entries.map(({ binding, visibility, buffer }) => {
              if (buffer === undefined)
                throw new Error('Scene transform witness uses only buffers');
              return { binding, visibility, buffer };
            }),
          })
          .unwrap();
      });
      const module = createShaderModuleImmediate(device, { code: compiled.wgsl }).unwrap();
      const pipeline = device
        .createComputePipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: layouts }).unwrap(),
          compute: { module, entryPoint: 'probe' },
        })
        .unwrap();
      pipelines.push({ pipeline, layouts, counted });
    }
    let scene = createScene();
    const projection = new RenderScene();
    let ordinary = snapshot(1, rootA);
    let instanced = snapshot(2, rootB, [identity, localA]);
    const sync = (values: readonly RenderableSnapshot[]) =>
      scene
        .sync(projection.apply(values.map(update)), (slot) =>
          projection.temporalSnapshotBySlot(slot.slot),
        )
        .unwrap();
    const commit = () => {
      scene.commitFrame().unwrap();
      projection.commitSubmission(projection.captureSubmission([ordinary, instanced]));
    };
    const probe = async (
      expectedOrdinaryCurrent: Float32Array,
      expectedOrdinaryPrevious: Float32Array,
    ) => {
      const slots = projection.slotsSnapshot();
      const rowIds: number[] = [];
      const explicit: boolean[] = [];
      for (const value of [ordinary, instanced]) {
        const slot = slots.find((entry) => entry.snapshot.entityKey === value.entityKey);
        if (slot === undefined) throw new Error('Missing retained scene slot');
        for (let ordinal = 0; ordinal < (value.instances?.instanceCount ?? 1); ordinal++) {
          const row = scene.instanceIndexForSlot(slot.slot, ordinal);
          if (row === undefined) throw new Error('Missing retained instance row');
          rowIds.push(row);
          explicit.push(value.instances !== undefined);
        }
      }
      const rowBuffer = buffer(rowIds.length * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(rowBuffer, 0, new Uint32Array(rowIds)).unwrap();
      const stride = 400;
      const bytes = stride * rowIds.length;
      const output = buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const readback = buffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      for (const { pipeline, layouts, counted } of pipelines) {
        const entries = [
          [output, rowBuffer],
          [],
          [scene.transformBuffer],
          [scene.instanceBuffer, scene.primitiveBuffer],
        ];
        const groups = layouts.map((layout, group) =>
          device
            .createBindGroup({
              layout,
              entries: (entries[group] ?? []).map((value, index) => ({
                binding: group === 3 && index === 1 ? 6 : index,
                resource: { kind: 'buffer' as const, value: { buffer: value } },
              })),
            })
            .unwrap(),
        );
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (const [index, group] of groups.entries()) pass.setBindGroup(index, group);
        pass.dispatchWorkgroups(rowIds.length);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const mapped = (await readback.mapAsync(GPUMapMode.READ)).unwrap();
        const data = mapped.getMappedRange().unwrap().slice(0);
        mapped.unmap();
        expect((await native.popErrorScope())?.message).toBeUndefined();
        native.pushErrorScope('validation');
        const floats = new Float32Array(data);
        const words = new Uint32Array(data);
        for (let row = 0; row < rowIds.length; row++) {
          const at = (row * stride) / 4;
          for (let lane = 0; lane < 32; lane++) {
            expect(floats[at + lane], `row ${row}, matrix lane ${lane}`).toBeCloseTo(
              floats[at + 32 + lane] ?? NaN,
              6,
            );
          }
          expect([...floats.slice(at + 64, at + 80)]).toEqual([...identity]);
          expect([...floats.slice(at + 80, at + 96)]).toEqual([...identity]);
          expect(words[at + 97] === 0).toBe(!explicit[row]);
          expect(words[at + 98]).toBe(0x80000001);
          expect(words[at + 99]).toBe(0);
          if (counted) expect(words[at + 96]).toBe(explicit[row] ? 1 : 0);
        }
        expect([...floats.slice(0, 16)]).toEqual([...expectedOrdinaryCurrent]);
        expect([...floats.slice(16, 32)]).toEqual([...expectedOrdinaryPrevious]);
      }
    };
    sync([ordinary, instanced]);
    expect(scene.inspect().capacityGrows).toBeGreaterThan(0);
    await probe(rootA, rootA);
    commit();

    ordinary = snapshot(1, rootB);
    instanced = snapshot(2, rootA, [localA, identity]);
    sync([ordinary, instanced]);
    await probe(rootB, rootA);
    // A frame without a commit keeps the last submitted previous transforms.
    ordinary = snapshot(1, identity);
    sync([ordinary]);
    await probe(identity, rootA);
    commit();
    scene.sync(projection.apply([])).unwrap();
    await probe(identity, identity);

    scene
      .sync(projection.apply([{ kind: 'remove', worldId: 0, entityKey: ordinary.entityKey }]))
      .unwrap();
    ordinary = snapshot(3, rootB);
    sync([ordinary]);
    await probe(rootB, rootB);

    // In-place projection replacement and fresh table rebuild use the same
    // complete snapshot input as PersistentRenderScene.acquireGpuScene.
    const rebuild = () => {
      const slots = projection.slotsSnapshot();
      scene
        .sync({
          ...projection.apply([]),
          created: slots.length,
          createdSlots: [...slots],
          resynced: 1,
        })
        .unwrap();
    };
    rebuild();
    await probe(rootB, rootB);
    scene = createScene();
    rebuild();
    await probe(rootB, rootB);
    expect((await native.popErrorScope())?.message).toBeUndefined();
  } finally {
    for (const scene of scenes) scene.dispose();
    for (const value of buffers) device.destroyBuffer(value);
    native.destroy();
  }
}, 30_000);
