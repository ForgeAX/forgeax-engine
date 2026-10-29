// Pure sizing, naming and declaration helpers of the GPU particle feature plan.

import type { RenderFeatureWorkPlan } from '@forgeax/engine-render';
import type { MeshAsset } from '@forgeax/engine-types';
import type { ParticleRendererSourceV3, VfxDataInterfaceResource } from '@forgeax/engine-vfx';
import { isParticleTopologyRenderer, VFX_PARTICLE_CORE_STRIDE } from '@forgeax/engine-vfx';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../../../render/src/features/prepared-graphics';
import { coalesceVfxComputePasses, coalesceVfxCopyPasses } from './compute-passes.js';
import { WORKGROUP_SIZE } from './emitter-program.js';
import type { ExtractedWorld, VfxGpuTickIntent } from './gpu-particle-feature.js';
import type { VfxArenaRange } from './instance-arena.js';
import { createTopologyResourcePlan } from './particle-resources.js';
import { rendererSortingMode } from './runtime-uniform.js';

type ParticleRenderer = ParticleRendererSourceV3;
export const BILLBOARD_INSTANCE_BYTES = 31 * 4;
export const MESH_INSTANCE_BYTES = 18 * 4;
export const COUNTERS_BYTES = 24;

export function maxRendererInputBytes(renderers: readonly ParticleRenderer[]): number {
  return Math.max(0, ...renderers.map((renderer) => (renderer.materialInputs?.length ?? 0) * 16));
}

/** Storage slabs [size, element stride] the batched compute program binds for one emitter. */
export function batchStorageSizes(
  emitter: VfxGpuTickIntent['emitter'],
  customStride: number,
  inputBytes: number,
): readonly [number, number][] {
  const capacity = emitter.capacity;
  return [
    [capacity * VFX_PARTICLE_CORE_STRIDE, VFX_PARTICLE_CORE_STRIDE],
    [capacity * customStride, customStride],
    [capacity * 4, 4],
    [COUNTERS_BYTES, 24],
    [Math.max(1, emitter.renderers.length) * 20, 20],
    [(capacity * 2 + Math.ceil(capacity / WORKGROUP_SIZE)) * 4, 4],
    [capacity * (Math.max(BILLBOARD_INSTANCE_BYTES, MESH_INSTANCE_BYTES) + inputBytes), 4],
  ];
}

/** Initial indirect draw arguments per renderer; undefined when a renderer's geometry is invalid. */
export function rendererIndirectWords(
  renderers: readonly ParticleRenderer[],
  meshes: readonly (MeshAsset | undefined)[],
): Uint32Array | undefined {
  const indirectWords = new Uint32Array(Math.max(1, renderers.length) * 5);
  for (let rendererIndex = 0; rendererIndex < renderers.length; rendererIndex++) {
    const renderer = renderers[rendererIndex] as (typeof renderers)[number];
    const mesh = meshes[rendererIndex];
    const submesh = renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
    if (renderer.kind === 'mesh' && submesh === undefined) return undefined;
    if (isParticleTopologyRenderer(renderer) && !createTopologyResourcePlan(renderer).ok)
      return undefined;
    indirectWords[rendererIndex * 5] =
      renderer.kind === 'mesh'
        ? mesh?.indices === undefined
          ? (submesh?.vertexCount ?? 0)
          : (submesh?.indexCount ?? 0)
        : 6;
    indirectWords[rendererIndex * 5 + 2] =
      renderer.kind === 'mesh' && mesh?.indices !== undefined ? (submesh?.indexOffset ?? 0) : 0;
  }
  return indirectWords;
}

export type DataInterfaceRequirement = NonNullable<
  VfxGpuTickIntent['emitter']['reflection']['dataInterfaces']
>[number];
export type RendererOwnedDataInterface = Exclude<DataInterfaceRequirement['kind'], 'force-fields'>;

/** Renderer-owned producer of a data interface without a resident provider payload. */
export function sharedDataInterfaceResource(
  entry: ExtractedWorld,
  name: string,
  kind: RendererOwnedDataInterface,
): PlanResource | undefined {
  switch (kind) {
    case 'camera':
      return {
        kind: 'buffer',
        name,
        size: 64,
        usage: ['uniform'],
        data: new Float32Array(entry.camera.viewProjection),
      };
    case 'scene-depth':
      return {
        kind: 'scene-depth',
        name,
        camera: {
          position: new Float32Array(entry.camera.position),
          right: new Float32Array(entry.camera.right),
          up: new Float32Array(entry.camera.up),
          viewProjection: new Float32Array(entry.camera.viewProjection),
        },
      };
    case 'noise':
      return { kind: 'scene-noise', name };
    case 'scene-sdf': {
      const descriptor = entry.sceneSdf;
      if (descriptor === undefined) return undefined;
      return { kind: 'scene-sdf', name, world: entry.sourceWorldIndex, descriptor };
    }
  }
}

