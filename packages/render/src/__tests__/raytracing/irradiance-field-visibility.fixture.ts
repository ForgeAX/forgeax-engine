import {
  buildMeshDistanceField,
  buildVisibilityDistanceField,
  createBoxGeometry,
  type MeshDistanceField,
} from '@forgeax/engine-geometry';
import type { RhiCommandEncoder, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import {
  type GlobalSdfCompositionInputs,
  packGlobalSdfComposition,
  prepareGlobalSdfCompositionRecorder,
} from '../../raytracing/global-sdf';
import { createGlobalSdfBuffers } from '../../raytracing/global-sdf-buffers';
import { createGlobalSdfTexture } from '../../raytracing/global-sdf-texture';
import {
  createSdfSceneTextureProjection,
  packSdfSceneTexture,
  planSdfSceneTexture,
  SDF_SCENE_TEXTURE_PROJECT_WGSL,
} from '../../raytracing/sdf-scene-texture';

/** Raw-device fixtures execute the actual production projection, not a hand-authored header. */
export async function canonicalVisibilityPublisher(device: GPUDevice) {
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: SDF_SCENE_TEXTURE_PROJECT_WGSL }),
      entryPoint: 'projectSdfScene',
    },
  });
  return (
    source: Parameters<typeof packGlobalSdfComposition>[0],
    grid: Parameters<typeof packGlobalSdfComposition>[1],
  ) => {
    const epoch = 1;
    const packed = packGlobalSdfComposition(source, grid, { sourceEpoch: epoch }).unwrap();
    const plan = planSdfSceneTexture(
      packed.data.instances.byteLength,
      packed.data.fields.byteLength,
      source.length,
      {
        maxTextureDimension2D: device.limits.maxTextureDimension2D,
        maxBytes: 16 * 1024 * 1024,
      },
    ).unwrap();
    const owned: GPUBuffer[] = [];
    const upload = (bytes: Uint8Array, uniform = false) => {
      const buffer = device.createBuffer({
        size: Math.max(4, bytes.byteLength),
        usage: (uniform ? 64 : 128) | 12,
      });
      owned.push(buffer);
      if (bytes.byteLength > 0) device.queue.writeBuffer(buffer, 0, bytes);
      return buffer;
    };
    const settings = upload(packed.data.settings, true);
    const instances = upload(packed.data.instances),
      fields = upload(packed.data.fields);
    const parameterWords = packSdfSceneTexture(plan, epoch).unwrap();
    const parameters = upload(
      new Uint8Array(parameterWords.buffer, parameterWords.byteOffset, parameterWords.byteLength),
      true,
    );
    const texture = device.createTexture({
      size: [plan.width, plan.height],
      format: 'rgba32uint',
      usage: 4 | 8,
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: instances } },
        { binding: 1, resource: { buffer: fields } },
        { binding: 2, resource: { buffer: parameters } },
        { binding: 3, resource: texture.createView() },
      ],
    });
    return {
      packed,
      settings,
      view: texture.createView(),
      record(encoder: GPUCommandEncoder) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        const count = Math.ceil(plan.texels / 64),
          x = Math.min(count, device.limits.maxComputeWorkgroupsPerDimension);
        const y = Math.ceil(count / x);
        if (y > device.limits.maxComputeWorkgroupsPerDimension)
          throw new Error('canonical visibility dispatch exceeds the device limit');
        pass.dispatchWorkgroups(x, y);
        pass.end();
      },
      dispose() {
        for (const buffer of owned) buffer.destroy();
        texture.destroy();
      },
    };
  };
}

/** A finite closed wall covers the original analytic grid; opacity is fixture-declared. */
export async function visibilityPlaneField(axis: 0 | 1, span = 8): Promise<MeshDistanceField> {
  const mesh = createBoxGeometry(axis === 0 ? 0.04 : span, axis === 1 ? 0.04 : span, span).unwrap();
  if (!(mesh.attributes.position instanceof Float32Array) || mesh.indices === undefined)
    throw new Error('visibility plane requires complete indexed float32 geometry');
  return (
    await buildVisibilityDistanceField(mesh.attributes.position, mesh.indices, {
      voxelSize: 0.125,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
}

/** The same indexed wall retains its original noncanonical field as a negative control. */
export async function visibilityWallFields(): Promise<{
  field: MeshDistanceField;
  signedSolid: MeshDistanceField;
}> {
  const mesh = createBoxGeometry(3, 3, 0.25).unwrap();
  if (!(mesh.attributes.position instanceof Float32Array) || mesh.indices === undefined)
    throw new Error('the canonical wall requires indexed float32 positions');
  const signedSolid = (
    await buildMeshDistanceField(mesh.attributes.position, mesh.indices, { resolution: 32 })
  ).unwrap();
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position, mesh.indices, {
      voxelSize: signedSolid.spacing,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
  return { field, signedSolid };
}

/** One frozen controlled source feeds both visibility representations and their
 * independently expected epoch. This is not a SceneField publication. */
export async function createVisibilityControl(
  device: RhiDevice,
  modules: { compose: ShaderModule; coarse: ShaderModule; canonical: ShaderModule },
  source: Parameters<typeof packGlobalSdfComposition>[0],
  grid: Parameters<typeof packGlobalSdfComposition>[1],
) {
  const epoch = 1;
  const packed = packGlobalSdfComposition(source, grid, { sourceEpoch: epoch }).unwrap();
  const allocation = createGlobalSdfBuffers(device, 'visibility-control', packed.data).unwrap();
  let canonical: Awaited<ReturnType<typeof createSdfSceneTextureProjection>> | undefined;
  let coarse: Awaited<ReturnType<typeof createGlobalSdfTexture>> | undefined;
  const dispose = () => {
    if (coarse !== undefined) device.destroyTexture(coarse.texture);
    canonical?.dispose();
    allocation.dispose();
  };
  try {
    const input = Object.fromEntries(
      Object.entries(allocation.buffers).map(([name, buffer]) => [
        name,
        { buffer, size: packed.data[name as keyof typeof packed.data].byteLength },
      ]),
    ) as GlobalSdfCompositionInputs;
    const composition = (
      await prepareGlobalSdfCompositionRecorder(device, modules.compose)
    ).unwrap();
    canonical = await createSdfSceneTextureProjection(
      device,
      modules.canonical,
      input,
      source.length,
      epoch,
    );
    coarse = await createGlobalSdfTexture(device, modules.coarse, { grid: packed.grid, input });
    const scene = canonical,
      visibility = coarse;
    return {
      input,
      canonical: scene,
      visibility,
      packed,
      bindings: [
        { binding: 4, resource: { kind: 'buffer' as const, value: input.settings } },
        { binding: 5, resource: { kind: 'textureView' as const, value: visibility.view } },
        { binding: 6, resource: { kind: 'textureView' as const, value: scene.view } },
      ],
      record(encoder: RhiCommandEncoder) {
        const compose = encoder.beginComputePass();
        try {
          composition.record(compose, input, packed.voxelCount).unwrap();
        } finally {
          compose.end();
        }
        const project = encoder.beginComputePass();
        try {
          scene.record(project).unwrap();
          project.setPipeline(visibility.pipeline);
          project.setBindGroup(0, visibility.group);
          project.dispatchWorkgroups(Math.ceil(packed.voxelCount / 64));
        } finally {
          project.end();
        }
      },
      dispose,
    };
  } catch (cause) {
    dispose();
    throw cause;
  }
}
