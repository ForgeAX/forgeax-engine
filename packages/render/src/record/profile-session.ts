import type { World } from '@forgeax/engine-ecs';
import type { RecorderSession } from '@forgeax/engine-profiler';
import { RenderSubmission, renderSubmission } from '../world/render-world';

type ProfileSessionProvider = {
  activeSession(): RecorderSession | undefined;
};

interface ProfileSessionOwner {
  readonly profiler?: ProfileSessionProvider | undefined;
  readonly renderWorld?: World | undefined;
  readonly viewContext?: { readonly root: ProfileSessionOwner } | undefined;
}

/** Read the admitted RenderSubmission session before consulting the live Profiler. */
export function activeRenderProfileSession(
  owner: ProfileSessionOwner | undefined,
  worldOverride?: World,
  profilerOverride?: ProfileSessionProvider,
): RecorderSession | undefined {
  const root = owner?.viewContext?.root ?? owner;
  const world = worldOverride ?? root?.renderWorld;
  if (world?.hasResource(RenderSubmission)) {
    const submission = renderSubmission(world);
    if (submission.profileSessionPinned) return submission.profileSession;
  }
  return (profilerOverride ?? root?.profiler)?.activeSession();
}
