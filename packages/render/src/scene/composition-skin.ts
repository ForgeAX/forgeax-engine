import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { readPresentationWorldMatrix } from '@forgeax/engine-scene';
import type { SkeletonAsset } from '@forgeax/engine-types';
import type { GpuInputArena } from '../gpu-input-arena';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSceneApplyResult } from './render-scene-types';
import type { SceneSlotFrame } from './scene-slots';
import { type SkinSceneFrame, SkinSceneInputs } from './skin-scene-inputs';

/** The composition facts Skin adoption reads; the Scene owns the entry. */
export interface SkinCompositionEntry {
  skin: SkinSceneInputs | undefined;
  readonly worlds: readonly RenderResourceScope[];
  readonly projection: { slotsSnapshot(): SceneSlotFrame };
}

export interface SkinCompositionHost {
  inputArena(): GpuInputArena;
  /** Drop the accepted composition so the next frame rebuilds from complete sources. */
  abandon(): void;
}

/**
 * Adopts Scene, joint and Skeleton changes into one composition's shared Skin
 * root. Any adoption failure retires the whole root and composition together;
 * no partially adopted pose survives.
 */
export class CompositionSkinAdoption {
  private jointScratch: ReturnType<typeof mat4.create> | undefined;

  constructor(private readonly host: SkinCompositionHost) {}

  fail(entry: SkinCompositionEntry, cause: unknown): never {
    const skin = entry.skin;
    entry.skin = undefined;
    const failures = [cause];
    try {
      this.host.abandon();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      skin?.dispose();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Skin adoption and retirement failed', { cause });
    throw cause;
  }

  apply(entry: SkinCompositionEntry, delta: RenderSceneApplyResult): void {
    try {
      if (
        entry.skin === undefined &&
        (delta.createdSlots.some((slot) => slot.snapshot.skinBinding !== undefined) ||
          delta.contentUpdatedSlots.some((slot) => slot.snapshot.skinBinding !== undefined) ||
          delta.recreatedSlots.some((slot) => slot.snapshot.skinBinding !== undefined))
      ) {
        entry.skin = new SkinSceneInputs(this.host.inputArena(), (worldId, handle) => {
          const definition = entry.worlds[worldId]?.resolveAsset<SkeletonAsset>(handle);
          return definition?.ok && definition.value.kind === 'skeleton'
            ? definition.value
            : undefined;
        });
      }
      entry.skin?.apply(delta);
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  /** Reads the same presentation matrix as every other render extraction. */
  joint(entry: SkinCompositionEntry, worldId: number, entity: number): void {
    try {
      const skin = entry.skin,
        world = entry.worlds[worldId]?.world;
      if (skin === undefined || world === undefined || !skin.hasJoint(worldId, entity)) return;
      const source = readPresentationWorldMatrix(world, entity as EntityHandle);
      if (source === undefined) {
        skin.joint(worldId, entity, undefined);
        return;
      }
      this.adopt(skin, worldId, entity, source, 0);
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  /** Published receiver rows: baseline/retired joints clear before known rows adopt. */
  published(
    entry: SkinCompositionEntry,
    baseline: boolean,
    retired: Iterable<number>,
    rows: Iterable<number>,
    entities: Uint32Array,
    transforms: Float32Array,
  ): void {
    try {
      const skin = entry.skin;
      if (skin === undefined) return;
      if (baseline) for (const joint of skin.firstJoints(0) ?? []) skin.joint(0, joint, undefined);
      for (const joint of retired) skin.joint(0, joint, undefined);
      for (const index of rows)
        this.adopt(skin, 0, entities[index] as number, transforms, index * 16);
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  skeleton(
    entry: SkinCompositionEntry,
    worldId: number,
    handle: number,
    definition: SkeletonAsset | undefined,
  ): void {
    try {
      entry.skin?.skeletonChanged(worldId, handle, definition);
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  initializeJoints(entry: SkinCompositionEntry): void {
    const skin = entry.skin;
    if (skin === undefined) return;
    for (let worldId = 0; worldId < entry.worlds.length; worldId++) {
      const first = skin.firstJoints(worldId);
      if (first === undefined) continue;
      for (const entity of first) this.joint(entry, worldId, entity);
    }
  }

  prepareFrame(entry: SkinCompositionEntry): SkinSceneFrame | undefined {
    try {
      entry.skin?.discardFrame();
      return entry.skin?.prepareFrame(entry.projection.slotsSnapshot());
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  private adopt(
    skin: SkinSceneInputs,
    worldId: number,
    entity: number,
    source: ArrayLike<number>,
    offset: number,
  ): void {
    this.jointScratch ??= mat4.create();
    for (let lane = 0; lane < 16; lane++) this.jointScratch[lane] = source[offset + lane] as number;
    skin.joint(worldId, entity, this.jointScratch);
  }
}
