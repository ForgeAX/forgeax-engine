import { mat4 } from '@forgeax/engine-math';
import type { BindGroupLayoutEntry } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { writeMeshSsboBuffer } from '../assembly/mesh-ssbo-grow';
import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import { GpuBuffer } from '../gpu-resource';
import { createSkylightFallback } from '../ibl/skylight-bind-group';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { MESH_PER_ENTITY_STRIDE } from '../record/mesh-ssbo';
import {
  type _InternalRenderPipelineContext,
  MATERIAL_PER_ENTITY_STRIDE,
  MATERIAL_UNIFORM_BYTES,
} from '../record/render-context';
import {
  buildMatchedMaterialHandlesByRenderable,
  buildMatchedRenderableIndices,
  createShadowDispatchProjectionOwner,
  recordShadowCasterDraws,
  resolveShadowDispatchProjection,
  shadowShaderMap,
} from '../record/shadow-pass';
import type { DispatchEntry, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { nativeDeviceFixture } from './native-device-fixture';

// Real residual recording and dynamic material offsets, not a PBR lighting surrogate.
// The depth witness also makes two wrong-but-equal empty images fail independently.
const WITNESS = `
struct Material { depth: vec4<f32> }
struct Mesh { world: mat4x4<f32> }
@group(1) @binding(0) var<uniform> material: Material;
@group(2) @binding(0) var<uniform> mesh: Mesh;
@vertex fn vs_witness(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  let world = mesh.world * vec4<f32>(p, 1.0);
  return vec4<f32>(world.xy, material.depth.x, 1.0);
}
`;
const WIDTH = 32,
  HEIGHT = 16,
  ROW_FLOATS = 64;
const SHADER = 'test::shared-roster-depth-witness';
function planes(side: -1 | 0 | 1): Float32Array {
  const value = new Float32Array(24);
  value[0] = side;
  return value;
}
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing witness input');
  return value;
}

