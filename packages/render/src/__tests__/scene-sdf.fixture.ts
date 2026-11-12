import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  buildMeshDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
  meshAssetDecoder,
} from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { SCENE_SDF_RUNTIME_WGSL } from '../../../vfx-compiler/src/scene-sdf';
import { createFeatureSceneSdf } from '../assembly/feature-scene-sdf';
import {
  createRenderFeatureGraphBufferState,
  importRenderFeatureGraphBuffer,
} from '../features/render-graph-resources';
import { worldRenderResources } from '../publication/resource-scope';
import { GLOBAL_SDF_COMPOSE_WGSL } from '../raytracing/global-sdf';
import type { RenderSystemInternals } from '../record/render-context';
import { MaterialFrame } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { readBuffer } from './raytracing/path-tracer.fixture';

/** Production managed producer and collision kernel, ordinary Mesh artifact
 * loader, one physical graph submission. Retained-source inputs are explicit
 * fixtures; full Renderer/World acceptance is a separate carrier. */
export async function verifySceneSdf(save?: (tape: Uint8Array, report: unknown) => Promise<void>) {
  const geometry = createBoxGeometry(2, 2, 2).unwrap();
  const positions = geometry.attributes.position;
  assert(positions instanceof Float32Array);
  assert(geometry.indices);
  const field = (
    await buildMeshDistanceField(positions, geometry.indices, { resolution: 24 })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const loaded = await meshAssetDecoder.decode({
    envelope: {
      guid: '019a4800-0000-7000-8000-000000000001',
      kind: 'mesh',
      payload: {
        ...geometry,
        distanceField: { sectionSidedness: [0] },
      } as unknown as MeshAsset,
      refs: [],
      artifacts: {
        'distance-field.bin': {
          path: 'distance-field.bin',
          contentEncoding: 'identity',
          byteLength: bytes.byteLength,
          mediaType: 'application/octet-stream',
          assetCodec: MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
          integrity: { algorithm: 'sha256', digest: `sha256:${digest}` },
        },
      },
    },
    artifacts: { read: async () => ok(new Uint8Array(bytes)) },
    signal: new AbortController().signal,
  });
  assert(loaded.ok, loaded.ok ? undefined : JSON.stringify(loaded.error));
  const mesh = loaded.value as MeshAsset;
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const native = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const module = (
    await recorder.backend.createShaderModule(device, { code: GLOBAL_SDF_COMPOSE_WGSL })
  ).unwrap();
  const probeModule = (
    await recorder.backend.createShaderModule(device, {
      code: `${SCENE_SDF_RUNTIME_WGSL}
@group(0) @binding(0) var<storage,read_write> results:array<VfxSdfCollision>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) gid:vec3u) {
  switch(gid.x) {
    case 0u: { results[0]=vfx_sdf_collide(vec3f(0,3,0),vec3f(0,-300,0),1.0/60.0,0.05,1.0,0.0); }
    case 1u: { results[1]=vfx_sdf_collide(vec3f(0,3,0),vec3f(4,-300,0),1.0/60.0,0.05,0.0,1.0); }
    case 2u: { results[2]=vfx_sdf_collide(vec3f(6,3,0),vec3f(0,-300,0),1.0/60.0,0.05,1.0,0.0); }
    case 3u: { results[3]=vfx_sdf_collide(vec3f(0,3,0),vec3f(0,-300,0),1.0/60.0,-1.0,1.0,0.0); }
    case 4u: { results[4]=vfx_sdf_collide(vec3f(0,3,0),vec3f(0,-300,0),0.0,0.05,1.0,0.0); }
    case 5u: {
      let p=vec3f(0,1.05+forgeax_vfx_scene_sdf.ranges.y+0.0005,0);
      results[5]=vfx_sdf_collide(p,vec3f(100,0,0),1.0/60.0,0.05,1.0,0.0);
    }
    case 6u: {
      // Saturated-distance cells have zero gradient. This diagonal traverses
      // more than 64 cells before leaving coverage; exhaustion must still stop
      // at the last checked position instead of completing an unchecked move.
      let radius=forgeax_vfx_scene_sdf.ranges.x-forgeax_vfx_scene_sdf.ranges.y-0.0005;
      results[6]=vfx_sdf_collide(vec3f(-3.875,7,-3.875),vec3f(480,0,288),1.0/60.0,radius,1.0,0.0);
    }
    default: {}
  }
}`,
    })
  ).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'storage' } },
        { binding: 15, visibility: 4, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module: probeModule, entryPoint: 'probe' },
    })
    .unwrap();
  const output = device
    .createBuffer({ label: 'collision.results', size: 7 * 48, usage: 128 | 12 })
    .unwrap();
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const meshHandle = assets.create(mesh).unwrap();
  const scope = worldRenderResources(world);
  let slots = [
    {
      worldId: 0,
      entityKey: 7,
      slot: 0,
      generation: 0,
      snapshot: {
        assetHandle: meshHandle,
        transform: { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        materials: [],
      },
    },
  ];
  let revision = 0;
  const internals = {
    device,
    assets,
    immediateShaderModuleFactory: { createShaderModule: () => ok(module) },
  } as unknown as RenderSystemInternals;
  const materials = new MaterialFrame(undefined);
  const meshes = new MeshFrame().with(0, meshHandle, mesh);
  /** A changed composition publishes new rows under a new revision. */
  const changeSource = () => {
    slots = slots.map((slot) => ({ ...slot }));
    revision++;
  };
  const source = () => ({
    scopes: [scope] as never,
    retained: {
      identity: scope,
      revision,
      slots,
      materials,
      meshes,
      isCurrent: () => true,
      isSourceCurrent: () => true,
    } as never,
  });
  const owner = createFeatureSceneSdf(internals);
  const request = {
    kind: 'scene-sdf' as const,
    name: 'collision',
    world: 0,
    descriptor: {
      origin: [-4, -4, -4] as const,
      dimensions: [65, 97, 65] as const,
      spacing: 0.125,
      maxDistance: 4,
      maxInstances: 16,
      maxFieldBytes: 1024 * 1024,
    },
  };
  let tapeBytes: Uint8Array;
  let actual: Uint8Array;
  try {
    // No declaration performs no GPU allocation or field composition.
    owner.begin();
    owner.complete(true);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    owner.begin();
    const scene = owner.prepare('a', request, source());
    expect(owner.prepare('b', { ...request, name: 'second-consumer' }, source()).buffer).toBe(
      scene.buffer,
    );
    const graphState = createRenderFeatureGraphBufferState();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    owner.contribute(builder, graphState);
    const imported = importRenderFeatureGraphBuffer(builder, graphState, 'collision.scene', {
      ...scene,
      physicalUsage: 128 | 12,
    }).unwrap();
    const result = importRenderFeatureGraphBuffer(builder, graphState, 'collision.results', {
      buffer: output,
      size: 7 * 48,
      physicalUsage: 128 | 12,
    }).unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: output } } },
          { binding: 15, resource: { kind: 'buffer', value: scene } },
        ],
      })
      .unwrap();
    builder
      .addComputePass('collision.update', {
        accesses: [
          { resource: imported, usage: 'storage-read' },
          { resource: result, usage: 'storage-write' },
        ],
        encode: ({ pass }) => {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(7);
        },
      })
      .unwrap();
    const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    graph.execute({ encoder } as never).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completion = device.queue.onSubmittedWorkDone();
    owner.complete(true, completion);
    await completion;
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    actual = await readBuffer(device, output, 7 * 48);
    await save?.(tapeBytes, {
      phase: 'live-results-before-assertions',
      tapeDigest: tapeDigest(tapeBytes),
      capabilities: device.caps,
      request,
      errors,
      results: Array.from(new Uint32Array(actual.buffer)),
      floats: Array.from(new Float32Array(actual.buffer)),
    });
    await graph.retire();
    const data = new DataView(actual.buffer, actual.byteOffset, actual.byteLength);
    expect(data.getUint32(12, true)).toBe(1);
    expect(data.getFloat32(4, true)).toBeGreaterThan(1.05);
    expect(data.getFloat32(20, true)).toBeCloseTo(300, 3);
    expect(data.getFloat32(36, true)).toBeGreaterThan(0.99);
    expect(data.getUint32(48 + 12, true)).toBe(1);
    expect(data.getFloat32(48 + 4, true)).toBeGreaterThan(1.05);
    expect(data.getFloat32(48 + 16, true)).toBeCloseTo(0, 3);
    expect(data.getFloat32(48 + 20, true)).toBeCloseTo(0, 3);
    expect(data.getUint32(96 + 12, true)).toBe(2);
    expect(data.getUint32(144 + 12, true)).toBe(5);
    expect(data.getFloat32(192 + 4, true)).toBe(3);
    expect(data.getUint32(240 + 12, true)).toBe(0);
    expect(data.getUint32(240 + 44, true)).toBe(0);
    expect(data.getFloat32(240, true)).toBeCloseTo(100 / 60, 5);
    expect(data.getUint32(288 + 12, true)).toBe(3);
    expect(data.getUint32(288 + 28, true)).toBe(64);
    expect(data.getUint32(288 + 44, true)).toBe(0);
    expect(data.getFloat32(288, true)).toBeLessThan(-3.875 + 480 / 60);
    expect(data.getFloat32(288 + 8, true)).toBeLessThan(-3.875 + 288 / 60);
    expect(data.getFloat32(288, true)).toBeGreaterThanOrEqual(-4);
    expect(data.getFloat32(288, true)).toBeLessThanOrEqual(4);
    expect(data.getFloat32(288 + 8, true)).toBeGreaterThanOrEqual(-4);
    expect(data.getFloat32(288 + 8, true)).toBeLessThanOrEqual(4);
    expect(data.getFloat32(288 + 4, true)).toBe(7);
    for (let i = 0; i < 7; i++) expect(data.getUint32(i * 48 + 28, true)).toBeLessThanOrEqual(88);
    // Stable hot reuse; a rejected replacement cannot adopt its field.
    owner.begin();
    expect(owner.prepare('a', request, source()).buffer).toBe(scene.buffer);
    owner.complete(true);
    changeSource();
    owner.begin();
    const rejected = owner.prepare('a', request, source());
    expect(Object.is(rejected.buffer, scene.buffer)).toBe(false);
    owner.complete(false);
    // The rejected candidate was released, not adopted: the same changed source
    // prepares a fresh replacement, which an accepted submission then adopts.
    owner.begin();
    const replacement = owner.prepare('a', request, source());
    expect(Object.is(replacement.buffer, rejected.buffer)).toBe(false);
    expect(Object.is(replacement.buffer, scene.buffer)).toBe(false);
    owner.complete(true);
    owner.begin();
    expect(owner.prepare('a', request, source()).buffer).toBe(replacement.buffer);
    owner.complete(false);
    expect(errors).toEqual([]);
  } finally {
    owner.dispose();
    device.destroyBuffer(output).unwrap();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const tape = decodeTape(tapeBytes).unwrap();
  const model = buildFrameModel(tape);
  const dispatches = model.works.filter((w) => w.kind === 'dispatchWorkgroups');
  expect(dispatches).toHaveLength(2);
  const producer = dispatches[0],
    consumer = dispatches[1];
  assert(producer);
  assert(consumer);
  // Cold resources have no pre-frame snapshot. Their recorded CPU writes
  // initialize every input and the header; the first dispatch writes voxels.
  expect(new Set(model.unseededResources.map((r) => r.resourceId))).toEqual(
    new Set(producer.bindings.map((b) => b.resourceId)),
  );
  const initialization = producer.bindings.map((binding) => {
    const eventIndex = tape.events.findIndex(
      (event) => event.kind === 'writeBuffer' && event.handleId === binding.resourceId,
    );
    const event = tape.events[eventIndex];
    assert(event?.kind === 'writeBuffer');
    expect(eventIndex).toBeLessThan(producer.eventIndex);
    expect(event.bufferOffset).toBe(0);
    expect(event.size).toBe(binding.binding === 4 ? 256 : binding.bufferSize);
    expect(tape.blobs.find((blob) => blob.hash === event.dataHash)?.bytes.byteLength).toBe(
      event.size,
    );
    return { resourceId: binding.resourceId, eventIndex, size: event.size, hash: event.dataHash };
  });
  expect(producer.bindings.find((b) => b.binding === 4)?.resourceId).toBe(
    consumer.bindings.find((b) => b.binding === 15)?.resourceId,
  );
  expect(producer.bindings.find((b) => b.binding === 4)?.bufferOffset).toBe(256);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const id = consumer.bindings.find((b) => b.binding === 0)?.resourceId;
    assert(id);
    expect(
      equalBytes((await replay.readResourceAtWork(id, consumer.workIndex)).unwrap().bytes, actual),
    ).toBe(true);
  } finally {
    (await replay.dispose()).unwrap();
    webgpu._internal_getRawDevice(fresh)?.destroy();
  }
  const report = {
    tapeDigest: tapeDigest(tapeBytes),
    dispatches: dispatches.map((w) => ({ workIndex: w.workIndex, bindings: w.bindings })),
    initialization,
    results: Array.from(new Uint32Array(actual.buffer)),
    exactReplay: true,
    originalDestroyedBeforeReplay: true,
  };
  await save?.(tapeBytes, report);
  return report;
}

