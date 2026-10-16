import type { EntityHandle } from '@forgeax/engine-ecs';
import { type SkinError, SkinJointPathUnresolvedError } from './errors.js';

export function resolveSkinJoints(
  jointPaths: readonly string[],
  names: ReadonlyMap<string, EntityHandle>,
  skinEntity: EntityHandle,
): { ok: true; value: Uint32Array } | { ok: false; error: SkinError } {
  const joints: number[] = [];
  for (const path of jointPaths) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const failedAtIndex = segments.length - 1;
    const entity = names.get(segments[failedAtIndex] ?? '');
    if (entity === undefined) {
      return {
        ok: false,
        error: new SkinJointPathUnresolvedError(skinEntity as number, segments, failedAtIndex),
      };
    }
    joints.push(entity as number);
  }
  return { ok: true, value: new Uint32Array(joints) };
}
