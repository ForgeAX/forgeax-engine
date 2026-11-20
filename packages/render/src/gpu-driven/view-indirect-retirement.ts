import { type Buffer, ok, type Result, type RhiDevice, type RhiError } from '@forgeax/engine-rhi';
import { batchLodLevelCount, GPU_DRIVEN_INDIRECT_COMMAND_BYTES } from './batch-layout';
import type { SubmissionPlan } from './batch-topology';

const zeros = new Uint8Array(8 * GPU_DRIVEN_INDIRECT_COMMAND_BYTES);

/** Clear only commands exited by this View's preceding execution, including every LOD and phase. */
export function clearExitedIndirectCommands(
  device: RhiDevice,
  buffer: Buffer,
  previous: SubmissionPlan | undefined,
  next: SubmissionPlan,
  lateBase: number,
): Result<number, RhiError> {
  if (previous === undefined || previous === next) return ok(0);
  const active = new Set(Array.from(next.batches, (batch) => batch.batchId));
  let bytes = 0;
  for (const batch of previous.batches) {
    if (active.has(batch.batchId)) continue;
    const size = batchLodLevelCount(batch) * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
    for (const base of [0, lateBase]) {
      const written = device.queue.writeBuffer(buffer, base + batch.indirectOffset, zeros, 0, size);
      if (!written.ok) return written;
      bytes += size;
    }
  }
  return ok(bytes);
}
