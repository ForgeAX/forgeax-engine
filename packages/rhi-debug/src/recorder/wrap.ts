// @forgeax/engine-rhi-debug/src/recorder/wrap -- RHI instance assembly.

/// <reference types="@webgpu/types" />

import type {
  RequestAdapterOptions,
  RequestDeviceOptions,
  Result,
  RhiAdapter,
  RhiDevice,
  RhiInstance,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok as makeOk } from '@forgeax/engine-types';
import { recordReplayCapabilities } from '../capabilities';
import type { HandleId, RhiCallEvent } from '../types';
import {
  type CreateShaderModuleFn,
  type DebugRhiInstance,
  pushEvent,
  type RecorderInternal,
  RecorderState,
  registerHandle,
} from './core';
import { createDeviceProxy } from './device';
import { createRecorderLifecycle } from './lifecycle';

export function wrap(
  instance: RhiInstance,
  createShaderModule: CreateShaderModuleFn,
): DebugRhiInstance {
  const s: RecorderInternal = {
    state: RecorderState.Idle,
    requestedFrames: 0,
    recordedFrames: 0,
    events: [],
    blobPool: new Map(),
    handleMap: new WeakMap(),
    textureViewHandleMap: new WeakMap(),
    pendingExternalBindings: new WeakMap(),
    bootstrapCreates: new Map(),
    snapshotSeededHandles: new Set(),
    omittedSeeds: new Set(),
    snapshotGeneration: 0,
    snapshotProgress: undefined,
    descriptorTable: new Map(),
    indexBufferShadow: new Map(),
    tinyTextureShadow: new Map(),
    _skipRecord: false,
    frameIdx: 0,
    bootstrap: true,
    recordedCaps: undefined,
    canvasConfiguration: undefined,
    valid: true,
    capturedDevice: undefined,
    frameEndReleases: [],
    deferredAccelerationStructureBuilds: [],
  };

  const lifecycle = createRecorderLifecycle(s, createShaderModule);
  const {
    arm,
    onFrameEnd,
    getTape,
    getState,
    getEvents,
    getBlobPool,
    transitionToError,
    disposeError,
    releaseTape,
    snapshotResource,
    snapshotAllLiveResources,
  } = lifecycle;

  const debugInst: DebugRhiInstance = {
    arm,
    onFrameEnd,
    getTape,
    getState,
    getEvents,
    getBlobPool,
    transitionToError,
    disposeError,
    releaseTape,
    snapshotResource,
    snapshotAllLiveResources,
    lookupPipeline(device, pipeline) {
      const entry = s.handleMap.get(pipeline);
      const realDevice = (device as Partial<import('./core').RecorderDevice>)._realDevice;
      if (entry === undefined || realDevice === undefined || entry.device !== realDevice)
        return undefined;
      return s.bootstrapCreates.get(entry.handleId)?.kind === 'createRenderPipeline'
        ? entry.handleId
        : undefined;
    },
    pushExternalEvent(event: RhiCallEvent): void {
      pushEvent(s, event);
    },
    registerShaderModule(handle: ShaderModule, handleId: HandleId): void {
      s.handleMap.set(handle as object, { handleId });
    },
    pushExternalCreateEvent(handle: object, kind: string, event: RhiCallEvent): HandleId {
      const hId = registerHandle(s, handle, kind, event);
      pushEvent(s, event);
      return hId;
    },
    recordCanvasConfiguration(configuration): void {
      s.canvasConfiguration = { ...configuration };
    },
    resetForDeviceLoss(): void {
      // A lost GPU device invalidates every opaque handle and every descriptor
      // entry. Keep the recorder usable for the renderer's subsequent rebuild:
      // resource and shader creation calls during recovery repopulate these
      // registries against the fresh device before the next capture arms.
      s.state = RecorderState.Idle;
      s.requestedFrames = 0;
      s.recordedFrames = 0;
      s.events = [];
      s.blobPool = new Map();
      s.handleMap = new WeakMap();
      s.textureViewHandleMap = new WeakMap();
      s.bootstrapCreates = new Map();
      s.descriptorTable = new Map();
      s.indexBufferShadow = new Map();
      s.tinyTextureShadow = new Map();
      s.snapshotSeededHandles = new Set();
      s.snapshotProgress = undefined;
      s.frameIdx = 0;
      s.bootstrap = true;
      s.recordedCaps = undefined;
      s.valid = true;
      s.capturedDevice = undefined;
      s.frameEndReleases = [];
      s.deferredAccelerationStructureBuilds = [];
    },
    valid(): boolean {
      return s.valid;
    },
    bootstrapCreatesSize(): number {
      return s.bootstrapCreates.size;
    },
    bootstrapEvents(): readonly RhiCallEvent[] {
      return Array.from(s.bootstrapCreates.values());
    },
    omittedSeeds() {
      return s.omittedSeeds;
    },
    descriptorTable() {
      return s.descriptorTable;
    },

    async requestAdapter(
      opts?: RequestAdapterOptions | undefined,
      compatibleSurface?: HTMLCanvasElement | OffscreenCanvas | undefined,
    ) {
      const res = await instance.requestAdapter(opts, compatibleSurface);
      if (!res.ok) return res;

      const realAdapter = res.value;
      const proxyAdapter: RhiAdapter = {
        features: realAdapter.features,
        limits: realAdapter.limits,
        async requestDevice(devOpts?: RequestDeviceOptions | undefined) {
          const devRes = await realAdapter.requestDevice(devOpts);
          if (!devRes.ok) return devRes;
          // Keep the proxied device available for recorder-owned readback.
          const proxied = createDeviceProxy(s, devRes.value);
          s.capturedDevice = proxied;
          const caps = proxied.caps;
          s.recordedCaps = {
            // RhiDevice does not own a canvas, so retain the existing tape
            // default for this informational field while deriving every
            // device-backed capability from the captured device.
            canvasFormat: 'bgra8unorm' as GPUTextureFormat,
            canvasColorSpace: 'srgb',
            ...recordReplayCapabilities(caps),
          };
          return makeOk(proxied) as Result<RhiDevice, import('@forgeax/engine-rhi').RhiError>;
        },
      };
      return makeOk(proxyAdapter) as Result<RhiAdapter, import('@forgeax/engine-rhi').RhiError>;
    },
  };

  return debugInst;
}
