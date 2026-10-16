// @forgeax/engine-rhi-debug/src/recorder/encoder -- command encoder proxy owner.

import type {
  BlasBuildEntry,
  Buffer,
  ComputePassDescriptor,
  RenderPassDescriptor,
  RhiCommandEncoder,
  TlasBuildEntry,
} from '@forgeax/engine-rhi';
import type { HandleId, RecordedBlasBuild, RecordedTlasBuild } from '../types';
import type { RecorderInternal } from './core';
import {
  allocHandleId,
  getHandleId,
  invalidateIndexBufferShadow,
  invalidateTinyTextureShadow,
  pushEvent,
} from './core';
import { createComputePassProxy, createRenderPassProxy } from './pass';

function recordedBuilds(
  s: RecorderInternal,
  blas: readonly BlasBuildEntry[],
  tlas: readonly TlasBuildEntry[],
): { readonly blas: RecordedBlasBuild[]; readonly tlas: RecordedTlasBuild[] } {
  return {
    blas: blas.map((entry) => ({
      blasHandleId: getHandleId(s, entry.blas as object, 'blas'),
      geometries: entry.geometries.map((geometry) => ({
        vertexBufferHandleId: getHandleId(s, geometry.vertexBuffer as object, 'buffer'),
        vertexStride: geometry.vertexStride,
        ...(geometry.firstVertex === undefined ? {} : { firstVertex: geometry.firstVertex }),
        ...(geometry.index === undefined
          ? {}
          : {
              index: {
                bufferHandleId: getHandleId(s, geometry.index.buffer as object, 'buffer'),
                ...(geometry.index.firstIndex === undefined
                  ? {}
                  : { firstIndex: geometry.index.firstIndex }),
              },
            }),
      })),
    })),
    tlas: tlas.map((entry) => ({
      tlasHandleId: getHandleId(s, entry.tlas as object, 'tlas'),
      instances: entry.instances.map((instance) => ({
        blasHandleId: getHandleId(s, instance.blas as object, 'blas'),
        transform: Array.from(instance.transform),
        customIndex: instance.customIndex,
        mask: instance.mask,
      })),
    })),
  };
}

/**
 * An encoder created between captures stays unrecorded. Observe only writes
 * that change retained replay state: BLAS/TLAS builds and WebGL2 INDEX data.
 */
