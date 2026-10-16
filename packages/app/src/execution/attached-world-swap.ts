import type { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';

/** Serialize realm rebuilds so candidate Worlds never overlap ownership. */
export class SerializedRebuildQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(action: () => Promise<void>): Promise<void> {
    const current = this.tail.then(action, action);
    this.tail = current.catch(() => undefined);
    return current;
  }
}

/** Transactionally replace one Renderer-attached World. */
export async function commitAttachedWorld(
  renderer: Pick<Renderer, 'attach'>,
  nextWorld: World,
  initializeCandidate: () => Promise<boolean>,
): Promise<boolean> {
  const attached = renderer.attach(nextWorld);
  if (!attached.ok) throw attached.error;
  try {
    if (!(await initializeCandidate())) {
      attached.value.dispose();
      return false;
    }
  } catch (cause) {
    attached.value.dispose();
    throw cause;
  }
  return true;
}
