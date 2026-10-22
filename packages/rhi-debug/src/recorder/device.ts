// @forgeax/engine-rhi-debug/src/recorder/device -- device proxy owner.

/// <reference types="@webgpu/types" />

import type {
  BindGroupDescriptor,
  BindGroupLayoutDescriptor,
  Blas,
  BlasDescriptor,
  Buffer,
  BufferDescriptor,
  CommandEncoderDescriptor,
  ComputePipeline,
  ComputePipelineDescriptor,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  RhiCommandEncoder,
  RhiDevice,
  SamplerDescriptor,
  Texture,
  TextureDescriptor,
  TextureViewDescriptor,
  Tlas,
  TlasDescriptor,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err as makeErr, ok as makeOk, type Result } from '@forgeax/engine-types';
import type { HandleId, RhiBindResourceKind, RhiCallEvent } from '../types';

import type { RecorderDevice, RecorderInternal } from './core';
import {
  allocHandleId,
  ensureTextureCreateEvent,
  getHandleId,
  hasBootstrapDependency,
  isDepthOrStencilFormat,
  promoteBufferUsage,
  pushEvent,
  registerHandle,
  retainsCaptureBootstrap,
  shouldRecord,
  TEXTURE_USAGE_BINDING,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_COPY_SRC,
} from './core';
import { createCommandEncoderProxy, observeIdleResourceMutations } from './encoder';
import { recordImportExternalTexture, recordImportTexture } from './external-texture';
import { createRenderBundleProxy } from './pass';
import { wrapPipeline } from './pipeline';
import { createQueueProxy } from './queue';

const UNKNOWN_EXTERNAL = 'externalTexture:unknown' as HandleId;

