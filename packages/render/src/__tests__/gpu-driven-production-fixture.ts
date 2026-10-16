import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { BindGroupLayout, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { RhiNullDevice } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import type { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { PipelineState } from '../record/render-context';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';

const receipt = createStandardPbrArtifactReceipt();
const materialShaderId = 'forgeax::default-standard-pbr';
const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });

/** Receipt-backed fixture for tests of scene identity and raster resource routing. */
export function preparedPbrSnapshot(source: RenderableSnapshot): RenderableSnapshot {
  const material = { ...source.material, materialShaderId: materialShaderId };
  return {
    ...source,
    material,
    materials: source.materials.map((value) => ({ ...value, materialShaderId: materialShaderId })),
    gpuDrivenDraws: (source.gpuDrivenDraws ?? []).map((draw) => ({
      ...draw,
      pipelineClass: `${materialShaderId}|${draw.topology}|rigid`,
      materialResourceClass: 'standard-pbr-resources',
      prepared: {
        identity: { material: materialShaderId, geometry: 'fixture', deformation: 'rigid' },
        receiptGeneration: receipt.generation,
        directEntry: receipt.directEntry,
        sceneIndexEntry: receipt.sceneIndexEntry,
        materialRow: receipt.materialRow,
        resourceSlots: receipt.resourceSlots,
        uvSets: receipt.uvSets,
        vertexInputs: receipt.vertexInputs,
        alphaMask: receipt.alphaMask,
        skinPaletteAddress: receipt.skinPaletteAddress,
        topology: draw.topology,
        indexed: draw.kind === 'indexed',
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
      },
    })),
  };
}

export function standardPbrInputs(
  device: RhiDevice,
  shader: ShaderModule,
  viewLayout: BindGroupLayout,
): Pick<
  Parameters<GpuDrivenProduction['prepare']>[0],
  'standardPbrArtifact' | 'standardPbrPipelineState'
> {
  const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const meshLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } }],
    })
    .unwrap();
  const instancesLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 1, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const pbrPipelineLayout = device
    .createPipelineLayout({
      bindGroupLayouts: [viewLayout, materialLayout, meshLayout, instancesLayout],
    })
    .unwrap();
  const programKey = standardPbrProgramKey(materialShaderId);
  if (programKey === undefined) throw new Error(`unsupported fixture material ${materialShaderId}`);
  const artifact = {
    material: materialShaderId,
    pass: 'forward',
    program: createMaterialShaderProgram('synthetic'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: receipt.vertexInputs as unknown as readonly Readonly<Record<string, unknown>>[],
    receipt,
  };
  return {
    standardPbrArtifact: artifact,
    // These tests stop before material binding; only the raster layout is consumed.
    standardPbrPipelineState: {
      pbrPipelineLayout,
      meshBindGroupLayout: meshLayout,
      instancesBindGroupLayout: instancesLayout,
      gpuDrivenInstancesBindGroupLayout: instancesLayout,
      gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
      standardPbrShaderModule: shader,
      gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
      standardPbrShaderUvSetCount: 1,
    } as unknown as PipelineState,
  };
}

export function snapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([0.25 * entityKey, 0.5, 0.75]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: EMPTY_RESOURCE_CLASS,
      },
    ],
  };
}

export function preparedSnapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  return preparedPbrSnapshot(snapshot(entityKey, assetHandle));
}

export function withoutPrepared(
  draw: NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number],
): Omit<typeof draw, 'prepared'> {
  const { prepared, ...rest } = draw;
  void prepared;
  return rest;
}

export function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

export function mesh(device: RhiNullDevice, indexed = true, withLod = false): MeshGpuHandles {
  const vertex = device
    .createBuffer({
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = indexed
    ? device
        .createBuffer({
          size: 8,
          usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap()
    : null;
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: index === null ? null : new GpuBuffer(device, index),
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: indexed ? 8 : 0,
    indexCount: indexed ? 3 : 0,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
    ...(withLod
      ? {
          lodRanges: [
            [{ first: 0, count: 3, baseVertex: 0 }],
            [{ first: 3, count: 1, baseVertex: 0 }],
          ],
        }
      : {}),
  };
}
