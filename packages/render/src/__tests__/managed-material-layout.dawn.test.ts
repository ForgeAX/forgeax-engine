import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { RenderScene } from '../scene/render-scene';
import { updateGpuView } from './helpers/gpu-input-read-domain';

it('GPU culling follows resized material content without reuploading candidates and keeps logical suppression', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const native = _internal_getRawDevice(device);
  if (native === undefined) throw new Error('native validation unavailable');
  native.pushErrorScope('validation');
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const admitted = GpuScene.create(device, 256).unwrap();
  if (admitted.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = admitted.scene;
  const view = GpuDrivenView.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const projection = new RenderScene();
  const initial: MaterialSnapshot = {
    passes: [{ name: 'forward', program: { module: 'test::editable' } }],
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'test::editable',
    materialParamSchema: [{ name: 'tint', type: 'color' }],
    paramSnapshot: { tint: [1, 0, 0, 1] },
  };
  const material = new MaterialResource(initial);
  const sources: RenderableSnapshot[] = [0, 1].map((entityKey) => ({
    entityKey,
    worldId: 0,
    assetHandle: 3,
    transform: { world: mat4.identity(mat4.create()) },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'test',
        materialResourceClass: 'shared',
        geometry: {
          receipt: {
            identity: 'triangle',
            vertexInputs: [],
            topology: 'triangle-list',
            indexed: true,
          },
          draw: { kind: 'indexed', first: 0, count: 3, baseVertex: 0, topology: 'triangle-list' },
          deformation: 'rigid',
        },
      },
    ],
  }));
  const delta = projection.apply(
    sources.map((snapshot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  // A retained neighbour occupies the following row, so growth must relocate.
  const neighbour = new MaterialResource({ ...initial, paramSnapshot: { tint: [0, 0, 1, 1] } });
  let materials = new MaterialFrame(undefined).with(material, 2).with(neighbour);
  scene.sync({ ...delta, materials }).unwrap();
  const topology = new BatchTopology();
  topology.apply(delta);
  const plan = topology.query(topology.sourcePlan(), undefined);
  expect(plan.candidateCount).toBe(2);
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const readback = device
    .createBuffer({ size: 36, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const run = async (suppressed = 0) => {
    updateGpuView(view, plan, scene, planes, undefined, 0, new Uint32Array([suppressed])).unwrap();
    const uploads = view.inspect().sharedInputUploadBytes;
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    view.addPasses(graph).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const visible = view.visibleBuffer,
      indirect = view.indirectBuffer;
    if (visible === undefined || indirect === undefined) throw new Error('missing cull outputs');
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder }).unwrap();
    encoder.copyBufferToBuffer(visible, 0, readback, 0, 16);
    encoder.copyBufferToBuffer(indirect, 0, readback, 16, 20);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapping = (await readback.mapAsync(1)).unwrap();
    const words = new Uint32Array(mapping.getMappedRange().unwrap().slice(0));
    mapping.unmap();
    await compiled.retire();
    return { words, uploads };
  };
  try {
    const before = await run();
    expect(before.words[5]).toBe(2);
    const descriptor = scene.materialIndexForSlot(0, 0);
    const memberNodes = scene.inputs.memberNodesWritten;
    material.adopt({
      ...initial,
      materialParamSchema: [
        ...(initial.materialParamSchema ?? []),
        { name: 'roughness', type: 'f32' },
      ],
      paramSnapshot: { tint: [0, 1, 0, 1], roughness: 0.25 },
    });
    materials = materials.with(material);
    scene.sync({ ...projection.apply([]), materials }).unwrap();
    const after = await run(1 << 1);
    expect(scene.materialIndexForSlot(0, 0)).toBe(descriptor);
    expect(after.uploads).toBe(8);
    expect(view.inspect().batchUploadBytes).toBe(0);
    expect(scene.inputs.memberNodesWritten).toBe(memberNodes);
    expect(after.words[5]).toBe(1);
    expect(after.words[0]).toBe(scene.instanceIndexForSlot(0, 0));
    expect(after.words[1]).not.toBe(before.words[1]);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    view.dispose();
    scene.dispose();
    device.destroyBuffer(readback);
    await device.queue.onSubmittedWorkDone();
  }
});