async function fixture() {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    const fallback = createSkylightFallback(device, device.queue);
    const meshBuffer = device
      .createBuffer({ size: MESH_PER_ENTITY_STRIDE * 2, usage: 64 | 128 | 8 })
      .unwrap();
    const materialBuffer = device
      .createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE * 2, usage: 64 | 8 })
      .unwrap();
    for (let slot = 0; slot < 2; slot++)
      device.queue
        .writeBuffer(
          materialBuffer,
          slot * MATERIAL_PER_ENTITY_STRIDE,
          Float32Array.of(slot === 0 ? 0.25 : 0.75, 0, 0, 0),
        )
        .unwrap();
    const identityInstance = device.createBuffer({ size: 64, usage: 128 | 8 }).unwrap();
    device.queue
      .writeBuffer(identityInstance, 0, new Float32Array(mat4.identity(mat4.create())))
      .unwrap();
    const vertex = new GpuBuffer(device, device.createBuffer({ size: 36, usage: 32 | 8 }).unwrap());
    device.queue
      .writeBuffer(vertex.handle, 0, Float32Array.of(-0.16, -0.16, 0, 0.16, -0.16, 0, 0, 0.16, 0))
      .unwrap();
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const entries: BindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: 1,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MATERIAL_UNIFORM_BYTES },
      },
      { binding: 1, visibility: 2, texture: { viewDimension: 'cube', sampleType: 'float' } },
      { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 3, visibility: 2, texture: { viewDimension: 'cube', sampleType: 'float' } },
      { binding: 4, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 5, visibility: 2, texture: { viewDimension: '2d', sampleType: 'float' } },
      { binding: 6, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 47, visibility: 2, texture: { viewDimension: 'cube', sampleType: 'float' } },
    ];
    if (transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage))
      entries.push(
        { binding: 7, visibility: 2, sampler: { type: 'filtering' } },
        { binding: 8, visibility: 2, texture: { viewDimension: '2d', sampleType: 'float' } },
      );
    if (device.caps.storageBuffer)
      entries.push({ binding: 46, visibility: 1 | 2, buffer: { type: 'read-only-storage' } });
    const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
    const materialLayout = device.createBindGroupLayout({ entries }).unwrap();
    const meshLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 1,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
          },
        ],
      })
      .unwrap();
    const instanceLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 1, buffer: { type: 'read-only-storage', minBindingSize: 64 } },
        ],
      })
      .unwrap();
    const layout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instanceLayout],
      })
      .unwrap();
    const module = (await rhi.createShaderModule(device, { code: WITNESS })).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_witness',
          buffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      })
      .unwrap();
    const meshGroup = device
      .createBindGroup({
        layout: meshLayout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: meshBuffer, offset: 0, size: 64 } },
          },
        ],
      })
      .unwrap();
    const target = device
      .createTexture({
        size: { width: WIDTH, height: HEIGHT },
        format: 'depth32float',
        textureBindingViewDimension: '2d',
        usage: 16 | 1,
      })
      .unwrap();
    const targetView = device.createTextureView(target, {}).unwrap();
    const readback = device.createBuffer({ size: 256 * HEIGHT, usage: 1 | 8 }).unwrap();
    const materials = [100, 200].map(
      (materialHandle) =>
        ({
          materialHandle,
          materialShaderId: SHADER,
          baseColor: Float32Array.of(1, 1, 1),
          metallic: 0,
          roughness: 1,
        }) as MaterialSnapshot,
    );
    const rows = materials.map((material, renderableIndex) => {
      const world = mat4.identity(mat4.create());
      world[12] = renderableIndex === 0 ? -0.5 : 0.5;
      const source = {
        entityKey: renderableIndex + 1,
        worldId: 0,
        material,
        materials: [material],
        transform: { world },
        localAabb: Float32Array.of(-0.16, -0.16, 0, 0.16, 0.16, 0),
        gpuDrivenDraws: [
          {
            kind: 'non-indexed',
            first: 0,
            count: 3,
            materialSlot: 0,
            topology: 'triangle-list',
            drawItemIndex: 0,
          },
        ],
      } as unknown as RenderableSnapshot;
      return {
        renderableIndex,
        source,
        mesh: {
          vertexBuffer: vertex,
          indexed: false,
          indexBuffer: null,
          layoutProjection: { attributes: [] },
          submeshes: [
            {
              topology: 'triangle-list',
              materialSlot: 0,
              vertexCount: 3,
              indexCount: 0,
              indexOffset: 0,
            },
          ],
        },
      };
    });
    const dispatch = materials.map(
      (material, renderableIndex) =>
        ({
          renderableIndex,
          materialHandle: defined(material.materialHandle),
          entityIndex: renderableIndex,
          queue: 2000,
          layer: 0,
          renderState: undefined,
          defines: undefined,
          fragmentEntry: undefined,
          paramSnapshot: undefined,
          materialShaderId: SHADER,
          passIndex: 0,
          tags: { LightMode: 'ShadowCaster' },
          vertexEntry: 'vs_witness',
        }) as DispatchEntry,
    );
    const scene = new RenderScene();
    scene.rebuild(rows.map((row) => row.source));
    const pipelineRequests: unknown[][] = [];
    const context = {
      shadowCasterBounds: (source: RenderableSnapshot) => scene.cullingWorldBounds(source),
      dispatch,
      validatedOrdered: rows,
      materialSlotIndices: [[0], [1]],
      materialSlots: materials,
      shadowCasterMembership: materials.map((material, renderableIndex) => ({
        worldEntity: renderableIndex + 1,
        renderableIndex,
        drawItemIndex: 0,
        materialHandle: material.materialHandle,
        passIndex: 0,
        materialShaderId: SHADER,
        gpuDrivenEligible: true,
      })),
      runtime: {
        device,
        getMaterialShaderPipeline: (...args: unknown[]) => {
          pipelineRequests.push(args);
          return pipeline;
        },
        getParamSchema: () => [],
        getMaterialBindGroupLayout: () => materialLayout,
        errorRegistry: {
          fire(error: unknown) {
            throw error;
          },
        },
      },
      world: { identity: 'shared-roster-depth-world' },
      store: { materialResourceEpoch: 0 },
      pipelineState: {
        skylightFallback: fallback,
        identityInstanceBuffer: identityInstance,
        instancesBindGroupLayout: instanceLayout,
        materialBindGroupLayout: materialLayout,
        materialUniformBuffer: { buffer: materialBuffer },
        meshStorageBuffer: { buffer: meshBuffer },
        defaultSampler: fallback.sampler,
        defaultWhiteTextureView: fallback.brdfLutView,
        defaultNormalTextureView: fallback.brdfLutView,
        fallbackTextureView: fallback.brdfLutView,
      },
      frameState: { materialBgShared: new Map(), instancesBgShared: new WeakMap() },
      materialBgAssemblyCache: new MaterialBgAssemblyCache(),
      bindGroupCounts: { createBindGroup: 0, keys: [] },
      skylightCount: 0,
    } as unknown as _InternalRenderPipelineContext;
    return {
      device,
      native,
      scene,
      context,
      pipelineRequests,
      pipeline,
      viewGroup,
      meshGroup,
      target,
      targetView,
      readback,
      close() {
        native.destroy();
      },
    };
  } catch (error) {
    native.destroy();
    throw error;
  }
}

