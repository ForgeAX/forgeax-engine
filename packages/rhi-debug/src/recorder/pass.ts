// @forgeax/engine-rhi-debug/src/recorder/pass -- render/compute pass proxy owners.

import type {
  ComputePipeline,
  RenderBundle,
  RenderPipeline,
  RhiComputePassEncoder,
  RhiRenderBundleEncoder,
  RhiRenderCommands,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import type { HandleId, RhiCallEvent } from '../types';
import type { RecorderInternal } from './core';
import { getHandleId, pushEvent, shouldRecord } from './core';

const bundleCommands = new WeakMap<
  RenderBundle,
  {
    readonly owner: RecorderInternal;
    readonly events: readonly RhiCallEvent[];
    readonly resources: readonly object[];
  }
>();

function createRenderCommandsProxy(
  s: RecorderInternal,
  realPass: RhiRenderCommands,
  passHId: HandleId,
  emit: (event: RhiCallEvent) => void = (event) => pushEvent(s, event),
  resources?: object[],
): RhiRenderCommands {
  const resourceId = (resource: object, kind: Parameters<typeof getHandleId>[2]) => {
    resources?.push(resource);
    return getHandleId(s, resource, kind);
  };
  return {
    setPipeline(pipeline: RenderPipeline) {
      const pid = resourceId(pipeline as object, 'renderPipeline');
      emit({ kind: 'setPipeline', passHandleId: passHId, pipelineHandleId: pid });
      realPass.setPipeline(pipeline);
    },
    setVertexBuffer(slot, buffer, offset, size) {
      const bid = resourceId(buffer as object, 'buffer');
      emit({
        kind: 'setVertexBuffer',
        passHandleId: passHId,
        slot,
        bufferHandleId: bid,
        offset,
        size,
      });
      realPass.setVertexBuffer(slot, buffer, offset, size);
    },
    setIndexBuffer(buffer, format, offset, size) {
      const bid = resourceId(buffer as object, 'buffer');
      emit({
        kind: 'setIndexBuffer',
        passHandleId: passHId,
        bufferHandleId: bid,
        format,
        offset,
        size,
      });
      realPass.setIndexBuffer(buffer, format, offset, size);
    },
    setBindGroup(index, bindGroup, ...rest: unknown[]) {
      const bgid = resourceId(bindGroup as object, 'bindGroup');
      let dynOffsets: readonly number[] | undefined;
      if (rest[0] instanceof Uint32Array) {
        const start = (rest[1] as number | undefined) ?? 0;
        const length = (rest[2] as number | undefined) ?? (rest[0] as Uint32Array).length;
        dynOffsets = Array.from((rest[0] as Uint32Array).subarray(start, start + length));
        (realPass.setBindGroup as (...args: unknown[]) => void)(index, bindGroup, ...rest);
      } else {
        const offsets = rest[0] as readonly number[] | undefined;
        dynOffsets = offsets === undefined ? undefined : Array.from(offsets);
        realPass.setBindGroup(index, bindGroup, offsets);
      }
      emit({
        kind: 'setBindGroup',
        passHandleId: passHId,
        index,
        bindGroupHandleId: bgid,
        dynamicOffsets: dynOffsets,
      });
    },
    draw(vertexCount, instanceCount, firstVertex, firstInstance) {
      emit({
        kind: 'draw',
        passHandleId: passHId,
        vertexCount,
        instanceCount: instanceCount ?? 1,
        firstVertex: firstVertex ?? 0,
        firstInstance: firstInstance ?? 0,
      });
      realPass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    },
    drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      emit({
        kind: 'drawIndexed',
        passHandleId: passHId,
        indexCount,
        instanceCount: instanceCount ?? 1,
        firstIndex: firstIndex ?? 0,
        baseVertex: baseVertex ?? 0,
        firstInstance: firstInstance ?? 0,
      });
      realPass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    },

    drawIndirect(indirectBuffer, indirectOffset) {
      const ibId = resourceId(indirectBuffer as object, 'buffer');
      emit({
        kind: 'drawIndirect',
        passHandleId: passHId,
        indirectBufferHandleId: ibId,
        indirectOffset,
      });
      realPass.drawIndirect(indirectBuffer, indirectOffset);
    },
    drawIndexedIndirect(indirectBuffer, indirectOffset) {
      const ibId = resourceId(indirectBuffer as object, 'buffer');
      emit({
        kind: 'drawIndexedIndirect',
        passHandleId: passHId,
        indirectBufferHandleId: ibId,
        indirectOffset,
      });
      realPass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    },
    pushDebugGroup(groupLabel) {
      emit({
        kind: 'passPushDebugGroup',
        passHandleId: passHId,
        groupLabel,
      });
      realPass.pushDebugGroup(groupLabel);
    },
    popDebugGroup() {
      emit({ kind: 'passPopDebugGroup', passHandleId: passHId });
      realPass.popDebugGroup();
    },
    insertDebugMarker(markerLabel) {
      emit({
        kind: 'passInsertDebugMarker',
        passHandleId: passHId,
        markerLabel,
      });
      realPass.insertDebugMarker(markerLabel);
    },
  };
}

