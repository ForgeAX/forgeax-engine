import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderSurfaceError } from '../errors/render';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { deriveStandardTopologyInput } from '../pipeline/standard-lighting/topology';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import { STANDARD_CLUSTER_MEMBERSHIP_WGSL, standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';

function topology(): RenderPipelineTopology {
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred', lightCount: 256 },
    config: { ssao: { enabled: true } },
    surface: {
      width: 1,
      height: 1,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'on', bloomIntensity: 1 },
    shadow: {
      directional: { mapSize: 64, cascadeCount: 1 },
      spotMapSize: 64,
      pointCount: 0,
      pointFaceSize: 64,
      spotCount: 0,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'none',
    gpuDrivenTopologySignature: '',
  };
}

function clusteredStandardLighting() {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [{ kind: 'point' as const, shadowed: false, position: vec3.create(0, 0, -4), range: 2 }],
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount: 256,
    renderPath: 'deferred',
  });
  if (!prepared.ok) throw prepared.error;
  const transport = selectStandardClusterTransport(
    { compute: true, storageBuffer: true, membershipPipelineReady: true },
    prepared.value,
  );
  if (!transport.ok) throw transport.error;
  const lighting = deriveStandardTopologyInput({
    kind: 'clustered',
    prepared: prepared.value,
    transport: transport.value,
  });
  if (!lighting.ok) throw lighting.error;
  return lighting.value;
}

describe('forgeax::standard graph on a real WebGPU device', () => {
  it('reports float-chain failures without replacing the last-known-good surface', () => {
    const error = createRenderSurfaceError('sampled-read', {
      lane: 'clustered',
      stage: 'fxaa',
      target: 'standard-output-color',
      format: 'rgba16float',
      domain: 'display-encoded',
      endpoint: 'surface.storage',
      capability: 'float-sampled-read',
    });
    expect(error.code).toBe('surface-sampled-read-failed');
    expect(error.detail.target).toBe('standard-output-color');
  });

  it('compiles the clustered profile with real texture and binding formats', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device: RhiDevice = (
      await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
    ).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: clusteredStandardLighting(),
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      topology(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.inspect().passes.map((pass) => pass.kind)).toContain('compute');
    }
  });

  it('reads back GPU membership and proves equality with the Prepared canonical list', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device: RhiDevice = (await adapter.requestDevice()).unwrap();
    const frame = {
      directional: undefined,
      local: [
        { kind: 'point' as const, shadowed: false, position: vec3.create(-0.8, 0, -4), range: 2 },
        { kind: 'spot' as const, shadowed: false, position: vec3.create(0.8, 0, -6), range: 3 },
      ],
      view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
      projection: mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 32 as const,
      renderPath: 'deferred' as const,
    };
    const prepared = prepareStandardLighting(frame);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const { layout, clusterGrid, lightBounds, lightIndexList, membershipEntryCount } =
      prepared.value;

    const module = await createShaderModule(device, {
      code: STANDARD_CLUSTER_MEMBERSHIP_WGSL,
      label: 'standard-cluster-membership-readback',
    });
    expect(module.ok).toBe(true);
    if (!module.ok) return;
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'standard-cluster-membership-readback-bgl',
      entries: [
        { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    expect(bindGroupLayout.ok).toBe(true);
    if (!bindGroupLayout.ok) return;
    const pipelineLayout = device.createPipelineLayout({
      label: 'standard-cluster-membership-readback-pl',
      bindGroupLayouts: [bindGroupLayout.value],
    });
    expect(pipelineLayout.ok).toBe(true);
    if (!pipelineLayout.ok) return;
    const pipeline = device.createComputePipeline({
      label: 'standard-cluster-membership-readback',
      layout: pipelineLayout.value,
      compute: { module: module.value, entryPoint: 'cs_cluster_membership' },
    });
    expect(pipeline.ok).toBe(true);
    if (!pipeline.ok) return;

    const clusterGridBuffer = device.createBuffer({
      label: 'standard-cluster-readback-grid',
      size: layout.clusterGridU32Length * 4,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    const lightIndexBuffer = device.createBuffer({
      label: 'standard-cluster-readback-list',
      size: layout.lightIndexListCapacity * 4,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    });
    const boundsBuffer = device.createBuffer({
      label: 'standard-cluster-readback-bounds',
      size: lightBounds.byteLength,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    const uniformBuffer = device.createBuffer({
      label: 'standard-cluster-readback-uniform',
      size: 32,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    const readbackSize = Math.max(4, membershipEntryCount * 4);
    const readbackBuffer = device.createBuffer({
      label: 'standard-cluster-membership-readback-copy',
      size: readbackSize,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });
    expect(
      clusterGridBuffer.ok &&
        lightIndexBuffer.ok &&
        boundsBuffer.ok &&
        uniformBuffer.ok &&
        readbackBuffer.ok,
    ).toBe(true);
    if (
      !clusterGridBuffer.ok ||
      !lightIndexBuffer.ok ||
      !boundsBuffer.ok ||
      !uniformBuffer.ok ||
      !readbackBuffer.ok
    )
      return;

    const uniformData = new ArrayBuffer(32);
    new Uint32Array(uniformData, 0, 4).set([
      layout.grid.x,
      layout.grid.y,
      layout.grid.z,
      frame.local.length,
    ]);
    new Float32Array(uniformData, 16, 4).set([
      frame.near,
      frame.far,
      Math.log(frame.far / frame.near),
      0,
    ]);
    expect(device.queue.writeBuffer(clusterGridBuffer.value, 0, clusterGrid)).toMatchObject({
      ok: true,
    });
    expect(device.queue.writeBuffer(boundsBuffer.value, 0, lightBounds)).toMatchObject({
      ok: true,
    });
    expect(device.queue.writeBuffer(uniformBuffer.value, 0, uniformData)).toMatchObject({
      ok: true,
    });
    const bindings = device.createBindGroup({
      label: 'standard-cluster-membership-readback-bg',
      layout: bindGroupLayout.value,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: clusterGridBuffer.value } } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: lightIndexBuffer.value } } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer: uniformBuffer.value } } },
        { binding: 3, resource: { kind: 'buffer', value: { buffer: boundsBuffer.value } } },
      ],
    });
    expect(bindings.ok).toBe(true);
    if (!bindings.ok) return;
    const encoder = device.createCommandEncoder({ label: 'standard-cluster-membership-readback' });
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    const pass = encoder.value.beginComputePass();
    pass.setPipeline(pipeline.value);
    pass.setBindGroup(0, bindings.value);
    pass.dispatchWorkgroups(Math.ceil((layout.grid.x * layout.grid.y * layout.grid.z) / 64));
    pass.end();
    encoder.value.copyBufferToBuffer(
      lightIndexBuffer.value,
      0,
      readbackBuffer.value,
      0,
      readbackSize,
    );
    const finished = encoder.value.finish();
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(device.queue.submit([finished.value])).toMatchObject({ ok: true });
    await device.queue.onSubmittedWorkDone();
    const mapped = await readbackBuffer.value.mapAsync(1);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const range = mapped.value.getMappedRange();
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    const gpuList = new Uint32Array(range.value.slice(0, membershipEntryCount * 4));
    expect(Array.from(gpuList)).toEqual(Array.from(lightIndexList.slice(0, membershipEntryCount)));
    mapped.value.unmap();
  }, 30_000);
});
