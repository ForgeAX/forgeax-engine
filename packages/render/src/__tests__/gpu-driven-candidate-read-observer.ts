import { afterEach, beforeEach } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import type { GpuDrivenCandidate } from '../gpu-driven/batch-topology';
import type { FrameList } from '../scene/frame-list';
import type { Node } from '../scene/frame-tree';

type Observation = { listeners?: Set<() => void> };
let readers = new WeakMap<object, Observation>();
let restoreFreeze: (() => void) | undefined;

// Observe owner-created values before sealing; never replace or proxy a fixed root.
beforeEach(() => {
  readers = new WeakMap();
  const freeze = Object.freeze;
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'freeze');
  if (descriptor === undefined) throw new Error('Object.freeze descriptor is unavailable');
  Object.defineProperty(Object, 'freeze', {
    ...descriptor,
    value: (value: unknown) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        Object.hasOwn(value, 'priority') &&
        Object.hasOwn(value, 'queue') &&
        !Object.isFrozen(value)
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'value');
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.configurable)
          throw new Error('Expected an owner-created data node before sealing');
        const captured: unknown = descriptor.value;
        const observation: Observation = {};
        readers.set(value, observation);
        Object.defineProperty(value, 'value', {
          enumerable: descriptor.enumerable ?? false,
          configurable: true,
          get() {
            if (observation.listeners !== undefined) {
              for (const listener of observation.listeners) listener();
            }
            return captured;
          },
        });
      }
      return freeze(value);
    },
  });
  restoreFreeze = () => Object.defineProperty(Object, 'freeze', descriptor);
});
afterEach(() => restoreFreeze?.());

/** Count real candidate/member value reads, excluding O(1) root metadata access. */
export function observeCandidateReads(
  roots: Iterable<FrameList<GpuDrivenCandidate>>,
  read: () => void,
): () => void {
  const pending: Node<unknown>[] = [];
  for (const candidates of roots) {
    if (!MemberCandidates.is(candidates)) throw new Error('Expected canonical candidate owner');
    if (candidates.root !== undefined) pending.push(candidates.root);
  }
  const selected = new Set<Set<() => void>>();
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    const observation = readers.get(node);
    if (observation === undefined) throw new Error('Candidate owner predates read observation');
    observation.listeners ??= new Set<() => void>();
    const listeners = observation.listeners;
    if (selected.has(listeners)) continue;
    selected.add(listeners);
    if (node.left !== undefined) pending.push(node.left);
    if (node.right !== undefined) pending.push(node.right);
    const value = node.value as { candidates?: { root?: Node<unknown> } };
    if (value.candidates?.root !== undefined) pending.push(value.candidates.root);
  }
  for (const listeners of selected) listeners.add(read);
  return () => {
    for (const listeners of selected) listeners.delete(read);
  };
}