export function createRenderBundleProxy(
  s: RecorderInternal,
  real: RhiRenderBundleEncoder,
): RhiRenderBundleEncoder {
  const events: RhiCallEvent[] = [];
  const resources: object[] = [];
  return {
    ...createRenderCommandsProxy(s, real, '' as HandleId, (event) => events.push(event), resources),
    finish(desc) {
      const result = real.finish(desc);
      if (result.ok)
        bundleCommands.set(result.value, {
          owner: s,
          events: events.slice(),
          resources: resources.slice(),
        });
      return result;
    },
  };
}

export function createRenderPassProxy(
  s: RecorderInternal,
  realPass: RhiRenderPassEncoder,
  passHId: HandleId,
): RhiRenderPassEncoder {
  return {
    ...createRenderCommandsProxy(s, realPass, passHId),
    // Pass-through methods (not in v1 event set, but must not break the proxy)
    setViewport(x, y, w, h, minDepth, maxDepth) {
      pushEvent(s, {
        kind: 'setViewport',
        passHandleId: passHId,
        x,
        y,
        w,
        h,
        minDepth: minDepth ?? 0,
        maxDepth: maxDepth ?? 1,
      });
      realPass.setViewport(x, y, w, h, minDepth, maxDepth);
    },
    setScissorRect(x, y, w, h) {
      pushEvent(s, {
        kind: 'setScissorRect',
        passHandleId: passHId,
        x,
        y,
        w,
        h,
      });
      realPass.setScissorRect(x, y, w, h);
    },
    setBlendConstant(color) {
      pushEvent(s, {
        kind: 'setBlendConstant',
        passHandleId: passHId,
        color,
      });
      realPass.setBlendConstant(color);
    },
    setStencilReference(reference) {
      // Recorded (not a no-op pass-through): stencil pipelines compare against
      // this dynamic reference, so without it replay defaults ref=0 and a
      // not-equal/equal stencil test (e.g. the 4.2 stencil-testing outline
      // pass) silently breaks -- the outline vanishes on replay.
      pushEvent(s, {
        kind: 'setStencilReference',
        passHandleId: passHId,
        reference,
      });
      realPass.setStencilReference(reference);
    },
    executeBundles(bundles) {
      const handles = Array.from(bundles);
      const recordings: Array<readonly RhiCallEvent[]> = [];
      for (const handle of handles) {
        const recording = bundleCommands.get(handle);
        if (recording?.owner !== s)
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'a bundle recorded by this device recorder',
              hint: 'create the bundle through the recorder-wrapped device',
            }),
          );
        recordings.push(recording.events);
      }
      const result = realPass.executeBundles(handles);
      if (!result.ok || !shouldRecord(s)) return result;
      // Expand at execution time, including bundles finished before capture.
      // Bundles do not inherit or export pipeline/binding/vertex/index state.
      for (const recording of recordings) {
        pushEvent(s, { kind: 'resetRenderState', passHandleId: passHId });
        for (const event of recording) {
          if ('passHandleId' in event) pushEvent(s, { ...event, passHandleId: passHId });
        }
      }
      pushEvent(s, { kind: 'resetRenderState', passHandleId: passHId });
      return result;
    },
    beginOcclusionQuery(queryIndex) {
      const result = realPass.beginOcclusionQuery(queryIndex);
      if (result.ok)
        pushEvent(s, { kind: 'beginOcclusionQuery', passHandleId: passHId, queryIndex });
      return result;
    },
    endOcclusionQuery() {
      const result = realPass.endOcclusionQuery();
      if (result.ok) pushEvent(s, { kind: 'endOcclusionQuery', passHandleId: passHId });
      return result;
    },
    end() {
      pushEvent(s, { kind: 'endRenderPass', passHandleId: passHId });
      realPass.end();
    },
  };
}

export function createComputePassProxy(
  s: RecorderInternal,
  realPass: RhiComputePassEncoder,
  passHId: HandleId,
): RhiComputePassEncoder {
  return {
    setPipeline(pipeline: ComputePipeline) {
      const pid = getHandleId(s, pipeline as object, 'computePipeline');
      pushEvent(s, { kind: 'setComputePipeline', passHandleId: passHId, pipelineHandleId: pid });
      realPass.setPipeline(pipeline);
    },
    setBindGroup(index, bindGroup, dynamicOffsets) {
      const bgid = getHandleId(s, bindGroup as object, 'bindGroup');
      const recordedDynamicOffsets =
        dynamicOffsets === undefined ? undefined : Array.from(dynamicOffsets);
      pushEvent(s, {
        kind: 'setBindGroup',
        passHandleId: passHId,
        index,
        bindGroupHandleId: bgid,
        dynamicOffsets: recordedDynamicOffsets,
      });
      realPass.setBindGroup(index, bindGroup, dynamicOffsets);
    },
    dispatchWorkgroups(x, y, z) {
      pushEvent(s, {
        kind: 'dispatchWorkgroups',
        passHandleId: passHId,
        x,
        y: y ?? 1,
        z: z ?? 1,
      });
      realPass.dispatchWorkgroups(x, y, z);
    },
    dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset) {
      const bufferHandleId = getHandleId(s, indirectBuffer as object, 'buffer');
      pushEvent(s, {
        kind: 'dispatchWorkgroupsIndirect',
        passHandleId: passHId,
        indirectBufferHandleId: bufferHandleId,
        indirectOffset,
      });
      realPass.dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset);
    },
    end() {
      pushEvent(s, { kind: 'endComputePass', passHandleId: passHId });
      realPass.end();
    },
  };
}