export function createDeviceProxy(s: RecorderInternal, realDevice: RhiDevice): RhiDevice {
  const proxiedQueue = createQueueProxy(s, realDevice.queue);
  const pipelineLibrary = realDevice.pipelineLibrary;

  const captureRenderPipeline = (
    desc: RenderPipelineDescriptor,
  ): Extract<RhiCallEvent, { kind: 'createRenderPipeline' }> => {
    let layoutId: HandleId;
    if (typeof desc.layout === 'string') {
      layoutId = 'layout:auto';
    } else {
      layoutId = getHandleId(s, desc.layout as object, 'pipelineLayout');
    }
    let vertexShaderModuleHandleId: HandleId | undefined;
    if (desc.vertex !== undefined) {
      vertexShaderModuleHandleId = getHandleId(s, desc.vertex.module as object, 'shaderModule');
    }
    let fragmentShaderModuleHandleId: HandleId | undefined;
    if (desc.fragment !== undefined) {
      fragmentShaderModuleHandleId = getHandleId(s, desc.fragment.module as object, 'shaderModule');
    }
    const { module: _vertexModule, constants: vertexConstants, ...vertexFields } = desc.vertex;
    const recordedVertex =
      vertexConstants === undefined
        ? vertexFields
        : { ...vertexFields, constants: vertexConstants };
    const recordedFragment =
      desc.fragment === undefined
        ? undefined
        : (() => {
            const {
              module: _fragmentModule,
              constants: fragmentConstants,
              ...fragmentFields
            } = desc.fragment;
            return fragmentConstants === undefined
              ? fragmentFields
              : { ...fragmentFields, constants: fragmentConstants };
          })();
    const event: Extract<RhiCallEvent, { kind: 'createRenderPipeline' }> = {
      kind: 'createRenderPipeline',
      handleId: '' as HandleId,
      desc: {
        ...(desc.label === undefined ? {} : { label: desc.label }),
        vertex: recordedVertex,
        primitive: desc.primitive,
        depthStencil: desc.depthStencil,
        multisample: desc.multisample,
        ...(recordedFragment === undefined ? {} : { fragment: recordedFragment }),
      },
      layoutHandleId: layoutId,
      vertexShaderModuleHandleId,
      fragmentShaderModuleHandleId,
    };
    return { ...event, desc: structuredClone(event.desc) };
  };
  const captureComputePipeline = (
    desc: ComputePipelineDescriptor,
  ): Extract<RhiCallEvent, { kind: 'createComputePipeline' }> => {
    let layoutId: HandleId;
    if (typeof desc.layout === 'string') {
      layoutId = 'layout:auto';
    } else {
      layoutId = getHandleId(s, desc.layout as object, 'pipelineLayout');
    }
    const computeShaderModuleHandleId = getHandleId(
      s,
      desc.compute.module as object,
      'shaderModule',
    );
    const event: RhiCallEvent = {
      kind: 'createComputePipeline',
      handleId: '' as HandleId,
      desc: {
        ...(desc.label === undefined ? {} : { label: desc.label }),
        compute: JSON.parse(JSON.stringify(desc.compute)),
      },
      layoutHandleId: layoutId,
      computeShaderModuleHandleId,
    };
    return { ...event, desc: structuredClone(event.desc) };
  };
  const recordComputePipeline = (
    pipeline: ComputePipeline,
    event: Extract<RhiCallEvent, { kind: 'createComputePipeline' }>,
  ): Result<ComputePipeline, RhiError> => {
    const pipelineId = registerHandle(s, pipeline as object, 'computePipeline', event);
    pushEvent(s, event);
    return makeOk(wrapPipeline(s, pipeline, pipelineId));
  };
  const recordRenderPipeline = (
    pipeline: RenderPipeline,
    event: Extract<RhiCallEvent, { kind: 'createRenderPipeline' }>,
  ): Result<RenderPipeline, RhiError> => {
    const pipelineId = registerHandle(s, pipeline as object, 'renderPipeline', event, realDevice);
    pushEvent(s, event);
    return makeOk(wrapPipeline(s, pipeline, pipelineId));
  };

  // Expose the real RhiDevice for standalone createShaderModule calls.
  // engine-rhi-webgpu's createShaderModule uses RAW_DEVICE_MAP (WeakMap)
  // to reverse-lookup the GPUDevice. The proxy is a different JS object
  // from the RhiDevice that makeRhiDevice registered, so WeakMap.get(proxy)
  // returns undefined and createShaderModule returns shader-compile-failed.
  // The _realDevice property lets callers pass the real RhiDevice directly.
  const d: RecorderDevice = {
    ...(pipelineLibrary === undefined ? {} : { pipelineLibrary }),
    _realDevice: realDevice,

    get caps() {
      return realDevice.caps;
    },
    get features() {
      return realDevice.features;
    },
    get limits() {
      return realDevice.limits;
    },
    probeTextureFormatCapability() {
      return realDevice.probeTextureFormatCapability();
    },
    get queue() {
      return proxiedQueue;
    },
    get lost() {
      return realDevice.lost;
    },

    createBuffer(desc: BufferDescriptor) {
      // COPY_SRC promotion (D-5): every recorded resource must be readable
      // back via copyBufferToBuffer so snapshotResource can capture its GPU
      // bytes at frame-header time. Promote the live resource's usage too,
      // not just the recorded event — a buffer created without COPY_SRC is
      // an invalid copy source on the real device. Mappable buffers are
      // skipped (MAP_READ|COPY_SRC is invalid) — they are staging buffers,
      // never snapshot targets.
      const promotedUsage = promoteBufferUsage(desc.usage ?? 0);
      const res = realDevice.createBuffer({ ...desc, usage: promotedUsage });
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createBuffer',
        handleId: '' as HandleId,
        desc: {
          ...(desc.label === undefined ? {} : { label: desc.label }),
          size: desc.size ?? 0,
          usage: promotedUsage,
          mappedAtCreation: desc.mappedAtCreation,
        },
      };
      const bufResource = res.value as object;
      const bufHandleId = registerHandle(s, bufResource, 'buffer', event);
      s.descriptorTable.set(bufHandleId, {
        kind: 'buffer',
        size: desc.size ?? 0,
        usage: promotedUsage,
        resource: bufResource,
      });
      if (realDevice.caps.backendKind === 'wgpu-webgl2' && (promotedUsage & 0x10) !== 0) {
        // wgpu's GLES copy path returns zero bytes for INDEX buffers even
        // while the same buffers draw correctly. Keep only this debug-owned
        // seed shadow; unknown mapped or GPU-written contents stay unseeded.
        let shadow: Uint8Array | null = null;
        if (!desc.mappedAtCreation) {
          try {
            shadow = new Uint8Array(desc.size ?? 0);
          } catch {
            // A very large buffer may have no available CPU shadow memory.
          }
        }
        s.indexBufferShadow.set(bufHandleId, shadow);
      }
      pushEvent(s, event);
      return res;
    },

    createTexture(desc: TextureDescriptor) {
      // Snapshot promotion (D-5): a texture needs COPY_SRC for GPU readback
      // and COPY_DST for queue.writeTexture bootstrap seeding. Promote the
      // live resource's usage as well as the recorded event's so replay can
      // restore the captured color bytes on a fresh device.
      // MSAA textures are never snapshotted, and on WebGL2 any usage beyond
      // RENDER_ATTACHMENT moves them off the multisampled renderbuffer path
      // onto a glow texStorage2DMultisample panic.
      const webgl2Multisampled =
        realDevice.caps.backendKind === 'wgpu-webgl2' && (desc.sampleCount ?? 1) > 1;
      const promotedUsage = webgl2Multisampled
        ? (desc.usage ?? 0)
        : (desc.usage ?? 0) |
          TEXTURE_USAGE_COPY_SRC |
          TEXTURE_USAGE_COPY_DST |
          (isDepthOrStencilFormat(desc.format) ? TEXTURE_USAGE_BINDING : 0) |
          (desc.format === 'depth32float' ? 0x10 : 0);
      const res = realDevice.createTexture({ ...desc, usage: promotedUsage });
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createTexture',
        handleId: '' as HandleId,
        desc: {
          ...(desc.label === undefined ? {} : { label: desc.label }),
          size: desc.size ?? { width: 1, height: 1 },
          mipLevelCount: desc.mipLevelCount,
          sampleCount: desc.sampleCount,
          dimension: desc.dimension,
          format: desc.format ?? ('bgra8unorm' as GPUTextureFormat),
          usage: promotedUsage,
          viewFormats: desc.viewFormats,
          textureBindingViewDimension: desc.textureBindingViewDimension,
        },
      };
      const texResource = res.value as object;
      const texHandleId = registerHandle(s, texResource, 'texture', event);
      s.descriptorTable.set(texHandleId, {
        kind: 'texture',
        size: desc.size ?? { width: 1, height: 1 },
        format: desc.format ?? ('bgra8unorm' as GPUTextureFormat),
        ...(desc.sampleCount !== undefined ? { sampleCount: desc.sampleCount } : {}),
        ...(desc.mipLevelCount !== undefined ? { mipLevelCount: desc.mipLevelCount } : {}),
        usage: promotedUsage,
        ...(desc.textureBindingViewDimension === undefined
          ? {}
          : { textureBindingViewDimension: desc.textureBindingViewDimension }),
        resource: texResource,
      });
      pushEvent(s, event);
      return res;
    },

    nativeDevice() {
      return realDevice.nativeDevice();
    },

    importTexture(texture: GPUTexture) {
      return recordImportTexture(s, realDevice, texture);
    },

    importExternalTexture(desc) {
      return recordImportExternalTexture(s, realDevice, d, proxiedQueue, desc);
    },

    createTextureView(texture: Texture, desc: TextureViewDescriptor) {
      const res = realDevice.createTextureView(texture, desc);
      if (!res.ok) return res;
      const srcId = getHandleId(s, texture as object, 'texture');
      const textureError = ensureTextureCreateEvent(s, texture as object, srcId, desc.format);
      if (textureError !== undefined) {
        return makeErr(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'texture-view creation to remain representable in the capture graph',
            hint: textureError.hint,
            detail: {
              error: {
                code: textureError.code,
                message:
                  'cause' in textureError.detail ? textureError.detail.cause : textureError.hint,
                name: 'RhiDebugError',
              },
            },
          }),
        );
      }
      const viewId = registerHandle(s, res.value as object, 'textureView');
      s.textureViewHandleMap.set(res.value, viewId);

      const event: RhiCallEvent = {
        kind: 'createTextureView',
        sourceHandleId: srcId,
        resultHandleId: viewId,
        desc: {
          format: desc.format,
          dimension: desc.dimension,
          usage: desc.usage,
          aspect: desc.aspect,
          baseMipLevel: desc.baseMipLevel,
          mipLevelCount: desc.mipLevelCount,
          baseArrayLayer: desc.baseArrayLayer,
          arrayLayerCount: desc.arrayLayerCount,
        },
      };
      s.bootstrapCreates.set(viewId, event);
      pushEvent(s, event);
      return res;
    },

    createSampler(desc?: SamplerDescriptor | undefined) {
      const res = realDevice.createSampler(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createSampler',
        handleId: '' as HandleId,
        desc: desc as Partial<GPUSamplerDescriptor> | undefined,
      };
      registerHandle(s, res.value as object, 'sampler', event);
      pushEvent(s, event);
      return res;
    },

    createBindGroupLayout(desc: BindGroupLayoutDescriptor) {
      const res = realDevice.createBindGroupLayout(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createBindGroupLayout',
        handleId: '' as HandleId,
        desc: { label: desc.label, entries: desc.entries ?? [] },
      };
      registerHandle(s, res.value as object, 'bindGroupLayout', event);
      pushEvent(s, event);
      return res;
    },

    createBindGroup(desc: BindGroupDescriptor) {
      const res = realDevice.createBindGroup(desc);
      if (!res.ok) return res;
      const layoutId = getHandleId(s, desc.layout as object, 'bindGroupLayout');
      const resourceHandleIds: HandleId[] = [];
      const unresolvedExternal: { key: object; index: number }[] = [];
      const entries = Array.from(desc.entries).map((e, index) => {
        const r = e.resource;
        const entry: {
          binding: number;
          resourceKind: RhiBindResourceKind;
          bufferOffset?: number;
          bufferSize?: number;
        } = { binding: e.binding, resourceKind: r.kind };
        switch (r.kind) {
          case 'sampler':
            resourceHandleIds.push(getHandleId(s, r.value as object, 'sampler'));
            break;
          case 'buffer': {
            resourceHandleIds.push(getHandleId(s, r.value.buffer as object, 'buffer'));
            // Capture the bound sub-range so a dynamic-offset slice (e.g. a
            // 256 B view of a 256 KiB pool) replays as that slice, not the
            // whole buffer.
            const { offset, size } = r.value;
            if (offset !== undefined) entry.bufferOffset = offset;
            if (size !== undefined) entry.bufferSize = size;
            break;
          }
          case 'textureView':
            resourceHandleIds.push(getHandleId(s, r.value as object, 'textureView'));
            break;
          case 'externalTexture': {
            // A recorded external texture binds its upload view; an unknown
            // one stays pending until its upload view is recorded.
            const viewId = s.handleMap.get(r.value as object)?.handleId;
            if (viewId === undefined) {
              resourceHandleIds.push(UNKNOWN_EXTERNAL);
              unresolvedExternal.push({ key: r.value as object, index });
            } else {
              entry.resourceKind = 'textureView';
              resourceHandleIds.push(viewId);
            }
            break;
          }
          case 'accelerationStructure':
            resourceHandleIds.push(getHandleId(s, r.value as object, 'tlas'));
            break;
        }
        return entry;
      });
      const event: RhiCallEvent = {
        kind: 'createBindGroup',
        handleId: '' as HandleId,
        layoutHandleId: layoutId,
        entries,
        resourceHandleIds,
      };
      for (const { key, index } of unresolvedExternal) {
        const pending = s.pendingExternalBindings.get(key) ?? [];
        pending.push({ event, index });
        s.pendingExternalBindings.set(key, pending);
      }
      registerHandle(s, res.value as object, 'bindGroup', event);
      pushEvent(s, event);
      return res;
    },

    createPipelineLayout(desc: PipelineLayoutDescriptor) {
      const res = realDevice.createPipelineLayout(desc);
      if (!res.ok) return res;
      const bglIds = Array.from(desc.bindGroupLayouts).map((bgl) =>
        getHandleId(s, bgl as object, 'bindGroupLayout'),
      );
      const event: RhiCallEvent = {
        kind: 'createPipelineLayout',
        handleId: '' as HandleId,
        bglHandleIds: bglIds,
      };
      registerHandle(s, res.value as object, 'pipelineLayout', event);
      pushEvent(s, event);
      return res;
    },

    createRenderPipeline(desc: RenderPipelineDescriptor) {
      const res = realDevice.createRenderPipeline(desc);
      if (!res.ok) return res;
      return recordRenderPipeline(res.value, captureRenderPipeline(desc));
    },
    ...(realDevice.createRenderPipelineAsync === undefined
      ? {}
      : {
          createRenderPipelineAsync(desc: RenderPipelineDescriptor) {
            try {
              const create = realDevice.createRenderPipelineAsync;
              if (create === undefined) return realDevice.createRenderPipeline(desc);
              // Capture the native call's descriptor before its completion permits caller mutation.
              const completion = create.call(realDevice, desc);
              const event = captureRenderPipeline(desc);
              // forgeax-async-whitelist: dom-native - preserve backend pipeline completion through capture.
              const record = (result: Result<RenderPipeline, RhiError>) =>
                result.ok ? recordRenderPipeline(result.value, event) : result;
              return 'ok' in completion ? record(completion) : completion.then(record);
            } catch (cause) {
              return Promise.reject(cause);
            }
          },
        }),

    createComputePipeline(desc: ComputePipelineDescriptor) {
      const result = realDevice.createComputePipeline(desc);
      return result.ok ? recordComputePipeline(result.value, captureComputePipeline(desc)) : result;
    },
    ...(realDevice.createComputePipelineAsync === undefined
      ? {}
      : {
          createComputePipelineAsync(desc: ComputePipelineDescriptor) {
            try {
              const create = realDevice.createComputePipelineAsync;
              if (create === undefined) return realDevice.createComputePipeline(desc);
              const completion = create.call(realDevice, desc);
              const event = captureComputePipeline(desc);
              // forgeax-async-whitelist: dom-native - preserve native compute completion through capture.
              const record = (result: Result<ComputePipeline, RhiError>) =>
                result.ok ? recordComputePipeline(result.value, event) : result;
              return 'ok' in completion ? record(completion) : completion.then(record);
            } catch (cause) {
              return Promise.reject(cause);
            }
          },
        }),

    createQuerySet(desc: QuerySetDescriptor) {
      const res = realDevice.createQuerySet(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createQuerySet',
        handleId: '' as HandleId,
        desc: {
          ...(desc.label === undefined ? {} : { label: desc.label }),
          type: desc.type ?? 'occlusion',
          count: desc.count ?? 0,
        },
      };
      registerHandle(s, res.value as object, 'querySet', event);
      pushEvent(s, event);
      return res;
    },

    createBlas(desc: BlasDescriptor) {
      const res = realDevice.createBlas(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createBlas',
        handleId: '' as HandleId,
        desc: JSON.parse(JSON.stringify(desc)),
      };
      registerHandle(s, res.value as object, 'blas', event);
      pushEvent(s, event);
      return res;
    },
    createTlas(desc: TlasDescriptor) {
      const res = realDevice.createTlas(desc);
      if (!res.ok) return res;
      const event: RhiCallEvent = {
        kind: 'createTlas',
        handleId: '' as HandleId,
        desc: JSON.parse(JSON.stringify(desc)),
      };
      registerHandle(s, res.value as object, 'tlas', event);
      pushEvent(s, event);
      return res;
    },
    destroyBlas(blas: Blas) {
      const hId = s.handleMap.get(blas as object)?.handleId;
      const res = realDevice.destroyBlas(blas);
      if (res.ok && hId !== undefined) retireBootstrapHandle(s, hId, 'destroyBlas');
      return res;
    },
    destroyTlas(tlas: Tlas) {
      const hId = s.handleMap.get(tlas as object)?.handleId;
      const res = realDevice.destroyTlas(tlas);
      if (res.ok && hId !== undefined) retireBootstrapHandle(s, hId, 'destroyTlas');
      return res;
    },

    destroyBuffer(buf: Buffer) {
      const hId = s.handleMap.get(buf as object)?.handleId;
      const res = realDevice.destroyBuffer(buf);
      if (!res.ok) return res;
      if (hId !== undefined) {
        s.descriptorTable.delete(hId);
        s.indexBufferShadow.delete(hId);
        // Bound bootstrapCreates growth: an idle-destroyed resource can never
        // be referenced by a future frame's events, so drop its create event.
        // Only when NOT recording — mid-capture, an earlier frame event may
        // still reference this handle, and the tape prefix needs its create
        // event to stay self-contained (tape-invalid otherwise).
        //
        // Known bounded residual: a resource destroyed DURING a capture keeps
        // its bootstrapCreates entry forever — the entry is only ever revisited
        // by another destroy* of the SAME handle, which can't recur after the
        // resource is gone. This leaks one create event per resource that is
        // both created and destroyed inside a recording window (a narrow set;
        // most resources are long-lived). Fixing it needs a defer-delete list
        // swept at the next arm() — deliberately not added: the extra state
        // costs more than the leak it plugs (see PR discussion).
        //
        // Separate, wider residual: bootstrapCreates entries for
        // textureView / bindGroup / pipeline / sampler are NEVER pruned,
        // because RhiDevice exposes destroy only for buffer / texture -- a
        // faithful mirror of WebGPU, whose spec puts .destroy() solely on
        // GPUBuffer / GPUTexture (the objects holding large, eagerly-freeable
        // backing memory); views / bind groups / pipelines / samplers are
        // lightweight reference objects left to GC. So there is no destroy
        // signal to hook for them. An app that rebuilds these per frame grows
        // bootstrapCreates under a long idle run. The GC-aligned fix is a
        // WeakRef + FinalizationRegistry over the create-event objects (same
        // spirit as handleMap's WeakMap, but keyed by handleId so it needs the
        // WeakRef wrapper) -- a finalization-semantics change, out of scope here.
        if (
          !retainsCaptureBootstrap(s) &&
          !s.snapshotSeededHandles.has(hId) &&
          !hasBootstrapDependency(s, hId)
        ) {
          s.bootstrapCreates.delete(hId);
        }
        pushEvent(s, { kind: 'destroyBuffer', handleId: hId });
      }
      return res;
    },

    destroyQuerySet(querySet: QuerySet) {
      const hId = s.handleMap.get(querySet as object)?.handleId;
      const res = realDevice.destroyQuerySet(querySet);
      if (!res.ok) return res;
      if (hId !== undefined) {
        if (
          !retainsCaptureBootstrap(s) &&
          !s.snapshotSeededHandles.has(hId) &&
          !hasBootstrapDependency(s, hId)
        ) {
          s.bootstrapCreates.delete(hId);
        }
        pushEvent(s, { kind: 'destroyQuerySet', handleId: hId });
      }
      return res;
    },

    destroyTexture(tex: Texture) {
      const hId = s.handleMap.get(tex as object)?.handleId;
      const res = realDevice.destroyTexture(tex);
      if (!res.ok) return res;
      if (hId !== undefined) {
        s.descriptorTable.delete(hId);
        s.tinyTextureShadow.delete(hId);
        // Same gate + same bounded residual as destroyBuffer above.
        if (
          !retainsCaptureBootstrap(s) &&
          !s.snapshotSeededHandles.has(hId) &&
          !hasBootstrapDependency(s, hId)
        ) {
          s.bootstrapCreates.delete(hId);
        }
        pushEvent(s, { kind: 'destroyTexture', handleId: hId });
      }
      return res;
    },

    createRenderBundleEncoder(desc) {
      const result = realDevice.createRenderBundleEncoder(desc);
      return result.ok ? makeOk(createRenderBundleProxy(s, result.value)) : result;
    },

    createCommandEncoder(desc?: CommandEncoderDescriptor | undefined) {
      const res = realDevice.createCommandEncoder(desc);
      if (!res.ok) return res;
      // Idle fast-path: return the real (un-proxied) encoder when not
      // recording. One gate here elides the proxy wrapper AND every
      // beginRenderPass/draw/setBindGroup/copy* call that would otherwise
      // route through proxyCmdEncoder + proxyRenderPass only to be dropped
      // by the pushEvent gate. Safe because a frame body runs synchronously
      // in one rAF callback: createCommandEncoder -> passes -> queue.submit
      // all observe the same recorder state (arm() only fires between frames),
      // so an idle-created encoder's whole frame is consistently un-recorded,
      // matching the now-gated queue.submit which skips its handle lookup.
      if (!shouldRecord(s)) {
        // Ray Query builds and WebGL2 INDEX writes change a later capture's
        // starting state; other idle encoders keep the direct fast path.
        return realDevice.caps.rayQuery.supported || s.indexBufferShadow.size > 0
          ? makeOk(observeIdleResourceMutations(s, res.value))
          : res;
      }
      const cmdId = allocHandleId('commandEncoder');
      pushEvent(s, {
        kind: 'createCommandEncoder',
        cmdHandleId: cmdId,
        desc: desc as Partial<GPUCommandEncoderDescriptor> | undefined,
      });
      const proxyEnc = createCommandEncoderProxy(s, res.value, cmdId);
      return makeOk(proxyEnc as RhiCommandEncoder) as Result<
        RhiCommandEncoder,
        import('@forgeax/engine-rhi').RhiError
      >;
    },
  };
  return d;
}

function retireBootstrapHandle(
  s: RecorderInternal,
  hId: HandleId,
  kind: 'destroyBlas' | 'destroyTlas',
): void {
  if (
    !retainsCaptureBootstrap(s) &&
    !s.snapshotSeededHandles.has(hId) &&
    !hasBootstrapDependency(s, hId)
  ) {
    s.bootstrapCreates.delete(hId);
  }
  pushEvent(s, { kind, handleId: hId });
}

// --------------------------------------------------
// wrap RhiInstance
// --------------------------------------------------