/** A provider-resolved data interface imported under the group's name; undefined when malformed. */
export function preparedDataInterfaceResource(
  name: string,
  prepared: NonNullable<VfxDataInterfaceResource['resource']>,
): PlanResource | undefined {
  if (prepared.kind === 'buffer') {
    if (prepared.size === undefined || prepared.size <= 0) return undefined;
    return {
      kind: 'prepared-gpu-resource',
      name,
      resource: {
        kind: 'buffer',
        value: prepared.value,
        size: prepared.size,
        usage: prepared.usage === 'storage' ? ['storage'] : ['uniform'],
      },
    };
  }
  const external =
    prepared.kind === 'texture-view'
      ? { kind: 'texture-view' as const, value: prepared.value }
      : { kind: 'sampler' as const, value: prepared.value };
  return { kind: 'prepared-gpu-resource', name, resource: external };
}

export function fieldBufferName(prefix: string, revision: number): string {
  return `${prefix}.force-fields.${revision}`;
}

/** A retained arena range that a direct compute job must address. */
export function requiredRange(
  byName: ReadonlyMap<string, VfxArenaRange>,
  name: string,
  scope: 'simulation' | 'frame' | 'view',
): VfxArenaRange {
  const range = byName.get(name);
  if (range === undefined) throw new Error(`Missing direct ${scope} range: ${name}`);
  return range;
}

export type ComputeDispatch = Extract<PlanPass, { readonly kind: 'compute' }>['dispatches'][number];

function pushDirectDispatch(
  dispatches: ComputeDispatch[],
  entryPoints: ReadonlySet<string>,
  entryPoint: string,
  workgroups: number,
): void {
  if (!entryPoints.has(entryPoint)) return;
  dispatches.push({ kind: 'direct', entryPoint, workgroups: [Math.max(1, workgroups)] });
}

/** Projection entry points run only when the emitter's program declares them. */
export function projectionDispatches(
  renderer: ParticleRenderer,
  capacity: number,
  entryPoints: ReadonlySet<string>,
): ComputeDispatch[] {
  const dispatches: ComputeDispatch[] = [];
  if (rendererSortingMode(renderer) !== 0)
    pushDirectDispatch(dispatches, entryPoints, 'forgeax_vfx_sort_main', 1);
  if (renderer.kind === 'trail')
    pushDirectDispatch(dispatches, entryPoints, 'forgeax_vfx_trail_offsets_main', 1);
  const projectionCount =
    renderer.kind === 'trail'
      ? renderer.capacity * Math.max(1, renderer.historyLength - 1)
      : isParticleTopologyRenderer(renderer)
        ? renderer.capacity
        : capacity;
  pushDirectDispatch(
    dispatches,
    entryPoints,
    `forgeax_vfx_${renderer.kind}_main`,
    Math.ceil(projectionCount / WORKGROUP_SIZE),
  );
  return dispatches;
}

export type ParticleVertexLayout =
  (typeof RENDER_FEATURE_VERTEX_LAYOUTS)[keyof typeof RENDER_FEATURE_VERTEX_LAYOUTS];

