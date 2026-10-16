import type { WorkEntry } from '../frame-model';
import { type BatchReadRequest, bindingReadRequest } from './batch';

/**
 * One resource a work writes, named for selection: `color<N>` (the resolve
 * target when the slot resolves), `depth`, or `@group(G)@binding(B)` for a
 * writable storage buffer or texture.
 */
export interface WorkOutput {
  readonly name: string;
  readonly role: 'color' | 'depth' | 'storage-buffer' | 'storage-texture';
  readonly request: BatchReadRequest;
}

/** Every resource the work can write, as reads of its post-work state. */
export function workOutputs(work: WorkEntry): readonly WorkOutput[] {
  const outputs: WorkOutput[] = [];
  const attachments = work.attachments;
  for (const [slot, viewId] of attachments?.colorViewHandleIds.entries() ?? []) {
    const resolve = attachments?.colorResolveViewHandleIds[slot] ?? null;
    const depthSlice = resolve === null ? (attachments?.colorDepthSlices[slot] ?? null) : null;
    outputs.push({
      name: `color${slot}`,
      role: 'color',
      request: {
        resourceId: resolve ?? viewId,
        workIndex: work.workIndex,
        ...(depthSlice === null ? {} : { subresource: { mipLevel: 0, arrayLayer: depthSlice } }),
      },
    });
  }
  const depth = attachments?.depthStencilViewHandleId ?? null;
  if (depth !== null)
    outputs.push({
      name: 'depth',
      role: 'depth',
      request: {
        resourceId: depth,
        workIndex: work.workIndex,
        subresource: { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
      },
    });
  for (const binding of work.bindings) {
    if (binding.access !== 'write' && binding.access !== 'read-write') continue;
    const request = bindingReadRequest(work, binding.groupIndex, binding.binding);
    if (!request.ok) continue;
    outputs.push({
      name: `@group(${binding.groupIndex})@binding(${binding.binding})`,
      role: binding.resourceKind === 'buffer' ? 'storage-buffer' : 'storage-texture',
      request: request.value,
    });
  }
  return outputs;
}
