import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import type { BindGroupLayout, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import type { MeshGpuHandles } from '../device/gpu-residency';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { standardPbrProgramKey } from '../gpu-driven/pbr-program';
import type { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import type { PipelineState } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';
import { MaterialDispatch } from '../scene/material-dispatch';
import { SceneSlots } from '../scene/scene-slots';

const receipt = createStandardPbrArtifactReceipt();
const materialShaderId = 'forgeax::default-standard-pbr';
const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });

/** Receipt-backed fixture for tests of scene identity and raster resource routing. */
export function preparedPbrSnapshot(
  source: Omit<RenderableSnapshot, 'gpuDrivenDraws'> & {
    readonly gpuDrivenDraws?: readonly (Omit<
      NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number],
      'geometry'
    > &
      Partial<Pick<NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number], 'geometry'>>)[];
  },
): RenderableSnapshot {
  const prepareMaterial = (value: MaterialResource) =>
    new MaterialResource({
      ...value.snapshot,
      materialShaderId,
      passes: value.snapshot.passes?.length
        ? value.snapshot.passes
        : [
            {
              name: 'forward',
              program: { module: materialShaderId },
              renderState: { ...value.snapshot.renderState, tags: { LightMode: 'Forward' } },
            },
          ],
      materialProgramKeys: value.snapshot.materialProgramKeys ?? { forward: materialShaderId },
    });
  const material = prepareMaterial(source.material);
  return {
    ...source,
    material,
    materials: source.materials.map((value) =>
      value === source.material ? material : prepareMaterial(value),
    ),
    gpuDrivenDraws: (source.gpuDrivenDraws ?? []).map((draw) => ({
      ...draw,
      pipelineClass: `${materialShaderId}|${draw.topology}|rigid`,
      materialResourceClass: 'standard-pbr-resources',
      geometry: {
        receipt: {
          identity: 'fixture',
          vertexInputs: receipt.vertexInputs,
          topology: draw.topology,
          indexed: draw.kind === 'indexed',
        },
        draw: {
          kind: draw.kind,
          first: draw.first,
          count: draw.count,
          baseVertex: draw.baseVertex,
          topology: draw.topology,
        },
        deformation: 'rigid',
      },
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
  'materialArtifact' | 'materialPipelineState'
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
    materialArtifact: artifact,
    // These tests stop before material binding; only the raster layout is consumed.
    materialPipelineState: {
      pbrPipelineLayout,
      meshBindGroupLayout: meshLayout,
      instancesBindGroupLayout: instancesLayout,
      gpuDrivenInstancesBindGroupLayout: instancesLayout,
      gpuDrivenPbrPipelineLayout: pbrPipelineLayout,
      gpuDrivenPbrPrograms: new Map([[programKey, { module: shader, artifact }]]),
      standardPbrShaderUvSetCount: 1,
    } as unknown as PipelineState,
  };
}

export function snapshot(entityKey: number, assetHandle: number): RenderableSnapshot {
  const material = new MaterialResource({
    baseColor: vec3.create(0.25 * entityKey, 0.5, 0.75),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
    passes: [],
  });
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
        geometry: {
          receipt: {
            identity: 'fixture',
            vertexInputs: receipt.vertexInputs,
            topology: 'triangle-list',
            indexed: true,
          },
          draw: { kind: 'indexed', first: 0, count: 3, baseVertex: 0, topology: 'triangle-list' },
          deformation: 'rigid',
        },
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

export function mesh(device: RhiDevice, indexed = true, withLod = false): MeshGpuHandles {
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

/** The fixture enters the same shared material/geometry admission as the Renderer. */
export function admitGpuFixture(
  input: Omit<
    Parameters<GpuDrivenProduction['prepare']>[0],
    'batchExecutions' | 'meshByBinding'
  > & {
    readonly meshBySlot?: ReadonlyMap<number, MeshGpuHandles>;
    readonly batchExecutions?: Parameters<GpuDrivenProduction['prepare']>[0]['batchExecutions'];
    readonly meshByBinding?: Parameters<GpuDrivenProduction['prepare']>[0]['meshByBinding'];
  },
): Parameters<GpuDrivenProduction['prepare']>[0] {
  const dispatch = new MaterialDispatch();
  const slots = input.scene?.slots ?? [];
  const meshes = new Map<string, MeshGpuHandles>();
  for (const slot of slots) {
    if (slot === undefined) continue;
    dispatch.bind(slot.slot, slot.snapshot);
    const mesh = input.meshBySlot?.get(slot.slot);
    if (mesh !== undefined) meshes.set(`${slot.worldId}:${slot.snapshot.assetHandle}`, mesh);
  }
  const slotOwner = new SceneSlots();
  for (const slot of slots) slotOwner.set(slot.slot, slot);
  const slotFrame = slotOwner.capture();
  const selected =
    input.batchExecutions === undefined
      ? collectGpuDrivenMaterialArtifacts({
          batches: input.scene?.plan.batches ?? [],
          programs: new GpuDrivenMaterialProgramProjection().project(
            dispatch.query(slotFrame),
            dispatch.materials(),
          ),
          resolve: (id, request) => {
            const shadow = typeof request === 'object' && request.pass === 'shadow';
            const table = shadow ? input.shadowMaterialArtifacts : input.materialArtifacts;
            return table === undefined ? input.materialArtifact : table.get(id);
          },
          clustered: input.clustered ?? false,
          reflectionFallback: false,
          probeBlend: input.probeBlendRecordBuffer !== undefined,
          shadowViews: input.shadowViews ?? false,
        })
      : {
          batchExecutions: input.batchExecutions,
          materialArtifacts: input.materialArtifacts ?? new Map(),
          shadowMaterialArtifacts: input.shadowMaterialArtifacts ?? new Map(),
        };
  const meshByBinding = new Map<
    import('../gpu-driven/batch-topology').GpuDrivenBatchBinding,
    MeshGpuHandles
  >();
  for (const batch of input.scene?.plan.batches ?? []) {
    const binding = batch.binding;
    if (binding === undefined) throw new Error('Missing shared fixture binding');
    const mesh = meshes.get(`${binding.worldId}:${binding.assetHandle}`);
    if (mesh !== undefined) meshByBinding.set(binding, mesh);
  }
  return {
    ...input,
    shadowViews: input.shadowViews ?? false,
    materialFrame: dispatch.materials(),
    batchExecutions: input.batchExecutions ?? selected.batchExecutions,
    materialArtifacts: selected.materialArtifacts,
    shadowMaterialArtifacts: selected.shadowMaterialArtifacts,
    meshByBinding: input.meshByBinding ?? meshByBinding,
  };
}