async function depth(
  f: Awaited<ReturnType<typeof fixture>>,
  c: _InternalRenderPipelineContext,
  side: -1 | 0 | 1,
  shared: boolean,
  claimed?: ReadonlySet<string>,
  reflected = false,
  terrainReceiver?: { readonly worldId: number; readonly entityKey: number },
) {
  // Slot offsets use current canonical row order even after a retire/reinsert.
  for (const [index, row] of c.validatedOrdered.entries()) {
    const matrix = row.source.transform.world;
    writeMeshSsboBuffer(
      f.device.queue,
      c.pipelineState.meshStorageBuffer,
      index * MESH_PER_ENTITY_STRIDE,
      new Uint8Array(matrix.buffer, matrix.byteOffset, matrix.byteLength),
    );
  }
  const projection = shared
    ? resolveShadowDispatchProjection(c)
    : {
        matchedIndices: buildMatchedRenderableIndices(c.shadowDispatch ?? c.dispatch, {
          LightMode: ['ShadowCaster'],
        }),
        matchedMaterialHandles: buildMatchedMaterialHandlesByRenderable(
          c.shadowDispatch ?? c.dispatch,
          { LightMode: ['ShadowCaster'] },
        ),
        shaders: shadowShaderMap(c),
      };
  const encoder = f.device.createCommandEncoder().unwrap();
  const pass = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: f.targetView,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
  });
  pass.setPipeline(f.pipeline);
  pass.setBindGroup(0, f.viewGroup);
  const { shadowDispatchProjection: _owner, ...unsharedContext } = c;
  const recorded = recordShadowCasterDraws(
    shared ? c : unsharedContext,
    pass,
    f.pipeline,
    f.meshGroup,
    projection.matchedIndices,
    projection.matchedMaterialHandles,
    projection.shaders,
    claimed,
    reflected,
    planes(side),
    false,
    terrainReceiver,
  );
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: f.target, aspect: 'depth-only' },
    { buffer: f.readback, bytesPerRow: 256, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await f.device.queue.onSubmittedWorkDone();
  const mapped = (await f.readback.mapAsync(1)).unwrap();
  const bytes = mapped.getMappedRange().unwrap().slice(0);
  mapped.unmap();
  const validation = await f.native.popErrorScope();
  f.native.pushErrorScope('validation');
  expect(validation, validation?.message).toBeNull();
  return { pixels: new Float32Array(bytes), recorded };
}

async function compare(
  f: Awaited<ReturnType<typeof fixture>>,
  c: _InternalRenderPipelineContext,
  side: -1 | 0 | 1,
  expected: readonly [number, number],
  claimed?: ReadonlySet<string>,
  pixelRow = 8,
) {
  const old = await depth(f, c, side, false, claimed),
    next = await depth(f, c, side, true, claimed);
  expect(next.pixels).toEqual(old.pixels);
  expect(next.recorded).toEqual(old.recorded);
  expect([next.pixels[pixelRow * ROW_FLOATS + 8], next.pixels[pixelRow * ROW_FLOATS + 24]]).toEqual(
    expected,
  );
  for (const key of claimed ?? []) expect(next.recorded.has(key)).toBe(false);
  return next;
}

