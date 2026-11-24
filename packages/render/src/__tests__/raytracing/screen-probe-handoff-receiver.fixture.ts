import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import type { MeshDistanceField } from '@forgeax/engine-types';
import { packFieldReceiverGpuSource } from '../../raytracing/field-receiver-texture';
import { screenProbeReceiverWgsl } from '../../raytracing/screen-probe-receiver';
import { packSdfScene } from '../../raytracing/sdf-query';
import { packWorldBoundsPool } from '../../raytracing/world-bounds-pool';
import { createProbeGlobalMesh } from './probe-global.fixture';

/** The original receiver point is strictly inside this separate, single primitive. */
export async function handoffReceiverField(): Promise<
  MeshDistanceField & { surface: NonNullable<MeshDistanceField['surface']> }
> {
  return (
    await buildVisibilityDistanceField(
      new Float32Array([-4, -3, 0.5, 4, -3, 0.5, 0, 5, 0.5]),
      new Uint32Array([0, 1, 2]),
      { voxelSize: 0.25, triangleSidedness: new Uint8Array(1) },
    )
  ).unwrap();
}

export function handoffReceiverView(side: number) {
  // Receivers use pixel0/7. The thin wall stays between pixel centers in both views.
  const view = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  view[0] = 0.75;
  view[12] = side * 0.5;
  view[13] = 0.75;
  return view;
}

export function handoffReceiverDirection(side: number, tangent: boolean) {
  if (tangent) return [-side, 0, 0];
  const length = Math.sqrt(65);
  return [-side * Math.fround(8 / length), 0, Math.fround(1 / length)];
}

export function handoffSourceKind(mode: string): 'wall' | 'no-wall' | 'missing' {
  if (mode === 'no-wall') return 'no-wall';
  if (mode === 'missing') return 'missing';
  return 'wall';
}

type ReceiverFrame = {
  readonly pixel: number;
  readonly expected: readonly [number, number, number, number];
  readonly frame: number;
  readonly revision: number;
  readonly grid: GPUBuffer;
  readonly instances: { readonly buffer: GPUBuffer; readonly size: number };
  readonly fields: { readonly buffer: GPUBuffer; readonly size: number };
  readonly probes: GPUBuffer;
  readonly uniform: GPUBuffer;
};

/** Borrow the existing test device: actual receiver raster depth and production
 * canonical preparation share one View and one source. This controlled identity
 * producer is not the ordinary GBuffer material/raster acceptance gate. */
