import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Buffer } from '@forgeax/engine-rhi';
import {
  type MaterialAsset,
  type MeshAsset,
  type SamplerAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardProbeGlobal } from '../pipeline/standard-profile';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { CardCaptureSlice } from './card-capture-schedule';
import {
  createGlobalSdfCompositionRecorder,
  GLOBAL_SDF_COMPOSE_WGSL,
  type GlobalSdfCompositionInputs,
  type GlobalSdfGrid,
  packGlobalSdfComposition,
} from './global-sdf';
import {
  createGlobalSdfQueryRecorder,
  GLOBAL_SDF_QUERY_WGSL,
  packGlobalSdfQuerySettings,
} from './global-sdf-query';
import { createIndexAllocator, type IndexAllocator } from './index-allocator';
import {
  createProbeOriginSupportRecorder,
  PROBE_ORIGIN_SUPPORT_WGSL,
} from './probe-origin-support';
import { createProbeRayRecorder, PROBE_RAYS_WGSL } from './probe-rays';
import { type ProbeCardCapture, prepareProbeCards } from './renderer-probe-cards';
import {
  projectSceneFields,
  type SceneFieldSource,
  sceneFieldSourcesCurrent,
} from './scene-field-projection';
import { SDF_INSTANCE_STRIDE, type SdfMeshInstance } from './sdf-query';

export interface ProbeGlobalSource {
  readonly scene: PersistentGpuDrivenState;
  readonly worlds: readonly RenderResourceScope[];
  readonly leases: readonly RenderReadLease[] | undefined;
}
export interface ProbeGlobalRegion {
  readonly retained: NonNullable<PersistentGpuDrivenState['retained']>;
  readonly catalogEpoch: number;
  readonly sources: readonly SceneFieldSource[];
  /** The projected instance rows behind `input`, indexed by Global instance id. */
  readonly instances: readonly SdfMeshInstance[];
  readonly grid: GlobalSdfGrid;
  readonly input: GlobalSdfCompositionInputs;
  readonly cards?: ProbeCardCapture;
  readonly voxelCount: number;
  readonly lifetime: ResidencyLifetime;
  readonly compose: Extract<
    ReturnType<typeof createGlobalSdfCompositionRecorder>,
    { ok: true }
  >['value']['record'];
  readonly query: Extract<
    ReturnType<typeof createGlobalSdfQueryRecorder>,
    { ok: true }
  >['value']['record'];
  readonly rays: Extract<
    ReturnType<typeof createProbeRayRecorder>,
    { ok: true }
  >['value']['record'];
  readonly support: Extract<
    ReturnType<typeof createProbeOriginSupportRecorder>,
    { ok: true }
  >['value']['record'];
  /** Becomes true on actual physical submission, independently of publication. */
  composed: boolean;
  /** Present when the region was sized for in-place instance adds. */
  readonly headroom?: ProbeGlobalHeadroom;
}
/**
 * Spare Global SDF rows and field words behind an editable region. Freed rows are
 * reused; field words only grow. Exhausting either means the caller rebuilds.
 */
export interface ProbeGlobalHeadroom {
  readonly rows: IndexAllocator;
  /** Field word high-water mark and its fixed capacity. */
  fieldWords: number;
  readonly fieldCapacity: number;
  /** Cooked field -> word offset, so instances of one mesh share their samples. */
  readonly fieldOffsets: Map<object, number>;
  readonly geometryIds: Map<object, number>;
  /** Live instance count written to settings.w (the composition loop bound). */
  instanceCount: number;
}
export interface ProbeGlobalBuffers {
  readonly rays: Buffer;
  readonly hits: Buffer;
  readonly emission: Buffer;
  readonly diagnostics: Buffer;
  readonly raySettings: Buffer;
  readonly querySettings: Buffer;
}
export interface PreparedProbeCards {
  readonly region: ProbeCardCapture;
  /** This frame's Card capture slice; absent once every tile is captured. */
  readonly captureSlice: CardCaptureSlice | undefined;
  readonly candidates: Buffer;
  readonly samples: Buffer;
  readonly diagnostics: Buffer;
  /** Records {@link captureSlice} (clearing an edited slice first) into the atlas pass. */
  readonly capture: (
    pass: Parameters<ProbeCardCapture['capture']['clearTiles']>[0],
  ) => ReturnType<ProbeCardCapture['capture']['recordPass']>;
  readonly lookup: ProbeCardCapture['lookup'];
  readonly support: ProbeCardCapture['support'];
}
export interface PreparedProbeGlobal extends ProbeGlobalBuffers {
  readonly cards?: PreparedProbeCards;
  readonly region: ProbeGlobalRegion;
  readonly rayCount: number;
  readonly resolution: number;
  readonly composeRequired: boolean;
  readonly compose: ProbeGlobalRegion['compose'];
  readonly emit: ProbeGlobalRegion['rays'];
  readonly query: ProbeGlobalRegion['query'];
  readonly support: ProbeGlobalRegion['support'];
}

