// Opt-in Node-API native Rust wgpu 30 dedicated OS render thread backend for @forgeax/engine-render-kernel.
// Keeps the main `@forgeax/engine-render-kernel` entrypoint 100% browser-portable while enabling
// off-main-thread culling, pass planning, and native Metal/DX12/Vulkan command encoding in Node hosts.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { FrameRecorder } from '../command-stream.js';
import type {
  FrameSubmitReceipt,
  KernelBackendKind,
  KernelBufferDesc,
  KernelCullParams,
  KernelCullSummary,
  KernelMaterialDesc,
  KernelMeshDesc,
  KernelSamplerDesc,
  KernelShaderProgramDesc,
  KernelTextureDesc,
  KernelVisibleLightSummary,
} from '../contract.js';
import {
  type DynamicTextureDesc,
  type DynamicTextureUploadSource,
  isByteDynamicSource,
} from '../dynamic-texture.js';
import { type KernelError, kernelErr, ok, type Result } from '../errors.js';
import type {
  BufferId,
  CullId,
  DynamicTextureId,
  LightId,
  MaterialId,
  MeshId,
  RenderObjectId,
  SamplerId,
  ShaderProgramId,
  TextureId,
} from '../handles.js';
import { SceneDeltaWriter } from '../scene-delta.js';

interface NativeVisibleLightJs {
  readonly lightId: number;
  readonly kind: number;
  readonly castShadow: boolean;
  readonly cascadeCount: number;
  readonly screenCoverage: number;
}

interface NativeCullSummaryJs {
  readonly cullId: number;
  readonly candidateCount: number;
  readonly visibleOpaqueCount: number;
  readonly visibleMaskedCount: number;
  readonly visibleTransparentCount: number;
  readonly visibleShadowCasterCount: number;
  readonly visibleBoundsMin: readonly number[];
  readonly visibleBoundsMax: readonly number[];
  readonly visibleLights: readonly NativeVisibleLightJs[];
}

interface NativeFrameReceiptJs {
  readonly frameId: number;
  readonly sceneRevision: number;
  readonly submittedPassCount: number;
  readonly mergedPassCount: number;
  readonly submittedDrawCount: number;
  readonly submittedIndirectCount: number;
  readonly pendingPipelineCount: number;
  readonly firstMissingObjectId: number;
  readonly firstMissingSubmesh: number;
  readonly poolTextureCount: number;
  readonly poolAllocations: number;
  readonly poolReuses: number;
  readonly executedPasses: number;
  readonly planUs: number;
  readonly encodeSubmitUs: number;
  readonly resolvedPhysicalCommands: Uint32Array;
  readonly submittedBitmap: Uint32Array;
}

