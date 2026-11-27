import type { EcsError } from '@forgeax/engine-ecs';
import {
  err,
  ok,
  PACK_ERROR_HINTS,
  type PackErrorCode,
  type PackErrorDetail,
  type Result,
} from '@forgeax/engine-types';
import type { CompiledSceneEntity } from './keyed';
import type { SceneInstanceMount } from './runtime-types';

/** Validate disjoint private member slots before materialization. */
export function* sceneMemberSlotCountSteps(
  ownEntities: readonly CompiledSceneEntity[],
  ownMounts: readonly SceneInstanceMount[],
  incremental: boolean,
): Generator<void, Result<number, EcsError>, void> {
  const memberSum = ownMounts.reduce((s, m) => s + m.memberCount, 0);
  const countBaseline = ownEntities.length + ownMounts.length + memberSum;
  let maxLocalId = ownEntities.reduce((m, e) => Math.max(m, e.localId as unknown as number), -1);
  for (const mount of ownMounts) {
    if (incremental) yield;
    maxLocalId = Math.max(maxLocalId, mount.localId as unknown as number);
    const last = (mount.memberFirst as unknown as number) + mount.memberCount - 1;
    maxLocalId = Math.max(maxLocalId, last);
  }
  // Sparse local IDs and nested windows must both fit, with disjoint claims.
  const totalSlots = Math.max(countBaseline, maxLocalId + 1);

  {
    const claims = new Map<number, string>();
    const overlapLids = new Set<number>();
    const overlapSources: string[] = [];
    const claim = (lid: number, src: string): void => {
      const prior = claims.get(lid);
      if (prior !== undefined) {
        if (!overlapLids.has(lid)) {
          overlapLids.add(lid);
          overlapSources.push(prior);
          overlapSources.push(src);
        } else {
          overlapSources.push(src);
        }
        return;
      }
      claims.set(lid, src);
    };
    for (const ent of ownEntities) {
      if (incremental) yield;
      claim(ent.localId as unknown as number, `entities[${ent.localId as unknown as number}]`);
    }
    for (const mount of ownMounts) {
      if (incremental) yield;
      const mLid = mount.localId as unknown as number;
      claim(mLid, `mount[${mLid}]`);
      const first = mount.memberFirst as unknown as number;
      for (let k = 0; k < mount.memberCount; k += 1) {
        if (incremental) yield;
        claim(first + k, `mount[${mLid}].member[${k}]`);
      }
    }
    if (overlapLids.size > 0) {
      const overlapping = Array.from(overlapLids).sort((a, b) => a - b);
      return err({
        code: 'pack-mount-localid-overlap' as PackErrorCode,
        expected: 'each LocalEntityId claimed by exactly one entity or mount slot',
        hint: PACK_ERROR_HINTS['pack-mount-localid-overlap'],
        detail: {
          code: 'pack-mount-localid-overlap',
          overlapping,
          sources: overlapSources,
        } as PackErrorDetail,
      } as unknown as EcsError);
    }
  }

  return ok(totalSlots);
}