/** Cheap producer identity key, including unavailable material projections so
 * repaired admission can retry without any new mutation clock or geometry scan. */
export function probeGlobalSourceReferences(
  source: ProbeGlobalSource,
  runtime: RenderSystemInternals,
): readonly unknown[] {
  const retained = source.scene.retained;
  if (retained === undefined)
    throw new Error('Global probe queries require retained source identity');
  const refs: unknown[] = [
    retained.identity,
    retained.revision,
    runtime.assets.catalogEpoch,
    ...retained.worlds,
  ];
  for (const slot of retained.slots) {
    if (slot.snapshot.authorVisible === false) continue;
    const scope = source.worlds[slot.worldId];
    if (scope === undefined) {
      refs.push(undefined);
      continue;
    }
    const mesh = resolveAssetHandle<MeshAsset>(scope, toShared(slot.snapshot.assetHandle));
    refs.push(mesh.ok ? mesh.value : undefined, mesh.ok ? mesh.value.distanceField : undefined);
    for (const material of slot.snapshot.materials) {
      if (material === undefined) continue;
      refs.push(material.materialHandle);
      if (runtime.standardProfile?.probePlacement?.global?.cards !== undefined) {
        const card = material.materialSurfacePrograms?.['card-capture'];
        const artifact =
          card === undefined
            ? undefined
            : runtime.shaderRegistry?.findMaterialArtifact(card.programKey);
        refs.push(card?.programKey, artifact?.ok ? artifact.value : undefined);
        for (const handles of [material.textureHandles, material.samplerHandles]) {
          for (const handle of handles?.values() ?? []) {
            const payload = resolveAssetHandle<TextureAsset | SamplerAsset>(scope, handle);
            refs.push(handle, payload.ok ? payload.value : undefined);
          }
        }
      }
      if (material.materialHandle === undefined) continue;
      const handle = toShared<'MaterialAsset'>(material.materialHandle);
      const raw =
        'resolveAsset' in scope
          ? resolveAssetHandle<MaterialAsset>(scope, handle)
          : scope.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(handle);
      const payload = raw.ok ? raw : resolveAssetHandle<MaterialAsset>(scope, handle);
      const effective = resolveAssetHandle<MaterialAsset>(scope, handle);
      refs.push(
        payload.ok ? payload.value : undefined,
        effective.ok ? effective.value : undefined,
        payload.ok ? runtime.assets.getMaterialProjectionForPayload(payload.value) : undefined,
      );
    }
  }
  return refs;
}

/** Relevant immutable source comparison. Time/camera packet revisions do not
 * trigger field projection; current mesh/material payloads still must resolve. */
export function probeGlobalRegionCurrent(
  region: ProbeGlobalRegion,
  source: ProbeGlobalSource,
  runtime: RenderSystemInternals,
): boolean {
  const retained = source.scene.retained;
  return (
    retained !== undefined &&
    retained.identity === region.retained.identity &&
    retained.revision === region.retained.revision &&
    retained.isCurrent() &&
    runtime.assets.catalogEpoch === region.catalogEpoch &&
    source.worlds.length === retained.worlds.length &&
    source.worlds.every((world, i) => world === retained.worlds[i]) &&
    sceneFieldSourcesCurrent(region.sources, runtime.assets) &&
    (region.cards === undefined || region.cards.current())
  );
}

/** Conservative frame-attempt fence over existing owner versions. It is never
 * the reusable region key and therefore cannot starve async preparation. */
export function probeGlobalAttemptCurrent(source: ProbeGlobalSource): () => boolean {
  const versions = source.worlds.map((world, index) => {
    if ('resolveAsset' in world) {
      if (!Number.isSafeInteger(world.revision) || world.revision < 1)
        throw new Error('probe Global source has no accepted receiver revision');
      const revision = world.revision;
      return () => world.revision === revision;
    }
    const lease = source.leases?.[index];
    if (lease === undefined || lease.worldIdentity !== world.identity)
      throw new Error('probe Global source requires its current Renderer World lease');
    const captured = lease.captureVersion();
    return () => {
      const current = lease.captureVersion();
      return (
        current.mutationEpoch === captured.mutationEpoch &&
        current.structureEpoch === captured.structureEpoch
      );
    };
  });
  return () => {
    try {
      return (
        source.scene.retained?.isCurrent() === true &&
        source.scene.retained.isSourceCurrent() &&
        versions.every((current) => current())
      );
    } catch {
      return false;
    }
  };
}

/** Provision one frozen region. The caller owns admission, reuse, submission and
 * retirement; this function never publishes or submits an independent frame. */
