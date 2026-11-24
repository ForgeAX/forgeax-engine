import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Buffer } from '@forgeax/engine-rhi';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { StandardProbeGlobal } from '../pipeline/standard-profile';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { CardCaptureSlice } from './card-capture-schedule';
import {
  type createGlobalSdfCompositionRecorder,
  GLOBAL_SDF_COMPOSE_WGSL,
  type GlobalSdfCompositionInputs,
  type GlobalSdfGrid,
  packGlobalSdfComposition,
  prepareGlobalSdfCompositionRecorder,
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
  SceneFieldRows,
  type SceneFieldSource,
  sceneFieldSourceEpoch,
} from './scene-field-projection';
import { SDF_INSTANCE_STRIDE, type SdfMeshInstance } from './sdf-query';
import type { SdfSurfacePlacement } from './sdf-surface-storage';
import type { CardCapturePhase } from './surface-cards';
import {
  WORLD_BOUNDS_HEADER_BYTES,
  WORLD_BOUNDS_POOL_MAX_BYTES,
  WORLD_BOUNDS_ROW_BYTES,
  type WorldBoundsIndexCoverage,
} from './world-bounds-pool';

export interface ProbeGlobalSource {
  readonly scene: PersistentGpuDrivenState;
  readonly sourceScope: RenderResourceScope;
  readonly lease: RenderReadLease | undefined;
}
/** One immutable CPU image of the canonical placement generation. Mesh regions are shared facts. */
export interface ProbeGlobalPlacementSnapshot {
  readonly instances: readonly SdfMeshInstance[];
  readonly instanceData: Uint8Array;
  readonly surface: SdfSurfacePlacement;
  readonly boundsIndex?: {
    readonly sourceEpoch: number;
    readonly coverage: WorldBoundsIndexCoverage;
  };
}
export interface ProbeGlobalRegion {
  readonly retained: NonNullable<PersistentGpuDrivenState['retained']>;
  /** {@link SceneFieldRows.revision} of the roster this region composes. */
  readonly fieldRevision: number;
  readonly sources: readonly SceneFieldSource[];
  /** The projected instance rows behind `input`, indexed by Global instance id. */
  readonly instances: readonly SdfMeshInstance[];
  /** Region-owned current image; publication replaces it, never mutating held snapshots. */
  readonly placement: { current: ProbeGlobalPlacementSnapshot };
  readonly grid: GlobalSdfGrid;
  readonly input: GlobalSdfCompositionInputs;
  readonly cards?: ProbeCardCapture;
  readonly voxelCount: number;
  readonly lifetime: ResidencyLifetime;
  readonly compose: Extract<
    Awaited<ReturnType<typeof createGlobalSdfCompositionRecorder>>,
    { ok: true }
  >['value']['record'];
  readonly query: Extract<
    Awaited<ReturnType<typeof createGlobalSdfQueryRecorder>>,
    { ok: true }
  >['value']['record'];
  readonly rays: Extract<
    Awaited<ReturnType<typeof createProbeRayRecorder>>,
    { ok: true }
  >['value']['record'];
  readonly support: Extract<
    Awaited<ReturnType<typeof createProbeOriginSupportRecorder>>,
    { ok: true }
  >['value']['record'];
  /** Becomes true on actual physical submission, independently of publication. */
  composed: boolean;
  /** Reserved canonical allocation facts; additions require a complete rebuild. */
  readonly headroom?: ProbeGlobalHeadroom;
}
/**
 * Spare allocation behind an editable region. The versioned surface pool still
 * requires a complete rebuild for additions or geometry changes. Removal keeps
 * its row as a zero-mask tombstone rather than compacting canonical addresses.
 */
