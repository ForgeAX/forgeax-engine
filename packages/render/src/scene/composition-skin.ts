import type { EntityHandle } from '@forgeax/engine-ecs';
import { createPresentationMatrixReader } from '@forgeax/engine-scene/internal';
import type { SkeletonAsset } from '@forgeax/engine-types';
import type { GpuInputArena } from '../gpu-input-arena';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSceneApplyResult } from './render-scene-types';
import type { SceneSlotFrame } from './scene-slots';
import { SkinSceneInputs } from './skin-scene-inputs';

/** The composition facts Skin adoption reads; the Scene owns the entry. */
export interface SkinCompositionEntry {
  skin: SkinSceneInputs | undefined;
  readonly source: RenderResourceScope;
  jointMatrices?: ReturnType<typeof createPresentationMatrixReader>;
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
        entry.skin = new SkinSceneInputs(this.host.inputArena(), (handle) => {
          const definition = entry.source?.resolveAsset<SkeletonAsset>(handle);
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
  joint(entry: SkinCompositionEntry, entity: number): void {
    try {
      const skin = entry.skin,
        world = entry.source?.world;
      if (skin === undefined || world === undefined || !skin.hasJoint(entity)) return;
      entry.jointMatrices ??= createPresentationMatrixReader(world);
      const read = entry.jointMatrices;
      if (!read.locate(entity as EntityHandle)) {
        skin.joint(entity, undefined);
        return;
      }
      skin.joint(entity, read.values, read.offset);
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
      if (baseline) for (const joint of skin.firstJoints() ?? []) skin.joint(joint, undefined);
      for (const joint of retired) skin.joint(joint, undefined);
      for (const index of rows) skin.joint(entities[index] as number, transforms, index * 16);
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  skeleton(
    entry: SkinCompositionEntry,
    handle: number,
    definition: SkeletonAsset | undefined,
  ): void {
    try {
      entry.skin?.skeletonChanged(handle, definition);
    } catch (cause) {
      this.fail(entry, cause);
    }
  }

  initializeJoints(entry: SkinCompositionEntry): void {
    const skin = entry.skin;
    if (skin === undefined) return;
    for (const entity of skin.firstJoints() ?? []) this.joint(entry, entity);
  }
}