export function observeIdleResourceMutations(
  s: RecorderInternal,
  realEnc: RhiCommandEncoder,
): RhiCommandEncoder {
  return new Proxy(realEnc, {
    get(target, key) {
      if (key === 'copyBufferToBuffer') {
        return (...args: unknown[]) => {
          invalidateIndexBufferShadow(s, args[typeof args[1] === 'number' ? 2 : 1] as object);
          return (target.copyBufferToBuffer as (...values: unknown[]) => void)(...args);
        };
      }
      if (key === 'copyTextureToBuffer') {
        return (...args: Parameters<RhiCommandEncoder['copyTextureToBuffer']>) => {
          invalidateIndexBufferShadow(s, args[1].buffer as object);
          return target.copyTextureToBuffer(...args);
        };
      }
      if (key === 'clearBuffer') {
        return (...args: Parameters<RhiCommandEncoder['clearBuffer']>) => {
          invalidateIndexBufferShadow(s, args[0] as object);
          return target.clearBuffer(...args);
        };
      }
      if (key === 'resolveQuerySet') {
        return (...args: Parameters<RhiCommandEncoder['resolveQuerySet']>) => {
          invalidateIndexBufferShadow(s, args[3] as object);
          return target.resolveQuerySet(...args);
        };
      }
      if (key === 'buildAccelerationStructures') {
        return (blas: readonly BlasBuildEntry[], tlas: readonly TlasBuildEntry[]) => {
          const result = target.buildAccelerationStructures(blas, tlas);
          if (result.ok) {
            flushDeferredAccelerationStructureBuilds(s);
            recordBootstrapBuilds(s, recordedBuilds(s, blas, tlas));
          }
          return result;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function flushDeferredAccelerationStructureBuilds(s: RecorderInternal): void {
  for (const builds of s.deferredAccelerationStructureBuilds) recordBootstrapBuilds(s, builds);
  s.deferredAccelerationStructureBuilds = [];
}

function recordBootstrapBuilds(
  s: RecorderInternal,
  builds: RecorderInternal['deferredAccelerationStructureBuilds'][number],
): void {
  for (const { blasHandleId, geometries } of builds.blas) {
    const create = s.bootstrapCreates.get(blasHandleId);
    if (create?.kind === 'createBlas')
      s.bootstrapCreates.set(blasHandleId, { ...create, build: { geometries } });
  }
  for (const { tlasHandleId, instances } of builds.tlas) {
    const create = s.bootstrapCreates.get(tlasHandleId);
    if (create?.kind === 'createTlas')
      s.bootstrapCreates.set(tlasHandleId, { ...create, build: { instances } });
  }
}

export function createCommandEncoderProxy(
  s: RecorderInternal,
  realEnc: RhiCommandEncoder,
  cmdHId: HandleId,
): RhiCommandEncoder {
  return {
    buildAccelerationStructures(blas, tlas) {
      const result = realEnc.buildAccelerationStructures(blas, tlas);
      if (result.ok) {
        const builds = recordedBuilds(s, blas, tlas);
        s.deferredAccelerationStructureBuilds.push(builds);
        pushEvent(s, { kind: 'buildAccelerationStructures', cmdHandleId: cmdHId, ...builds });
      }
      return result;
    },
    beginRenderPass(desc: RenderPassDescriptor) {
      const passHId = allocHandleId('renderPass');
      // I-2 fix-up (round 1, dawn smoke): walk colorAttachments +
      // depthStencilAttachment to extract the textureView handleIds
      // recorded under createTextureView. Without this the replayer
      // would dereference the original GPUTextureView brand directly,
      // which fails on a fresh device (cross-device GPU object reuse).
      const colorAttachmentViewHandleIds: (HandleId | undefined)[] = [];
      const colorAttachmentResolveTargetHandleIds: (HandleId | undefined)[] = [];
      for (const att of desc.colorAttachments) {
        if (att === null || att === undefined) {
          colorAttachmentViewHandleIds.push(undefined);
          colorAttachmentResolveTargetHandleIds.push(undefined);
        } else {
          const view = att.view;
          const id =
            view !== undefined && view !== null
              ? s.handleMap.get(view as object)?.handleId
              : undefined;
          colorAttachmentViewHandleIds.push(id);
          const resolveTarget = att.resolveTarget;
          const resolveTargetId =
            resolveTarget !== undefined && resolveTarget !== null
              ? s.handleMap.get(resolveTarget as object)?.handleId
              : undefined;
          colorAttachmentResolveTargetHandleIds.push(resolveTargetId);
        }
      }
      let depthStencilViewHandleId: HandleId | undefined;
      if (desc.depthStencilAttachment !== undefined) {
        const dsView = desc.depthStencilAttachment.view;
        if (dsView !== undefined && dsView !== null) {
          depthStencilViewHandleId = s.handleMap.get(dsView as object)?.handleId;
        }
      }
      pushEvent(s, {
        kind: 'beginRenderPass',
        cmdHandleId: cmdHId,
        passHandleId: passHId,
        timestampQuerySetHandleId:
          desc?.timestampWrites === undefined
            ? undefined
            : getHandleId(s, desc.timestampWrites.querySet as object, 'querySet'),
        desc: {
          ...(desc.label === undefined ? {} : { label: desc.label }),
          colorAttachments: Array.from(desc.colorAttachments).map((attachment) =>
            attachment === null || attachment === undefined ? attachment : { ...attachment },
          ),
          ...(desc.depthStencilAttachment === undefined
            ? {}
            : { depthStencilAttachment: { ...desc.depthStencilAttachment } }),
          ...(desc.timestampWrites === undefined
            ? {}
            : { timestampWrites: recordTimestampWrites(desc.timestampWrites) }),
          ...(desc.maxDrawCount === undefined ? {} : { maxDrawCount: desc.maxDrawCount }),
        },
        colorAttachmentViewHandleIds,
        colorAttachmentResolveTargetHandleIds,
        depthStencilViewHandleId,
        ...(desc.occlusionQuerySet === undefined
          ? {}
          : {
              occlusionQuerySetHandleId: getHandleId(
                s,
                desc.occlusionQuerySet as object,
                'querySet',
              ),
            }),
      });
      const realPass = realEnc.beginRenderPass(desc);
      return createRenderPassProxy(s, realPass, passHId);
    },
    beginComputePass(desc?: ComputePassDescriptor | undefined) {
      const passHId = allocHandleId('computePass');
      pushEvent(s, {
        kind: 'beginComputePass',
        cmdHandleId: cmdHId,
        passHandleId: passHId,
        timestampQuerySetHandleId:
          desc?.timestampWrites === undefined
            ? undefined
            : getHandleId(s, desc.timestampWrites.querySet as object, 'querySet'),
        desc:
          desc === undefined
            ? undefined
            : {
                ...(desc.label === undefined ? {} : { label: desc.label }),
                timestampWrites: recordTimestampWrites(desc.timestampWrites),
              },
      });
      const realPass = realEnc.beginComputePass(desc);
      return createComputePassProxy(s, realPass, passHId);
    },
    encodeEmptyComputePass(desc: ComputePassDescriptor) {
      const passHId = allocHandleId('computePass');
      pushEvent(s, {
        kind: 'beginComputePass',
        cmdHandleId: cmdHId,
        passHandleId: passHId,
        timestampQuerySetHandleId:
          desc?.timestampWrites === undefined
            ? undefined
            : getHandleId(s, desc.timestampWrites.querySet as object, 'querySet'),
        desc: {
          ...(desc.label === undefined ? {} : { label: desc.label }),
          timestampWrites: recordTimestampWrites(desc.timestampWrites),
        },
      });
      realEnc.encodeEmptyComputePass(desc);
      pushEvent(s, { kind: 'endComputePass', passHandleId: passHId });
    },
    // Passthrough copy/clear methods (event recording added where types permit)
    copyBufferToBuffer(...args: unknown[]) {
      // Overloaded: 3-arg or 5-arg
      if (typeof args[1] === 'number') {
        // 5-arg form: (source, sourceOffset, destination, destinationOffset, size)
        const sourceId = getHandleId(s, args[0] as object, 'buffer');
        const destinationId = getHandleId(s, args[2] as object, 'buffer');
        invalidateIndexBufferShadow(s, args[2] as object);
        pushEvent(s, {
          kind: 'copyBufferToBuffer',
          cmdHandleId: cmdHId,
          sourceHandleId: sourceId,
          sourceOffset: args[1] as number,
          destinationHandleId: destinationId,
          destinationOffset: args[3] as number,
          size: args[4] as number,
        });
        (realEnc.copyBufferToBuffer as (...args: unknown[]) => void)(...args);
      } else {
        // 3-arg form: (source, destination, size?)
        const sourceId = getHandleId(s, args[0] as object, 'buffer');
        const destinationId = getHandleId(s, args[1] as object, 'buffer');
        invalidateIndexBufferShadow(s, args[1] as object);
        const size = args[2] as number | undefined;
        pushEvent(s, {
          kind: 'copyBufferToBuffer',
          cmdHandleId: cmdHId,
          sourceHandleId: sourceId,
          sourceOffset: 0,
          destinationHandleId: destinationId,
          destinationOffset: 0,
          size: (size ?? 0) as number,
        });
        realEnc.copyBufferToBuffer(args[0] as Buffer, args[1] as Buffer, size);
      }
    },
    copyBufferToTexture(source, destination, copySize) {
      const { buffer } = source;
      const bufId = getHandleId(s, buffer, 'buffer');
      const texId = getHandleId(
        s,
        (destination as { texture: object }).texture as object,
        'texture',
      );
      const dstPayload: Record<string, unknown> = { textureHandleId: texId };
      if (destination.mipLevel !== undefined) dstPayload.mipLevel = destination.mipLevel;
      if (destination.origin !== undefined) dstPayload.origin = destination.origin;
      if (destination.aspect !== undefined) dstPayload.aspect = destination.aspect;
      pushEvent(s, {
        kind: 'copyBufferToTexture',
        cmdHandleId: cmdHId,
        source: {
          bufferHandleId: bufId,
          ...(source.offset === undefined ? {} : { offset: source.offset }),
          ...(source.bytesPerRow === undefined ? {} : { bytesPerRow: source.bytesPerRow }),
          ...(source.rowsPerImage === undefined ? {} : { rowsPerImage: source.rowsPerImage }),
        },
        destination: dstPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        copySize,
      });
      realEnc.copyBufferToTexture(source, destination, copySize);
      invalidateTinyTextureShadow(s, destination.texture as object);
    },
    copyTextureToBuffer(source, destination, copySize) {
      invalidateIndexBufferShadow(s, destination.buffer as object);
      const texId = getHandleId(s, (source as { texture: object }).texture as object, 'texture');
      const { buffer } = destination;
      const bufId = getHandleId(s, buffer, 'buffer');
      const srcPayload: Record<string, unknown> = { textureHandleId: texId };
      if (source.mipLevel !== undefined) srcPayload.mipLevel = source.mipLevel;
      if (source.origin !== undefined) srcPayload.origin = source.origin;
      if (source.aspect !== undefined) srcPayload.aspect = source.aspect;
      pushEvent(s, {
        kind: 'copyTextureToBuffer',
        cmdHandleId: cmdHId,
        source: srcPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        destination: {
          bufferHandleId: bufId,
          ...(destination.offset === undefined ? {} : { offset: destination.offset }),
          ...(destination.bytesPerRow === undefined
            ? {}
            : { bytesPerRow: destination.bytesPerRow }),
          ...(destination.rowsPerImage === undefined
            ? {}
            : { rowsPerImage: destination.rowsPerImage }),
        },
        copySize,
      });
      realEnc.copyTextureToBuffer(source, destination, copySize);
    },
    copyTextureToTexture(source, destination, copySize) {
      const srcTexId = getHandleId(s, (source as { texture: object }).texture as object, 'texture');
      const dstTexId = getHandleId(
        s,
        (destination as { texture: object }).texture as object,
        'texture',
      );
      const srcPayload: Record<string, unknown> = { textureHandleId: srcTexId };
      if (source.mipLevel !== undefined) srcPayload.mipLevel = source.mipLevel;
      if (source.origin !== undefined) srcPayload.origin = source.origin;
      if (source.aspect !== undefined) srcPayload.aspect = source.aspect;
      const dstPayload: Record<string, unknown> = { textureHandleId: dstTexId };
      if (destination.mipLevel !== undefined) dstPayload.mipLevel = destination.mipLevel;
      if (destination.origin !== undefined) dstPayload.origin = destination.origin;
      if (destination.aspect !== undefined) dstPayload.aspect = destination.aspect;
      pushEvent(s, {
        kind: 'copyTextureToTexture',
        cmdHandleId: cmdHId,
        source: srcPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        destination: dstPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        copySize,
      });
      realEnc.copyTextureToTexture(source, destination, copySize);
      invalidateTinyTextureShadow(s, destination.texture as object);
    },
    clearBuffer(buffer, offset, size) {
      invalidateIndexBufferShadow(s, buffer as object);
      const bufId = getHandleId(s, buffer as object, 'buffer');
      pushEvent(s, {
        kind: 'clearBuffer',
        cmdHandleId: cmdHId,
        handleId: bufId,
        offset,
        size,
      });
      realEnc.clearBuffer(buffer, offset, size);
    },
    resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
      invalidateIndexBufferShadow(s, destination as object);
      const result = realEnc.resolveQuerySet(
        querySet,
        firstQuery,
        queryCount,
        destination,
        destinationOffset,
      );
      if (result.ok) {
        pushEvent(s, {
          kind: 'resolveQuerySet',
          cmdHandleId: cmdHId,
          querySetHandleId: getHandleId(s, querySet as object, 'querySet'),
          firstQuery,
          queryCount,
          destinationHandleId: getHandleId(s, destination as object, 'buffer'),
          destinationOffset,
        });
      }
      return result;
    },
    pushDebugGroup(groupLabel) {
      pushEvent(s, { kind: 'pushDebugGroup', cmdHandleId: cmdHId, groupLabel });
      realEnc.pushDebugGroup(groupLabel);
    },
    popDebugGroup() {
      pushEvent(s, { kind: 'popDebugGroup', cmdHandleId: cmdHId });
      realEnc.popDebugGroup();
    },
    insertDebugMarker(markerLabel) {
      pushEvent(s, { kind: 'insertDebugMarker', cmdHandleId: cmdHId, markerLabel });
      realEnc.insertDebugMarker(markerLabel);
    },
    finish() {
      pushEvent(s, { kind: 'finish', cmdHandleId: cmdHId });
      const res = realEnc.finish();
      // I-2 fix-up (round 1, dawn smoke handle-graph integrity):
      // alias the resulting CommandBuffer object to the encoder's
      // cmdHandleId so subsequent queue.submit() handle lookups resolve
      // to the SAME id that the createCommandEncoder/finish event pair
      // declared. Without this, submit would register a fresh handleId
      // for the CommandBuffer object and the tape's handle graph
      // integrity check would reject the tape on deserialize.
      if (res.ok) {
        s.handleMap.set(res.value as object, { handleId: cmdHId });
      }
      return res;
    },
  };
}

function recordTimestampWrites(writes: RenderPassDescriptor['timestampWrites']) {
  return writes === undefined
    ? undefined
    : {
        ...(writes.beginningOfPassWriteIndex === undefined
          ? {}
          : { beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex }),
        ...(writes.endOfPassWriteIndex === undefined
          ? {}
          : { endOfPassWriteIndex: writes.endOfPassWriteIndex }),
      };
}