interface ProbeGlobalHeadroom {
  readonly rows: IndexAllocator;
  /** Field word high-water mark and its fixed capacity. */
  fieldWords: number;
  readonly fieldCapacity: number;
  /** Canonical row high-water mark written to settings.w, including tombstones. */
  instanceCount: number;
}
interface ProbeGlobalBuffers {
  readonly rays: Buffer;
  readonly hits: Buffer;
  readonly emission: Buffer;
  readonly diagnostics: Buffer;
  readonly raySettings: Buffer;
  readonly querySettings: Buffer;
}
interface PreparedProbeCards {
  readonly region: ProbeCardCapture;
  /** This frame's Card capture slice; absent once every tile is captured. */
  readonly captureSlice: CardCaptureSlice | undefined;
  readonly candidates: Buffer;
  readonly samples: Buffer;
  readonly diagnostics: Buffer;
  /** Records {@link captureSlice} (clearing an edited slice first) into the atlas pass. */
  readonly capture: (
    pass: Parameters<ProbeCardCapture['capture']['clearTiles']>[0],
    phase: CardCapturePhase,
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

/** Region identity: the composition and its field roster revision. Scene edits
 * that change no field input (unrelated rows, poses of non-field rows) keep it. */
export function probeGlobalSourceReferences(
  source: ProbeGlobalSource,
  fieldRevision: number,
): readonly unknown[] {
  const retained = source.scene.retained;
  if (retained === undefined)
    throw new Error('Global probe queries require retained source identity');
  return [retained.identity, fieldRevision];
}

/** Relevant immutable source comparison. Time/camera packet revisions do not
 * trigger field projection; current mesh/material payloads still must resolve. */
export function probeGlobalRegionCurrent(
  region: ProbeGlobalRegion,
  source: ProbeGlobalSource,
  fieldRevision: number,
): boolean {
  const retained = source.scene.retained;
  return (
    retained !== undefined &&
    retained.identity === region.retained.identity &&
    fieldRevision === region.fieldRevision &&
    retained.isCurrent() &&
    source.sourceScope === retained.source &&
    (region.cards === undefined || region.cards.current())
  );
}

/** Conservative frame-attempt fence over existing owner versions. It is never
 * the reusable region key and therefore cannot starve async preparation. */
export function probeGlobalAttemptCurrent(source: ProbeGlobalSource): () => boolean {
  const world = source.sourceScope;
  let versionCurrent: () => boolean;
  if (world.world === undefined) {
    if (!Number.isSafeInteger(world.revision) || (world.revision ?? 0) < 1)
      throw new Error('probe Global source has no accepted receiver revision');
    const revision = world.revision;
    versionCurrent = () => world.revision === revision;
  } else {
    const lease = source.lease;
    if (lease === undefined || lease.worldIdentity !== world.identity)
      throw new Error('probe Global source requires its current Renderer World lease');
    const captured = lease.captureVersion();
    versionCurrent = () => {
      const current = lease.captureVersion();
      return (
        current.mutationEpoch === captured.mutationEpoch &&
        current.structureEpoch === captured.structureEpoch
      );
    };
  }

  return () => {
    try {
      return (
        source.scene.retained?.isCurrent() === true &&
        source.scene.retained.isSourceCurrent() &&
        versionCurrent()
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
  /** A consumer's persistent field roster; a one-shot region projects cold. */
  fields = new SceneFieldRows(),
): Promise<ProbeGlobalRegion> {
  const retained = source.scene.retained;
  if (
    retained === undefined ||
    !retained.isSourceCurrent() ||
    source.sourceScope !== retained.source
  )
    throw new Error('probe Global source requires the complete current retained composition');
  const projected = fields.update(retained, source.sourceScope, profile, runtime.assets).unwrap();
  const fieldRevision = fields.revision;
  if (!retained.isSourceCurrent())
    throw new Error('probe Global source changed during synchronous resource admission');
  const count = projected.instances.length;
  const rows = editable ? Math.max(count, Math.min(1024, profile.maxInstances)) : count;
  const device = runtime.device;
  const sourceEpoch = sceneFieldSourceEpoch(fieldRevision).unwrap();
  const packed = packGlobalSdfComposition(projected.instances, profile.grid, {
    sourceEpoch,
    capacity: rows,
    // Spare rows do not make the admitted roster stale. Placement edits can
    // retain the same cell lists only while their original coverage holds.
    index: true,
    maxBytes: Math.min(
      WORLD_BOUNDS_POOL_MAX_BYTES,
      device.limits.maxBufferSize,
      device.limits.maxStorageBufferBindingSize,
    ),
  }).unwrap();
  // Validate query-specific spacing/dimensions before allocating the region.
  packGlobalSdfQuerySettings(packed.grid, profile).unwrap();
  const compile = runtime.createShaderModule;
  if (compile === undefined)
    throw new Error('probe Global preparation requires the Renderer shader module adapter');
  const owned: Buffer[] = [];
  let cards: ProbeCardCapture | undefined;
  const lifetime = new ResidencyLifetime(() => {
    for (const buffer of owned) device.destroyBuffer(buffer);
    cards?.release();
  });
  const words = packed.data.fields.byteLength / 4;
  const fieldCapacity = editable
    ? Math.max(words, Math.min(4_194_304, words + Math.ceil(profile.maxFieldBytes / 4)))
    : words;
  const sizes: Partial<Record<keyof typeof packed.data, number>> = editable
    ? {
        instances: Math.max(1, rows) * SDF_INSTANCE_STRIDE,
        bounds: WORLD_BOUNDS_HEADER_BYTES + Math.max(1, rows) * WORLD_BOUNDS_ROW_BYTES,
        fields: fieldCapacity * 4,
      }
    : {};
  let headroom: ProbeGlobalHeadroom | undefined;
  if (editable) {
    headroom = {
      rows: createIndexAllocator(Math.max(1, rows), count),
      fieldWords: words,
      fieldCapacity,
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
    // The accepted binding spans include actual editable headroom. They are
    // not the geometry usedWords or the unexpanded cold byte-array lengths.
    device.queue
      .writeBuffer(
        input.settings.buffer,
        48,
        Uint32Array.from([input.instances.size / 4, input.fields.size / 4, count, sourceEpoch]),
      )
      .unwrap();
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
      fieldRevision,
      ...(cards === undefined ? {} : { cards }),
      sources: projected.sources,
      instances: projected.instances,
      placement: {
        current: {
          instances: projected.instances,
          instanceData: packed.data.instances,
          surface: packed.surface,
          ...(packed.boundsIndexCoverage === undefined
            ? {}
            : { boundsIndex: { sourceEpoch, coverage: packed.boundsIndexCoverage } }),
        },
      },
      grid: packed.grid,
      input,
      voxelCount: packed.voxelCount,
      lifetime,
      composed: false,
      compose: (await prepareGlobalSdfCompositionRecorder(device, compositionModule)).unwrap()
        .record,
      query: (await createGlobalSdfQueryRecorder(device, queryModule)).unwrap().record,
      rays: (await createProbeRayRecorder(device, raysModule)).unwrap().record,
      support: (await createProbeOriginSupportRecorder(device, supportModule)).unwrap().record,
      ...(headroom === undefined ? {} : { headroom }),
    };
  } catch (cause) {
    lifetime.retire();
    throw cause;
  }
}