export interface NativeReadbackTexture {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface NativeWindowOptions {
  readonly title: string;
  readonly width: number;
  readonly height: number;
}

export interface NativeWindowFacts {
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
  readonly visible: boolean;
}

export interface NativeWindowEvent {
  readonly kind:
    | 'close-requested'
    | 'resized'
    | 'scale-changed'
    | 'redraw'
    | 'focus'
    | 'visibility'
    | 'key-down'
    | 'key-up'
    | 'pointer-move'
    | 'pointer-down'
    | 'pointer-up'
    | 'pointer-wheel'
    | 'pointer-leave'
    | 'pointer-relative'
    | 'ime-preedit'
    | 'ime-commit'
    | 'ime-cancel'
    | string;
  readonly width?: number;
  readonly height?: number;
  readonly scaleFactor?: number;
  readonly focused?: boolean;
  readonly visible?: boolean;
  readonly code?: string;
  readonly key?: string;
  readonly text?: string;
  readonly repeat?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly dx?: number;
  readonly dy?: number;
  readonly button?: 'left' | 'right' | 'middle' | string;
  readonly generation?: number;
}

export interface NativeThreadStats {
  readonly submittedFrames: number;
  readonly completedFrames: number;
  readonly lastCompletedFrameId: number;
  readonly inFlightFrames: number;
  readonly totalPlanUs: number;
  readonly totalEncodeSubmitUs: number;
  readonly lastPlanUs: number;
  readonly lastEncodeSubmitUs: number;
  readonly dirtyRowsUploaded: number;
  readonly dirtyRangeWrites: number;
  readonly materialUploads: number;
  readonly surfacePresents: number;
  readonly gpuMemoryBytes: number;
  readonly poolMemoryBytes: number;
  readonly deviceGeneration: number;
  readonly recoveryCount: number;
  readonly surfaceFormat?: string;
  readonly adapterName: string;
  readonly backendName: string;
}

interface NativeAddonHandle {
  pollWindowEvents(): NativeWindowEvent[];
  resizeWindow(width: number, height: number): void;
  windowSize(): number[];
  windowFacts(): NativeWindowFacts;
  requestRedraw(): void;
  setPointerLock(locked: boolean): boolean;
  setImeArea(area?: number[] | null): number;
  createMesh(descJson: string, vertexBytes: Uint8Array, indexBytes?: Uint8Array): number;
  destroyMesh(id: number): void;
  createTexture(descJson: string, initialBytes?: Uint8Array): number;
  destroyTexture(id: number): void;
  createDynamicTexture(width: number, height: number, formatCode: number): number;
  uploadDynamicTexture(
    id: number,
    revision: number,
    width: number,
    height: number,
    bytes: Uint8Array,
  ): boolean;
  destroyDynamicTexture(id: number): void;
  createBuffer(descJson: string, initialBytes?: Uint8Array): number;
  writeBuffer(id: number, offset: number, bytes: Uint8Array): void;
  destroyBuffer(id: number): void;
  createSampler(descJson: string): number;
  destroySampler(id: number): void;
  registerShaderProgram(descJson: string): number;
  destroyShaderProgram(id: number): void;
  createMaterial(descJson: string, initialParamBytes: Uint8Array): number;
  destroyMaterial(id: number): void;
  commitSceneDelta(bytes: Uint8Array): number;
  beginFrame(frameId: number, width: number, height: number): void;
  cull(
    viewProj: Float32Array,
    cameraPos: Float32Array,
    layerMask: number,
    flags: number,
    lodBias: number,
  ): NativeCullSummaryJs;
  submitFrameSync(inputCmds: Uint32Array, uniformBytes: Uint8Array): NativeFrameReceiptJs;
  submitPipelinedFrameAsync(
    frameId: number,
    width: number,
    height: number,
    deltaBytes: Uint8Array | null,
    cullsJson: string,
    inputCmds: Uint32Array,
    uniformBytes: Uint8Array,
  ): number;
  readbackPoolTexture(slotId: number): { width: number; height: number; pixels: Uint8Array };
  readbackBuffer(bufId: number, offset: number, size: number): Uint8Array;
  readbackTicket(ticketId: number): {
    width: number;
    height: number;
    format: GPUTextureFormat;
    pixels: Uint8Array;
  };
  flush(): void;
  trimPoolTextures(): number;
  recoverDevice(): number;
  stats(): NativeThreadStats;
  dispose(): void;
}

interface NativeAddonModule {
  nativeKernelVersion(): string;
  NativeRenderKernelHandle: new (
    maxInFlight?: number,
    windowOptionsJson?: string | null,
  ) => NativeAddonHandle;
}

const cachedAddons = new Map<string, NativeAddonModule | null>();

export function resolveNativeAddonPath(overridePath?: string): string {
  if (overridePath !== undefined && overridePath.length > 0) {
    return overridePath;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const file = `forgeax-render-kernel.${process.platform}-${process.arch}.node`;
  const candidates = [
    join(here, '..', '..', 'native', file),
    join(here, '..', 'native', file),
    join(here, 'native', file),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] as string;
}

function loadNativeAddon(overridePath?: string): Result<NativeAddonModule, KernelError> {
  const addonPath = resolveNativeAddonPath(overridePath);
  const cached = cachedAddons.get(addonPath);
  if (cached !== undefined) {
    if (cached === null) {
      return kernelErr(
        'kernel-capability-unsupported',
        'NativeRenderKernel',
        `built native .node addon at ${addonPath}`,
        'run `pnpm --filter @forgeax/engine-render-kernel build:native`',
      );
    }
    return ok(cached);
  }
  if (!existsSync(addonPath)) {
    cachedAddons.set(addonPath, null);
    return kernelErr(
      'kernel-capability-unsupported',
      'NativeRenderKernel',
      `addon at ${addonPath}`,
      'run `pnpm --filter @forgeax/engine-render-kernel build:native`',
    );
  }
  try {
    const req = createRequire(import.meta.url);
    const mod = req(addonPath) as NativeAddonModule;
    cachedAddons.set(addonPath, mod);
    return ok(mod);
  } catch (error) {
    cachedAddons.set(addonPath, null);
    return kernelErr(
      'kernel-capability-unsupported',
      'NativeRenderKernel',
      'loadable napi-rs addon',
      String(error),
    );
  }
}

export function isNativeRenderKernelAvailable(addonPath?: string): boolean {
  return loadNativeAddon(addonPath).ok;
}

export interface CreateNativeRenderKernelOptions {
  /** Maximum number of async pipelined frames in flight on the dedicated OS render thread (default 2). */
  readonly maxInFlight?: number;
  /** Optional native OS window for direct zero-copy `wgpu::Surface` presentation via `SURFACE_SWAPCHAIN_HANDLE`. */
  readonly window?: NativeWindowOptions;
  /** Optional explicit path to a prebuilt/relocated `forgeax-render-kernel.<platform>-<arch>.node` binary. */
  readonly addonPath?: string;
}

export interface NativeFrameReceipt extends FrameSubmitReceipt {
  readonly executedPasses: number;
  readonly planUs: number;
  readonly encodeSubmitUs: number;
}

export interface NativeKernelAssetApi {
  createMesh(
    desc: KernelMeshDesc,
    vertexBytes: Uint8Array,
    indexBytes?: Uint8Array,
  ): Result<MeshId, KernelError>;
  destroyMesh(id: MeshId): Result<void, KernelError>;
  createTexture(desc: KernelTextureDesc, initialBytes?: Uint8Array): Result<TextureId, KernelError>;
  destroyTexture(id: TextureId): Result<void, KernelError>;
  createDynamicTexture(desc: DynamicTextureDesc): Result<DynamicTextureId, KernelError>;
  uploadDynamicTexture(
    id: DynamicTextureId,
    revision: number,
    width: number,
    height: number,
    source: DynamicTextureUploadSource,
  ): Result<boolean, KernelError>;
  destroyDynamicTexture(id: DynamicTextureId): Result<void, KernelError>;
  createBuffer(desc: KernelBufferDesc, initialBytes?: Uint8Array): Result<BufferId, KernelError>;
  writeBuffer(id: BufferId, offset: number, bytes: Uint8Array): Result<void, KernelError>;
  destroyBuffer(id: BufferId): Result<void, KernelError>;
  createSampler(desc: KernelSamplerDesc): Result<SamplerId, KernelError>;
  destroySampler(id: SamplerId): Result<void, KernelError>;
  registerShaderProgram(desc: KernelShaderProgramDesc): Result<ShaderProgramId, KernelError>;
  destroyShaderProgram(id: ShaderProgramId): Result<void, KernelError>;
  createMaterial(
    desc: KernelMaterialDesc,
    initialParamBytes: Uint8Array,
  ): Result<MaterialId, KernelError>;
  destroyMaterial(id: MaterialId): Result<void, KernelError>;
}

/**
 * Native Rust wgpu 30 RenderKernel running on a dedicated OS render thread via napi-rs.
 * Accepts the exact same binary SceneDelta (`FXK1`) and FrameRecorder bytecode as TS/WASM kernels
 * and adds non-blocking `submitPipelinedFrameAsync` to keep JS main-thread render overhead near zero.
 */
export class NativeRenderKernel {
  readonly backendKind: KernelBackendKind = 'rust-wgpu-native';
  readonly mode = 'native' as const;
  readonly supportsScene4Bgl = true;
  readonly version: string;
  readonly assets: NativeKernelAssetApi;

  private readonly handle: NativeAddonHandle;
  private readonly deltaWriter = new SceneDeltaWriter();
  private readonly recorder = new FrameRecorder();
  private readonly camScratch = new Float32Array(3);
  private pendingFrameId = 0;
  private pendingWidth = 1;
  private pendingHeight = 1;

  constructor(addon: NativeAddonModule, maxInFlight = 2, window?: NativeWindowOptions) {
    this.version = addon.nativeKernelVersion();
    this.handle = new addon.NativeRenderKernelHandle(
      maxInFlight,
      window !== undefined ? JSON.stringify(window) : null,
    );
    this.assets = {
      createMesh: (desc, vertexBytes, indexBytes) =>
        this.wrap(
          'createMesh',
          () => this.handle.createMesh(JSON.stringify(desc), vertexBytes, indexBytes) as MeshId,
        ),
      destroyMesh: (id) => this.wrap('destroyMesh', () => this.handle.destroyMesh(id)),
      createTexture: (desc, initialBytes) =>
        this.wrap(
          'createTexture',
          () => this.handle.createTexture(JSON.stringify(desc), initialBytes) as TextureId,
        ),
      destroyTexture: (id) => this.wrap('destroyTexture', () => this.handle.destroyTexture(id)),
      createDynamicTexture: (desc) =>
        this.wrap(
          'createDynamicTexture',
          () =>
            this.handle.createDynamicTexture(
              desc.width,
              desc.height,
              desc.format,
            ) as DynamicTextureId,
        ),
      uploadDynamicTexture: (id, revision, width, height, source) => {
        if (!isByteDynamicSource(source)) {
          return kernelErr(
            'kernel-backend-runtime-error',
            'NativeRenderKernel.uploadDynamicTexture',
            'Uint8Array / ArrayBufferView byte source',
            'native wgpu thread requires raw pixel bytes rather than DOM canvas/video sources',
            id,
          );
        }
        return this.wrap('uploadDynamicTexture', () =>
          this.handle.uploadDynamicTexture(id, revision, width, height, source),
        );
      },
      destroyDynamicTexture: (id) =>
        this.wrap('destroyDynamicTexture', () => this.handle.destroyDynamicTexture(id)),
      createBuffer: (desc, initialBytes) =>
        this.wrap(
          'createBuffer',
          () => this.handle.createBuffer(JSON.stringify(desc), initialBytes) as BufferId,
        ),
      writeBuffer: (id, offset, bytes) =>
        this.wrap('writeBuffer', () => this.handle.writeBuffer(id, offset, bytes)),
      destroyBuffer: (id) => this.wrap('destroyBuffer', () => this.handle.destroyBuffer(id)),
      createSampler: (desc) =>
        this.wrap(
          'createSampler',
          () => this.handle.createSampler(JSON.stringify(desc)) as SamplerId,
        ),
      destroySampler: (id) => this.wrap('destroySampler', () => this.handle.destroySampler(id)),
      registerShaderProgram: (desc) =>
        this.wrap(
          'registerShaderProgram',
          () => this.handle.registerShaderProgram(JSON.stringify(desc)) as ShaderProgramId,
        ),
      destroyShaderProgram: (id) =>
        this.wrap('destroyShaderProgram', () => this.handle.destroyShaderProgram(id)),
      createMaterial: (desc, initialParamBytes) =>
        this.wrap(
          'createMaterial',
          () => this.handle.createMaterial(JSON.stringify(desc), initialParamBytes) as MaterialId,
        ),
      destroyMaterial: (id) => this.wrap('destroyMaterial', () => this.handle.destroyMaterial(id)),
    };
  }

  private wrap<T>(op: string, fn: () => T): Result<T, KernelError> {
    try {
      return ok(fn());
    } catch (error) {
      return kernelErr(
        'kernel-backend-runtime-error',
        `NativeRenderKernel.${op}`,
        op,
        String(error),
      );
    }
  }

  beginSceneDelta(minBytes?: number): SceneDeltaWriter {
    if (minBytes !== undefined && minBytes > 0) {
      return new SceneDeltaWriter(minBytes);
    }
    return this.deltaWriter;
  }

  commitSceneDelta(writer: SceneDeltaWriter): Result<number, KernelError> {
    return this.wrap('commitSceneDelta', () => this.handle.commitSceneDelta(writer.finish()));
  }

  beginFrame(
    frameId: number,
    surfaceWidth: number,
    surfaceHeight: number,
  ): Result<FrameRecorder, KernelError> {
    const res = this.wrap('beginFrame', () =>
      this.handle.beginFrame(frameId, surfaceWidth, surfaceHeight),
    );
    if (!res.ok) return res;
    this.pendingFrameId = frameId;
    this.pendingWidth = surfaceWidth;
    this.pendingHeight = surfaceHeight;
    this.recorder.reset();
    return ok(this.recorder);
  }

  cull(params: KernelCullParams): Result<KernelCullSummary, KernelError> {
    this.camScratch[0] = params.cameraPos[0];
    this.camScratch[1] = params.cameraPos[1];
    this.camScratch[2] = params.cameraPos[2];
    return this.wrap('cull', () => {
      const s = this.handle.cull(
        params.viewProj,
        this.camScratch,
        params.layerMask ?? 0xffff_ffff,
        params.flags ?? 0,
        params.lodBias ?? 0,
      );
      const visibleLights: KernelVisibleLightSummary[] = s.visibleLights.map((l) => ({
        lightId: l.lightId as LightId,
        kind: l.kind as 0 | 1 | 2,
        castShadow: l.castShadow,
        cascadeCount: l.cascadeCount,
        screenCoverage: l.screenCoverage,
      }));
      return {
        cullId: s.cullId as CullId,
        candidateCount: s.candidateCount,
        visibleOpaqueCount: s.visibleOpaqueCount,
        visibleMaskedCount: s.visibleMaskedCount,
        visibleTransparentCount: s.visibleTransparentCount,
        visibleShadowCasterCount: s.visibleShadowCasterCount,
        visibleBoundsMin: [
          s.visibleBoundsMin[0] ?? 0,
          s.visibleBoundsMin[1] ?? 0,
          s.visibleBoundsMin[2] ?? 0,
        ],
        visibleBoundsMax: [
          s.visibleBoundsMax[0] ?? 0,
          s.visibleBoundsMax[1] ?? 0,
          s.visibleBoundsMax[2] ?? 0,
        ],
        visibleLights,
      };
    });
  }

  submitFrame(recorder: FrameRecorder): Result<NativeFrameReceipt, KernelError> {
    return this.wrap('submitFrame', () => {
      const r = this.handle.submitFrameSync(recorder.commandSlice, recorder.uniformDataSlice);
      return {
        frameId: r.frameId,
        sceneRevision: r.sceneRevision,
        status: r.pendingPipelineCount > 0 ? 'pending-pipelines' : 'ready',
        submittedPassCount: r.submittedPassCount,
        mergedPassCount: r.mergedPassCount,
        submittedDrawCount: r.submittedDrawCount,
        submittedIndirectCount: r.submittedIndirectCount,
        pendingPipelineCount: r.pendingPipelineCount,
        firstMissingObjectId: r.firstMissingObjectId as RenderObjectId | 0,
        firstMissingSubmesh: r.firstMissingSubmesh,
        poolTextureCount: r.poolTextureCount,
        poolAllocations: r.poolAllocations,
        poolReuses: r.poolReuses,
        executedPasses: r.executedPasses,
        planUs: r.planUs,
        encodeSubmitUs: r.encodeSubmitUs,
        resolvedPhysicalCommands: r.resolvedPhysicalCommands,
        submittedBitmap: r.submittedBitmap,
      };
    });
  }

  /**
   * Prepares a reusable FrameRecorder for an async pipelined frame without any synchronous
   * cross-thread `beginFrame` round-trip. Pass the recorded commands to `submitPipelinedFrameAsync`.
   */
  preparePipelinedRecorder(
    frameId: number,
    surfaceWidth: number,
    surfaceHeight: number,
  ): FrameRecorder {
    this.pendingFrameId = frameId;
    this.pendingWidth = surfaceWidth;
    this.pendingHeight = surfaceHeight;
    this.recorder.reset();
    return this.recorder;
  }

  /**
   * Non-blocking fire-and-forget frame submission to the dedicated OS render thread.
   * Offloads SceneDelta application, frustum/light culling, two-pass RT planning,
   * draw sorting/instancing, and native wgpu encoding/submission off the JS main thread.
   */
  submitPipelinedFrameAsync(
    recorder: FrameRecorder,
    options?: {
      readonly delta?: SceneDeltaWriter;
      readonly culls?: readonly KernelCullParams[];
    },
  ): Result<number, KernelError> {
    const deltaBytes = options?.delta !== undefined ? options.delta.finish() : null;
    const cullsJson =
      options?.culls === undefined || options.culls.length === 0
        ? '[]'
        : JSON.stringify(
            options.culls.map((c) => ({
              viewProj: Array.from(c.viewProj),
              cameraPos: c.cameraPos,
              layerMask: c.layerMask ?? 0xffff_ffff,
              flags: c.flags ?? 0,
              lodBias: c.lodBias ?? 0,
            })),
          );
    return this.wrap('submitPipelinedFrameAsync', () =>
      this.handle.submitPipelinedFrameAsync(
        this.pendingFrameId,
        this.pendingWidth,
        this.pendingHeight,
        deltaBytes,
        cullsJson,
        recorder.commandSlice,
        recorder.uniformDataSlice,
      ),
    );
  }

  readbackPoolTexture(slotId: number): Result<NativeReadbackTexture, KernelError> {
    return this.wrap('readbackPoolTexture', () => {
      const res = this.handle.readbackPoolTexture(slotId);
      return {
        width: res.width,
        height: res.height,
        pixels: new Uint8Array(res.pixels.buffer, res.pixels.byteOffset, res.pixels.byteLength),
      };
    });
  }

  readbackBuffer(bufId: BufferId, offset: number, size: number): Result<Uint8Array, KernelError> {
    return this.wrap('readbackBuffer', () => {
      const buf = this.handle.readbackBuffer(bufId, offset, size);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
  }

  readbackTicketSync(
    ticketId: number,
  ): Result<import('../contract.js').KernelReadbackResult, KernelError> {
    return this.wrap('readbackTicket', () => {
      const res = this.handle.readbackTicket(ticketId);
      return {
        width: res.width,
        height: res.height,
        format: res.format,
        pixels: new Uint8Array(res.pixels.buffer, res.pixels.byteOffset, res.pixels.byteLength),
      };
    });
  }

  async readbackTicket(
    ticketId: number,
  ): Promise<Result<import('../contract.js').KernelReadbackResult, KernelError>> {
    return this.readbackTicketSync(ticketId);
  }

  pollWindowEvents(): Result<readonly NativeWindowEvent[], KernelError> {
    return this.wrap('pollWindowEvents', () => this.handle.pollWindowEvents());
  }

  resizeWindow(width: number, height: number): Result<void, KernelError> {
    return this.wrap('resizeWindow', () => this.handle.resizeWindow(width, height));
  }

  getWindowPhysicalSize(): Result<readonly [number, number], KernelError> {
    return this.wrap('getWindowPhysicalSize', () => {
      const sz = this.handle.windowSize();
      return [sz[0] ?? 0, sz[1] ?? 0] as const;
    });
  }

  getWindowFacts(): Result<NativeWindowFacts, KernelError> {
    return this.wrap('getWindowFacts', () => this.handle.windowFacts());
  }

  requestRedraw(): Result<void, KernelError> {
    return this.wrap('requestRedraw', () => this.handle.requestRedraw());
  }

  setPointerLock(locked: boolean): Result<boolean, KernelError> {
    return this.wrap('setPointerLock', () => this.handle.setPointerLock(locked));
  }

  setImeArea(area: readonly [number, number, number, number] | null): Result<number, KernelError> {
    return this.wrap('setImeArea', () =>
      this.handle.setImeArea(area === null ? null : [area[0], area[1], area[2], area[3]]),
    );
  }

  flush(): Result<void, KernelError> {
    return this.wrap('flush', () => this.handle.flush());
  }

  trimPoolTextures(): Result<number, KernelError> {
    return this.wrap('trimPoolTextures', () => this.handle.trimPoolTextures());
  }

  recoverDevice(): Result<number, KernelError> {
    return this.wrap('recoverDevice', () => this.handle.recoverDevice());
  }

  getThreadStats(): Result<NativeThreadStats, KernelError> {
    return this.wrap('getThreadStats', () => this.handle.stats());
  }

  dispose(): void {
    this.handle.dispose();
  }
}

export function createNativeRenderKernel(
  options?: CreateNativeRenderKernelOptions,
): Result<NativeRenderKernel, KernelError> {
  const addonRes = loadNativeAddon(options?.addonPath);
  if (!addonRes.ok) return addonRes;
  try {
    return ok(new NativeRenderKernel(addonRes.value, options?.maxInFlight ?? 2, options?.window));
  } catch (error) {
    return kernelErr(
      'kernel-capability-unsupported',
      'createNativeRenderKernel',
      'native wgpu device & render thread',
      String(error),
    );
  }
}

export type { KernelError } from '../errors.js';
export {
  createDesktopNativeSceneRenderer,
  type DesktopBloomInput,
  type DesktopCameraInput,
  type DesktopCustomShaderOptions,
  type DesktopFogInput,
  type DesktopFrameInput,
  type DesktopIncrementalFrameInput,
  type DesktopLightInput,
  type DesktopMaterialInput,
  type DesktopMeshInput,
  DesktopNativeSceneRenderer,
  type DesktopNativeSceneRendererOptions,
  type DesktopRenderObjectInput,
  type DesktopResourceKey,
  type DesktopSceneStats,
  type DesktopSkyboxInput,
  type DesktopSkylightInput,
  type DesktopSubmeshInput,
  type DesktopTextureInput,
  type DesktopWitnessFrameResult,
  desktopMat4Invert,
  desktopMat4LookAt,
  desktopMat4Multiply,
  desktopMat4Ortho,
  desktopMat4Perspective,
  packDesktopMeshVertices,
  packDesktopSkinnedMeshVertices,
} from './desktop-scene-renderer.js';
export type { DesktopFeatureFrameContext } from './feature-host.js';