/** Exact XY values repeated across thirteen Z slices of captured resource589.
 * The first input guards the sampled-cell normal. The second is particle188
 * immediately before tick44 in the actual 1024-particle cooked shell: four
 * resolved contacts must finish the tick rather than exhaust the work budget. */
export async function verifySceneSdfContactGradient(
  save?: (tape: Uint8Array, report: unknown) => Promise<void>,
) {
  const row = [
    0.349999994, 0.349999994, 0.349999994, 0.349999994, 0.474999994, 0.474999994, 0.474999994,
    0.374999821, 0.600000024, 0.600000024, 0.499999821, 0.374999821, 0.724999964, 0.624999821,
    0.499999821, 0.374999821,
  ];
  const grid = new Uint8Array(256 + 208 * 16);
  const words = new DataView(grid.buffer);
  [1.25, -0.5, -1.125, 0.125].forEach((value, lane) => {
    words.setFloat32(lane * 4, value, true);
  });
  [4, 4, 13, 2].forEach((value, lane) => {
    words.setUint32(16 + lane * 4, value, true);
  });
  words.setFloat32(32, 2, true);
  words.setFloat32(36, 0.37888920307159424, true);
  for (let voxel = 0; voxel < 208; voxel++) {
    words.setFloat32(256 + voxel * 16, row[voxel % 16] ?? 0, true);
    words.setFloat32(260 + voxel * 16, 1, true);
    words.setUint32(264 + voxel * 16, 1, true);
  }
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const native = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const field = device
    .createBuffer({
      label: 'contact-gradient.captured-grid',
      size: grid.byteLength,
      usage: 128 | 12,
    })
    .unwrap();
  const output = device
    .createBuffer({ label: 'contact-gradient.result', size: 96, usage: 128 | 12 })
    .unwrap();
  const parameters = device
    .createBuffer({
      label: 'contact-gradient.captured-inputs',
      size: 96,
      usage: 64 | 12,
    })
    .unwrap();
  const inputs = new Float32Array([
    1.462989330291748,
    -0.2513653337955475,
    0.015970706939697266,
    1 / 60,
    -0.15742230415344238,
    -0.48837023973464966,
    0,
    9.8,
    0.15,
    0.25,
    0.1,
    0,
    1.3918325901031494,
    -0.3138624131679535,
    -0.9877995252609253,
    1 / 60,
    2.6925504207611084,
    1.2619045972824097,
    0,
    9.8,
    0.15,
    0.25,
    0.1,
    0,
  ]);
  let tapeBytes: Uint8Array;
  let actual: Uint8Array;
  try {
    const module = (
      await recorder.backend.createShaderModule(device, {
        code: `${SCENE_SDF_RUNTIME_WGSL}
@group(0) @binding(0) var<storage,read_write> results:array<VfxSdfCollision>;
struct ContactInput { position_delta:vec4f, velocity_gravity:vec4f, response:vec4f }
@group(0) @binding(1) var<uniform> inputs:array<ContactInput,2>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id:vec3u) {
 let input=inputs[id.x];
 let velocity=input.velocity_gravity.xyz-vec3f(0,input.velocity_gravity.w*input.position_delta.w,0);
 results[id.x]=forgeax_vfx_sdf_sweep(input.position_delta.xyz,velocity,
  input.position_delta.w,input.response.xyz);
}`,
      })
    ).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'storage' } },
          { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
          { binding: 15, visibility: 4, buffer: { type: 'read-only-storage' } },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'probe' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: output } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: parameters } } },
          { binding: 15, resource: { kind: 'buffer', value: { buffer: field } } },
        ],
      })
      .unwrap();
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    device.queue.writeBuffer(field, 0, grid).unwrap();
    device.queue.writeBuffer(parameters, 0, inputs).unwrap();
    const state = createRenderFeatureGraphBufferState();
    const builder = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    const input = importRenderFeatureGraphBuffer(builder, state, 'captured-grid', {
      buffer: field,
      size: grid.byteLength,
      physicalUsage: 128 | 12,
    }).unwrap();
    const result = importRenderFeatureGraphBuffer(builder, state, 'contact-result', {
      buffer: output,
      size: 96,
      physicalUsage: 128 | 12,
    }).unwrap();
    const controls = importRenderFeatureGraphBuffer(builder, state, 'captured-inputs', {
      buffer: parameters,
      size: 96,
      physicalUsage: 64 | 12,
    }).unwrap();
    builder
      .addComputePass('contact-gradient.regression', {
        accesses: [
          { resource: input, usage: 'storage-read' },
          { resource: controls, usage: 'uniform-read' },
          { resource: result, usage: 'storage-write' },
        ],
        encode: ({ pass }) => {
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(2);
        },
      })
      .unwrap();
    const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    try {
      const encoder = device.createCommandEncoder({}).unwrap();
      graph.execute({ encoder } as never).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      (await recorder.frameBoundary()).unwrap();
      tapeBytes = (await capture).unwrap().bytes;
      actual = await readBuffer(device, output, 96);
      await save?.(tapeBytes, {
        phase: 'live-results-before-assertions',
        tapeDigest: tapeDigest(tapeBytes),
        inputs: Array.from(inputs),
        results: Array.from(new Uint32Array(actual.buffer)),
        floats: Array.from(new Float32Array(actual.buffer)),
        errors,
      });
      const data = new DataView(actual.buffer, actual.byteOffset, actual.byteLength);
      expect(data.getUint32(12, true)).toBe(1);
      expect(data.getUint32(44, true)).toBeLessThan(4);
      expect(data.getUint32(28, true)).toBeLessThanOrEqual(64);
      expect(data.getFloat32(32, true)).toBeLessThan(-0.8);
      expect(data.getFloat32(36, true)).toBeGreaterThan(0.45);
      expect(data.getUint32(48 + 12, true)).toBe(1);
      expect(data.getUint32(48 + 44, true)).toBe(4);
      expect(data.getUint32(48 + 28, true)).toBeLessThanOrEqual(64);
      expect(data.getFloat32(48, true)).toBeGreaterThan(inputs[12] ?? 0);
      expect(data.getFloat32(48 + 4, true)).toBeGreaterThan(inputs[13] ?? 0);
      for (const offset of [0, 48]) {
        for (const lane of [0, 4, 8, 16, 20, 24, 32, 36, 40]) {
          expect(Number.isFinite(data.getFloat32(offset + lane, true))).toBe(true);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await graph.retire();
    }
  } finally {
    device.destroyBuffer(field).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(parameters).unwrap();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const tape = decodeTape(tapeBytes).unwrap();
  const work = buildFrameModel(tape).works.find((item) => item.kind === 'dispatchWorkgroups');
  assert(work);
  const id = work.bindings.find((binding) => binding.binding === 0)?.resourceId;
  assert(id);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    expect(
      equalBytes((await replay.readResourceAtWork(id, work.workIndex)).unwrap().bytes, actual),
    ).toBe(true);
  } finally {
    (await replay.dispose()).unwrap();
    webgpu._internal_getRawDevice(fresh)?.destroy();
  }
  await save?.(tapeBytes, {
    tapeDigest: tapeDigest(tapeBytes),
    inputs: Array.from(inputs),
    results: Array.from(new Uint32Array(actual.buffer)),
    floats: Array.from(new Float32Array(actual.buffer)),
    exactReplay: true,
    originalDestroyedBeforeReplay: true,
  });
}
