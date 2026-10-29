import {
  type ReplayReadbackResult,
  type ReplaySession,
  type WorkEntry,
  type WorkInspection,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import { expect } from 'vitest';

/** One forward replay for independent stage pixels; FrameModel owns their metadata. */
export async function inspectReplayWorks(
  replay: ReplaySession,
  works: readonly WorkEntry[],
): Promise<readonly WorkInspection[]> {
  const requests = works.map((work) => {
    const outputs = workOutputs(work);
    const output =
      outputs.find((row) => row.role === 'color') ??
      outputs.find((row) => row.role === 'depth') ??
      outputs.find((row) => row.role === 'storage-texture');
    if (output === undefined) throw new Error(`work ${work.workIndex} has no pixel output`);
    return { ...output.request, workIndex: work.workIndex };
  });
  const reads = (await replay.readAtWorks(requests)).unwrap();
  return works.map((work, index) => {
    const attachment = reads[index]?.unwrap();
    if (attachment === undefined) throw new Error('missing batched work readback');
    expect(attachment.provenance.selectedWorkIndex).toBe(work.workIndex);
    return describeReplayWork(work, attachment);
  });
}

/** Project existing FrameModel facts without executing another GPU prefix. */
export function describeReplayWork(
  work: WorkEntry,
  attachment?: ReplayReadbackResult,
): WorkInspection {
  return {
    workIndex: work.workIndex,
    eventIndex: work.eventIndex,
    passIndex: work.passIndex,
    attachment,
    pipeline: work.pipeline,
    bindings: work.bindings,
    vertexBuffers: work.vertexBuffers,
    indexBuffer: work.indexBuffer,
    shaders: work.pipeline.shaders,
    resourceIds: work.bindings.flatMap((binding) => binding.resourceId ?? []),
  };
}