export async function createHandoffReceiver(
  device: GPUDevice,
  view: GPUBuffer,
  depth: GPUTexture,
  field: Awaited<ReturnType<typeof handoffReceiverField>>,
  first: ReceiverFrame,
  buffers: GPUBuffer[],
  textures: GPUTexture[],
) {
  const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const source = (input: ReceiverFrame) =>
    packFieldReceiverGpuSource(
      [
        {
          rasterRow: 1,
          canonicalRow: 1,
          primitiveFirst: 0,
          primitiveCount: 1,
          forward: identity,
          receiverProof: 'opaque-primitive',
        },
      ],
      1,
      input.expected,
      input.frame,
      input.revision,
      { maxTextureDimension2D: device.limits.maxTextureDimension2D, maxBytes: 4096 },
    ).unwrap();
  const initial = source(first);
  const receiverSource = device.createTexture({
    size: [initial.width, initial.height],
    format: 'rgba32uint',
    usage: 2 | 4,
  });
  const visibleSurface = device.createTexture({ size: [8, 4], format: 'rgba32uint', usage: 2 | 4 });
  textures.push(receiverSource, visibleSurface);
  const vertexBuffer = device.createBuffer({
    size: field.surface.positions.byteLength,
    usage: 8 | 32,
  });
  buffers.push(vertexBuffer);
  device.queue.writeBuffer(vertexBuffer, 0, field.surface.positions);
  const raster = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: {
      module: device.createShaderModule({
        code: `@group(0) @binding(0) var<uniform> vp:mat4x4f;
@vertex fn receiverVertex(@location(0) p:vec3f)->@builtin(position) vec4f{return vp*vec4f(p,1);}`,
      }),
      entryPoint: 'receiverVertex',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  });
  const rasterGroup = device.createBindGroup({
    layout: raster.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: view, size: 64 } }],
  });
  const prepare = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: screenProbeReceiverWgsl() }),
      entryPoint: 'prepareScreenReceivers',
    },
  });
  return {
    visible: visibleSurface.createView(),
    source: receiverSource.createView(),
    record(encoder: GPUCommandEncoder, input: ReceiverFrame) {
      const packet = source(input);
      if (packet.width !== initial.width || packet.height !== initial.height)
        throw new Error('receiver source shape changed');
      device.queue.writeTexture(
        { texture: receiverSource },
        packet.words,
        { bytesPerRow: packet.width * 16 },
        [packet.width, packet.height],
      );
      const visible = new Uint32Array(8 * 4 * 4);
      visible.set([1, 0, 0, 1], input.pixel * 4);
      device.queue.writeTexture(
        { texture: visibleSurface },
        visible,
        { bytesPerRow: 8 * 16 },
        [8, 4],
      );
      const draw = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      draw.setPipeline(raster);
      draw.setBindGroup(0, rasterGroup);
      draw.setVertexBuffer(0, vertexBuffer);
      draw.draw(3);
      draw.end();
      const entries: GPUBindGroupEntry[] = [
        { binding: 1, resource: { buffer: input.grid } },
        { binding: 2, resource: input.instances },
        { binding: 3, resource: input.fields },
        { binding: 6, resource: { buffer: input.probes } },
        { binding: 9, resource: { buffer: input.uniform } },
        { binding: 17, resource: visibleSurface.createView() },
        { binding: 18, resource: receiverSource.createView() },
        { binding: 19, resource: { buffer: view, size: 64 } },
      ];
      const pass = encoder.beginComputePass();
      pass.setPipeline(prepare);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: prepare.getBindGroupLayout(0), entries }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
    },
  };
}

export async function handoffWallInput(transform: readonly number[]): Promise<{
  mesh: Awaited<ReturnType<typeof createProbeGlobalMesh>>;
  receiverField: Awaited<ReturnType<typeof handoffReceiverField>>;
  scenes: Record<
    'wall' | 'no-wall' | 'missing',
    ReturnType<ReturnType<typeof packSdfScene>['unwrap']> & {
      bounds: Uint8Array;
      expected: readonly [number, number, number, number];
    }
  >;
}> {
  const mesh = await createProbeGlobalMesh(0.04, 4, 4);
  if (!mesh.distanceField || !mesh.aabb)
    throw new Error('Thin wall requires a real Mesh SDF and mesh AABB');
  const wallField = mesh.distanceField,
    receiverField = await handoffReceiverField();
  const bounds = new Float32Array(24);
  bounds.set(mesh.aabb.subarray(0, 3));
  bounds.set(mesh.aabb.subarray(3, 6), 4);
  bounds.set([1, 1, 1, 1], 8);
  bounds.set([-4, -3, 0.5], 12);
  bounds.set([4, 5, 0.5], 16);
  bounds.set([1, 1, 1, 1], 20);
  const make = (kind: 'wall' | 'no-wall' | 'missing', epoch: number) => {
    const scene = packSdfScene(
      [
        {
          instanceId: 1,
          geometryId: 1,
          mask: kind === 'no-wall' ? 0 : 255,
          transform,
          surfaceCoverage: 'opaque',
          field: kind === 'missing' ? { missing: true, bounds: wallField.bounds } : wallField,
        },
        {
          instanceId: 2,
          geometryId: 2,
          mask: 255,
          transform,
          surfaceCoverage: 'opaque',
          field: receiverField,
        },
      ],
      1024,
      2,
      epoch,
    ).unwrap();
    const pool = packWorldBoundsPool(new Uint8Array(bounds.buffer), scene.instances, 2, {
      maxBytes: 4096,
      rowCapacity: 2,
      index: false,
      candidateRadius: 0.5,
    }).unwrap().bytes;
    return {
      ...scene,
      bounds: pool,
      expected: [scene.instances.byteLength / 4, scene.fields.byteLength / 4, 2, epoch] as const,
    };
  };
  return {
    mesh,
    receiverField,
    scenes: { wall: make('wall', 1), 'no-wall': make('no-wall', 2), missing: make('missing', 3) },
  };
}