describe('shared shadow roster projection on Dawn', () => {
  it('retains distinct topology per submesh and re-prepares a replaced roster entry', async () => {
    const f = await fixture();
    try {
      const c = f.context;
      const row = defined(c.validatedOrdered[0]);
      const submesh = defined(row.mesh.submeshes[0]);
      Object.assign(row.mesh, {
        submeshes: [submesh, { ...submesh, topology: 'triangle-strip' }],
      });
      Object.assign(c, { shadowDispatchProjection: createShadowDispatchProjectionOwner(c) });
      for (let cascade = 0; cascade < 3; cascade++) await depth(f, c, 0, true);
      expect(f.pipelineRequests).toHaveLength(3);
      expect(f.pipelineRequests.slice(0, 2).map((request) => request[3])).toEqual([
        'triangle-list',
        'triangle-strip',
      ]);
      Object.assign(c, { validatedOrdered: [{ ...row }, defined(c.validatedOrdered[1])] });
      const result = await depth(f, c, 0, true);
      expect(f.pipelineRequests).toHaveLength(5);
      expect([result.pixels[8 * ROW_FLOATS + 8], result.pixels[8 * ROW_FLOATS + 24]]).toEqual([
        0.25, 0.75,
      ]);
      expect(await f.native.popErrorScope()).toBeNull();
    } finally {
      f.close();
    }
  });

  it('keeps terrain receiver front-cull distinct from normal and reflected caster pipelines', async () => {
    const f = await fixture();
    try {
      const source = defined(f.context.validatedOrdered[0]).source;
      // This witness needs only the terrain role; geometry and depth remain native.
      Object.assign(source, { terrain: {} });
      const c = f.context;
      Object.assign(c, { shadowDispatchProjection: createShadowDispatchProjectionOwner(c) });
      await depth(f, c, 0, true);
      const receiver = { worldId: source.worldId, entityKey: source.entityKey };
      await depth(f, c, 0, true, undefined, false, receiver);
      await depth(f, c, 0, true, undefined, false, receiver);
      expect(f.pipelineRequests).toHaveLength(3);
      expect(f.pipelineRequests[2]?.[2]).toEqual({ cullMode: 'front' });
      await depth(f, c, 0, true, undefined, true, receiver);
      await depth(f, c, 0, true, undefined, true, receiver);
      expect(f.pipelineRequests).toHaveLength(5);
      expect(f.pipelineRequests[3]?.[2]).toEqual({ cullMode: 'front', frontFace: 'cw' });
      expect(f.pipelineRequests[4]?.[2]).toEqual({ frontFace: 'cw' });
      expect(await f.native.popErrorScope()).toBeNull();
    } finally {
      f.close();
    }
  });

  it('prepares each visible caster pipeline once per frame and reflection state', async () => {
    const f = await fixture();
    try {
      const c = f.context;
      Object.assign(c, { shadowDispatchProjection: createShadowDispatchProjectionOwner(c) });
      for (let cascade = 0; cascade < 3; cascade++) {
        const result = await depth(f, c, 0, true);
        expect([result.pixels[8 * ROW_FLOATS + 8], result.pixels[8 * ROW_FLOATS + 24]]).toEqual([
          0.25, 0.75,
        ]);
      }
      expect(f.pipelineRequests).toHaveLength(2);
      await depth(f, c, 0, true, undefined, true);
      await depth(f, c, 0, true, undefined, true);
      expect(f.pipelineRequests).toHaveLength(4);
      expect(f.pipelineRequests.slice(2).map((request) => request[2])).toEqual([
        { frontFace: 'cw' },
        { frontFace: 'cw' },
      ]);

      // Another record re-observes pipeline ownership, even with identical rows.
      Object.assign(c, { shadowDispatchProjection: createShadowDispatchProjectionOwner(c) });
      await depth(f, c, 0, true);
      expect(f.pipelineRequests).toHaveLength(6);
      // An overridden view may have another runtime/device despite sharing rows.
      await depth(f, { ...c }, 0, true);
      expect(f.pipelineRequests).toHaveLength(8);
      expect(await f.native.popErrorScope()).toBeNull();
    } finally {
      f.close();
    }
  });

  it('preserves independent cascade depth, per-view claims, slot changes and roster fallback', async () => {
    const f = await fixture();
    try {
      const c = f.context;
      const owner = createShadowDispatchProjectionOwner(c);
      Object.assign(c, { shadowDispatchProjection: owner });
      await compare(f, c, -1, [0.25, 0]);
      await compare(f, c, 1, [0, 0.75]);
      await compare(f, c, 0, [0.25, 0.75]);
      const first = resolveShadowDispatchProjection(c);
      const leftClaim = new Set([gpuDrivenShadowDrawKey(1, 100, 0, 0)]);
      const rightClaim = new Set([gpuDrivenShadowDrawKey(2, 200, 0, 0)]);
      await compare(f, c, 0, [0, 0.75], leftClaim);
      await compare(f, c, 0, [0.25, 0], rightClaim);
      expect(resolveShadowDispatchProjection(c)).toBe(first);

      // The same record owner refuses a view with a different slot layout.
      const differentView = {
        ...c,
        materialSlotIndices: [[1], [0]],
        materialSlots: [defined(c.materialSlots[1]), defined(c.materialSlots[0])],
      };
      await compare(f, differentView, 0, [0.75, 0.25]);
      expect(resolveShadowDispatchProjection(differentView)).not.toBe(first);
      // A new record owns mutated inputs and never inherits the old projection.
      Object.assign(differentView, {
        shadowDispatchProjection: createShadowDispatchProjectionOwner(differentView),
      });
      await compare(f, differentView, -1, [0.75, 0]);
      await compare(f, differentView, 1, [0, 0.25]);

      const leftGeneration = defined(f.scene.slot(0, 1)).generation;
      f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
      expect(f.scene.slot(0, 1)).toBeUndefined();
      const onlyRight = {
        ...c,
        dispatch: [defined(c.dispatch[1])],
        validatedOrdered: [defined(c.validatedOrdered[1])],
        materialSlotIndices: [[1]],
        shadowCasterMembership: [defined(c.shadowCasterMembership?.[1])],
      };
      expect(resolveShadowDispatchProjection(onlyRight)).not.toBe(first);
      await compare(f, onlyRight, 0, [0, 0.75]);
      const replacementLeft = {
        ...defined(c.validatedOrdered[0]),
        source: { ...defined(c.validatedOrdered[0]).source, entityKey: 3 },
      };
      f.scene.apply([
        { kind: 'update', worldId: 0, entityKey: 3, snapshot: replacementLeft.source },
      ]);
      expect(defined(f.scene.slot(0, 3)).generation).not.toBe(leftGeneration);
      const reinserted = {
        ...c,
        validatedOrdered: [replacementLeft, defined(c.validatedOrdered[1])],
        shadowCasterMembership: [
          { ...defined(c.shadowCasterMembership?.[0]), worldEntity: 3 },
          defined(c.shadowCasterMembership?.[1]),
        ],
      };
      Object.assign(reinserted, {
        shadowDispatchProjection: createShadowDispatchProjectionOwner(reinserted),
      });
      await compare(f, reinserted, 0, [0.25, 0.75]);
      // A retired entity's claim cannot suppress its replacement identity.
      await compare(f, reinserted, 0, [0.25, 0.75], leftClaim);
      const movingRows = reinserted.validatedOrdered.map((row) => {
        const world = new Float32Array(row.source.transform.world);
        world[13] = 0.3;
        return { ...row, source: { ...row.source, transform: { world } } };
      });
      f.scene.rebuild(movingRows.map((row) => row.source));
      const movingRecord = { ...reinserted, validatedOrdered: movingRows };
      Object.assign(movingRecord, {
        shadowDispatchProjection: createShadowDispatchProjectionOwner(movingRecord),
      });
      await compare(f, movingRecord, 0, [0.25, 0.75], undefined, 5);
      await compare(f, movingRecord, 0, [0, 0]);
      expect(await f.native.popErrorScope()).toBeNull();
    } finally {
      f.close();
    }
  });

  it('prepares fresh resources and slot ownership on another real device', async () => {
    const f = await fixture();
    try {
      Object.assign(f.context, {
        shadowDispatchProjection: createShadowDispatchProjectionOwner(f.context),
      });
      await compare(f, f.context, 0, [0.25, 0.75]);
      expect(await f.native.popErrorScope()).toBeNull();
    } finally {
      f.close();
    }
  });
});