/** Programs precede the declarations that reference them; names order the rest. */
const SHARED_DECLARATION_ORDER: Readonly<Record<string, number>> = {
  'graphics-program': 0,
  buffer: 1,
  'graphics-bindings': 2,
  'vertex-data': 3,
  'index-data': 4,
};
export function compareSharedDeclarations(
  left: { readonly kind: string; readonly name: string },
  right: { readonly kind: string; readonly name: string },
): number {
  const order =
    (SHARED_DECLARATION_ORDER[left.kind] ?? 5) - (SHARED_DECLARATION_ORDER[right.kind] ?? 5);
  if (order !== 0) return order;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export const NO_DATA_INTERFACES = Object.freeze({
  bindings: Object.freeze({}) as Record<number, string>,
  fieldBinding: undefined,
  resources: Object.freeze([]) as unknown as PlanResource[],
});

const VIEW_BINDING_VALUES = {
  none: Object.freeze({ group: 0 }),
  0: Object.freeze({ group: 0, sceneDepthBinding: 0 }),
  1: Object.freeze({ group: 0, sceneDepthBinding: 1 }),
} as const;
/** Frozen View/scene-depth group values shared by every particle draw of one slot. */
export function viewBindingValues(sceneDepthBinding: 0 | 1 | undefined) {
  return VIEW_BINDING_VALUES[sceneDepthBinding ?? 'none'];
}

const VERTEX_LAYOUT_IDS = new Map<ParticleVertexLayout, number>(
  Object.values(RENDER_FEATURE_VERTEX_LAYOUTS).map((layout, index) => [layout, index]),
);
export function vertexLayoutId(layout: ParticleVertexLayout): number {
  const id = VERTEX_LAYOUT_IDS.get(layout);
  if (id === undefined) throw new Error('Unknown particle vertex layout');
  return id;
}

export function particleVertexLayout(
  renderer: ParticleRenderer,
  hasParticleInputs: boolean,
): ParticleVertexLayout {
  if (renderer.kind === 'billboard')
    return hasParticleInputs
      ? RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance
      : RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance;
  if (isParticleTopologyRenderer(renderer))
    return hasParticleInputs
      ? RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance
      : RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance;
  return hasParticleInputs
    ? RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance
    : RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance;
}

/** Projected instance storage: one record per topology vertex or per particle. */
export function particleInstanceBytes(
  renderer: ParticleRenderer,
  capacity: number,
  inputBytes: number,
  topologyVertexBytes: number | undefined,
): number {
  if (isParticleTopologyRenderer(renderer)) {
    const vertexCount = Math.max(1, Math.floor((topologyVertexBytes ?? 16) / 48));
    return vertexCount * (48 + inputBytes);
  }
  return (
    capacity *
    ((renderer.kind === 'billboard' ? BILLBOARD_INSTANCE_BYTES : MESH_INSTANCE_BYTES) + inputBytes)
  );
}

/** Mesh renderers draw their submesh's vertex or index range. */
export function meshDrawRange(
  renderer: ParticleRenderer,
  mesh: MeshAsset | undefined,
  submesh: MeshAsset['submeshes'][number] | undefined,
): { readonly count: number; readonly firstIndex: number } | undefined {
  if (renderer.kind !== 'mesh' || submesh === undefined) return undefined;
  return {
    count: mesh?.indices === undefined ? submesh.vertexCount : submesh.indexCount,
    firstIndex: mesh?.indices === undefined ? 0 : submesh.indexOffset,
  };
}

export type PlanResource = RenderFeatureWorkPlan['resources'][number];
export type PlanPass = RenderFeatureWorkPlan['passes'][number];
export type RasterPass = Extract<PlanPass, { kind: 'raster' }>;
export type RasterDraw = RasterPass['draws'][number];

/** Merge compatible compute and copy passes of one work list in place. */
export function coalesceComputeWork(
  work: PlanPass[],
  privatePrograms: ReadonlySet<string>,
  bindings: Parameters<typeof coalesceVfxComputePasses>[2],
): void {
  const computes = coalesceVfxComputePasses(work, privatePrograms, bindings);
  const batched = coalesceVfxCopyPasses(computes);
  if (batched === work) return;
  work.length = 0;
  for (const pass of batched) work.push(pass);
}

export function planName(value: string, maxLength = 24): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9.-]/g, '-');
  return (normalized.length === 0 ? 'unnamed' : normalized).slice(0, maxLength);
}

export function computeBindingEntries(
  intent: Pick<VfxGpuTickIntent, 'emitter'>,
  resources: Readonly<Record<number, string>>,
): readonly { readonly binding: number; readonly resource: string }[] {
  const declared = new Set(
    (intent.emitter.reflection.bindings[0]?.entries ?? [])
      .filter(
        (entry) =>
          entry.buffer !== undefined ||
          entry.texture !== undefined ||
          entry.sampler !== undefined ||
          entry.storageTexture !== undefined,
      )
      .map((entry) => entry.binding),
  );
  return Object.entries(resources).flatMap(([binding, resource]) =>
    declared.has(Number(binding)) ? [{ binding: Number(binding), resource }] : [],
  );
}

/**
 * Stable small ids for strings that name shared declarations (plan names are
 * short lowercase identifiers). Ids are never reused; bounding the table only
 * gives a later declaration a fresh name.
 */
export function createInterner(limit = 4096): (value: string) => number {
  const ids = new Map<string, number>();
  let next = 0;
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      if (ids.size >= limit) ids.clear();
      id = next++;
      ids.set(value, id);
    }
    return id;
  };
}