export async function prepareProbeGlobalRegion(
  runtime: RenderSystemInternals,
  source: ProbeGlobalSource,
  profile: StandardProbeGlobal,
  /** Size rows, field words and Card atlas tiles for in-place adds up to the profile budgets. */
  editable = false,
  /** View focus that ranks the initially resident Cards of an editable region. */
  focus?: readonly [number, number, number],
): Promise<ProbeGlobalRegion> {
  const retained = source.scene.retained;
  if (
    retained === undefined ||
    !retained.isCurrent() ||
    source.worlds.length !== retained.worlds.length ||
    source.worlds.some((world, i) => world !== retained.worlds[i])
  )
    throw new Error('probe Global source requires the complete current retained composition');
  const projected = projectSceneFields(
    retained.slots,
    source.worlds,
    profile,
    runtime.assets,
  ).unwrap();
  const packed = packGlobalSdfComposition(projected.instances, profile.grid).unwrap();
  // Validate query-specific spacing/dimensions before allocating the region.
  packGlobalSdfQuerySettings(packed.grid, profile).unwrap();
  const compile = runtime.createShaderModule;
  if (compile === undefined)
    throw new Error('probe Global preparation requires the Renderer shader module adapter');
  const device = runtime.device;
  const catalogEpoch = runtime.assets.catalogEpoch;
  const owned: Buffer[] = [];
  let cards: ProbeCardCapture | undefined;
  const lifetime = new ResidencyLifetime(() => {
    for (const buffer of owned) device.destroyBuffer(buffer);
    cards?.release();
  });
  const count = projected.instances.length;
  const rows = editable ? Math.max(count, Math.min(1024, profile.maxInstances)) : count;
  const words = packed.data.fields.byteLength / 4;
  const fieldCapacity = editable
    ? Math.max(words, Math.min(4_194_304, words + Math.ceil(profile.maxFieldBytes / 4)))
    : words;
  const sizes: Partial<Record<keyof typeof packed.data, number>> = editable
    ? {
        instances: Math.max(1, rows) * SDF_INSTANCE_STRIDE,
        bounds: Math.max(1, rows) * 48,
        fields: fieldCapacity * 4,
      }
    : {};
  let headroom: ProbeGlobalHeadroom | undefined;
  if (editable) {
    const view = new DataView(
      packed.data.instances.buffer,
      packed.data.instances.byteOffset,
      packed.data.instances.byteLength,
    );
    const fieldOffsets = new Map<object, number>();
    const geometryIds = new Map<object, number>();
    for (const s of projected.sources) {
      const offset = view.getUint32(s.firstInstance * SDF_INSTANCE_STRIDE + 80, true);
      if (offset !== 0xffffffff) fieldOffsets.set(s.field, offset);
      const instance = projected.instances[s.firstInstance];
      if (instance !== undefined) geometryIds.set(s.mesh, instance.geometryId);
    }
    headroom = {
      rows: createIndexAllocator(Math.max(1, rows), count),
      fieldWords: words,
      fieldCapacity,
      fieldOffsets,
      geometryIds,
      instanceCount: count,
    };
  }
  try {
    const input = Object.fromEntries(
      Object.entries(packed.data).map(([name, data]) => {
        const size = Math.max(data.byteLength, sizes[name as keyof typeof packed.data] ?? 0);
        const buffer = device
          .createBuffer({
            label: `probe-global.${name}`,
            size,
            usage: (name === 'settings' ? 64 : 128) | 12,
          })
          .unwrap();
        owned.push(buffer);
        // Headroom rows stay zero: mask 0 skips them in every instance loop.
        let bytes = data;
        if (size > data.byteLength) {
          bytes = new Uint8Array(size);
          bytes.set(data);
        }
        device.queue.writeBuffer(buffer, 0, bytes).unwrap();
        return [name, { buffer, size }];
      }),
    ) as unknown as GlobalSdfCompositionInputs;
    if (profile.cards !== undefined)
      cards = await prepareProbeCards(
        runtime,
        projected.sources,
        projected.instances,
        packed.sources,
        profile.cards,
        editable,
        focus,
      );
    const compileKernel = async (name: string, code: string) =>
      (await compile(device, { label: `probe-global.${name}`, code })).unwrap();
    const [compositionModule, queryModule, raysModule, supportModule] = await Promise.all([
      compileKernel('compose', GLOBAL_SDF_COMPOSE_WGSL),
      compileKernel('query', GLOBAL_SDF_QUERY_WGSL),
      compileKernel('rays', PROBE_RAYS_WGSL),
      compileKernel('origin-support', PROBE_ORIGIN_SUPPORT_WGSL),
    ]);
    return {
      retained,
      catalogEpoch,
      ...(cards === undefined ? {} : { cards }),
      sources: projected.sources,
      instances: projected.instances,
      grid: packed.grid,
      input,
      voxelCount: packed.voxelCount,
      lifetime,
      composed: false,
      compose: createGlobalSdfCompositionRecorder(device, compositionModule).unwrap().record,
      query: createGlobalSdfQueryRecorder(device, queryModule).unwrap().record,
      rays: createProbeRayRecorder(device, raysModule).unwrap().record,
      support: createProbeOriginSupportRecorder(device, supportModule).unwrap().record,
      ...(headroom === undefined ? {} : { headroom }),
    };
  } catch (cause) {
    lifetime.retire();
    throw cause;
  }
}
