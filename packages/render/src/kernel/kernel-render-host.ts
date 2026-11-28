// Unified `@forgeax/engine-render` ECS + RenderFeature host executing directly on RenderKernel.
// Drives an ECS World through `KernelStandardSceneRenderer` + `KernelRenderGraph`, supporting
// both native `KernelRenderFeature`s and standard `@forgeax/engine-render` `RenderFeature`s
// identically across Desktop Native (Metal/DX12/Vulkan), WebGPU/Dawn, and Browser WebGL2 WASM.

import type { World } from '@forgeax/engine-ecs';
import {
  type CompiledKernelGraphInfo,
  type FrameSubmitReceipt,
  type KernelAssetApi,
  type KernelError,
  type KernelReadbackResult,
  type KernelRenderFeature,
  type KernelResourceKey,
  type KernelStandardCustomShaderOptions,
  type KernelStandardMaterialInput,
  type KernelStandardMeshInput,
  type KernelStandardPipelineFrame,
  type KernelStandardRendererOptions,
  KernelStandardSceneRenderer,
  type KernelStandardSceneStats,
  type KernelStandardSkyboxInput,
  type KernelStandardTextureInput,
  kernelErr,
  ok,
  type RenderKernelExecutionTarget,
  type Result,
} from '@forgeax/engine-render-kernel';
import type { RenderFeature } from '../features/types';
import { extractWorldToKernelFrame } from './ecs-extract';
import { type AdaptedRenderFeatureRuntime, adaptRenderFeatureToKernel } from './feature-bridge';

export interface KernelRenderHostOptions extends KernelStandardRendererOptions {}

export interface KernelRenderWorldOptions {
  readonly width: number;
  readonly height: number;
  readonly skybox?: KernelStandardSkyboxInput | undefined;
  readonly readbackTicketId?: number | undefined;
  readonly userData?: unknown;
}

export class KernelRenderHost {
  readonly renderer: KernelStandardSceneRenderer;
  private readonly assets: KernelAssetApi;
  private readonly hdrFormat: GPUTextureFormat;
  private readonly adaptedFeatures = new Map<string, AdaptedRenderFeatureRuntime>();
  private frameNumber = 0;

  private constructor(
    renderer: KernelStandardSceneRenderer,
    assets: KernelAssetApi,
    hdrFormat: GPUTextureFormat,
  ) {
    this.renderer = renderer;
    this.assets = assets;
    this.hdrFormat = hdrFormat;
  }

  static create(
    kernel: RenderKernelExecutionTarget,
    options: KernelRenderHostOptions = {},
  ): Result<KernelRenderHost, KernelError> {
    const rendererRes = KernelStandardSceneRenderer.create(kernel, options);
    if (!rendererRes.ok) return rendererRes;
    const assets = kernel.assets as KernelAssetApi | undefined;
    if (assets === undefined) {
      rendererRes.value.dispose();
      return kernelErr(
        'kernel-capability-unsupported',
        'KernelRenderHost.create',
        'RenderKernelExecutionTarget with assets API',
        'missing kernel.assets',
      );
    }
    const hdrFormat: GPUTextureFormat =
      options.hdrFormat ?? (rendererRes.value.supportsScene4Bgl ? 'rgba16float' : 'rgba8unorm');
    return ok(new KernelRenderHost(rendererRes.value, assets, hdrFormat));
  }

  registerMesh(input: KernelStandardMeshInput) {
    return this.renderer.ensureMesh(input);
  }

  registerTexture(input: KernelStandardTextureInput) {
    return this.renderer.ensureTexture(input);
  }

  registerMaterial(input: KernelStandardMaterialInput) {
    return this.renderer.ensureMaterial(input);
  }

  registerCustomShader(
    key: KernelResourceKey,
    code: string,
    options?: KernelStandardCustomShaderOptions,
  ) {
    return this.renderer.registerCustomShader(key, code, options);
  }

  setSkinJoints(slotOffset: number, jointMatrices: Float32Array) {
    return this.renderer.setSkinJoints(slotOffset, jointMatrices);
  }

  setUiOverlayRgba(width: number, height: number, rgbaBytes: Uint8Array) {
    return this.renderer.setUiOverlayRgba(width, height, rgbaBytes);
  }

  clearUiOverlay(): void {
    this.renderer.clearUiOverlay();
  }

  setDebugLines(vertices: Float32Array | null) {
    return this.renderer.setDebugLines(vertices);
  }

  clearDebugLines(): void {
    this.renderer.clearDebugLines();
  }

  /** Installs a native `KernelRenderFeature` directly onto the compiled `KernelRenderGraph`. */
  installKernelFeature(
    feature: KernelRenderFeature<KernelStandardPipelineFrame>,
  ): Result<void, KernelError> {
    return this.renderer.registerFeature(feature);
  }

  /**
   * Adapts and installs a declarative `@forgeax/engine-render` `RenderFeature<FrameData>`
   * so it participates in the same `KernelRenderGraph` ping-pong chain and runs on every backend.
   */
  installRenderFeature<FrameData>(feature: RenderFeature<FrameData>): Result<void, KernelError> {
    if (this.adaptedFeatures.has(feature.identity)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelRenderHost.installRenderFeature',
        'unique feature identity',
        `feature '${feature.identity}' is already installed`,
      );
    }
    const adapted = adaptRenderFeatureToKernel(feature, this.assets, this.hdrFormat);
    const reg = this.renderer.registerFeature(adapted.kernelFeature);
    if (!reg.ok) {
      adapted.dispose();
      return reg;
    }
    this.adaptedFeatures.set(feature.identity, adapted);
    return ok(undefined);
  }

  uninstallFeature(name: string): boolean {
    const adapted = this.adaptedFeatures.get(name);
    if (adapted !== undefined) {
      adapted.dispose();
      this.adaptedFeatures.delete(name);
    }
    return this.renderer.unregisterFeature(name);
  }

  setFeatureEnabled(name: string, enabled: boolean): boolean {
    return this.renderer.setFeatureEnabled(name, enabled);
  }

  /**
   * Extracts the ECS `World`, refreshes any adapted `RenderFeature` plans, executes the compiled
   * `KernelRenderGraph` in one `submitFrame`, and notifies submitted features.
   */
  renderWorld(
    world: World,
    options: KernelRenderWorldOptions,
  ): Result<FrameSubmitReceipt, KernelError> {
    this.frameNumber += 1;
    let topologyChanged = false;
    for (const adapted of this.adaptedFeatures.values()) {
      if (adapted.prepareForFrame(world, this.frameNumber, options.width, options.height)) {
        topologyChanged = true;
      }
    }
    if (topologyChanged) {
      // Force graph recompile when a RenderFeature changed its program roster or stage.
      for (const adapted of this.adaptedFeatures.values()) {
        this.renderer.setFeatureEnabled(adapted.identity, true);
      }
    }
    const frameInput = extractWorldToKernelFrame(world, {
      width: options.width,
      height: options.height,
      ...(options.skybox === undefined ? {} : { skybox: options.skybox }),
      ...(options.readbackTicketId === undefined
        ? {}
        : { readbackTicketId: options.readbackTicketId }),
      ...(options.userData === undefined ? {} : { userData: options.userData }),
    });
    const receipt = this.renderer.renderFrame(frameInput);
    if (receipt.ok) {
      for (const adapted of this.adaptedFeatures.values()) {
        adapted.notifySubmitted();
      }
    }
    return receipt;
  }

  readbackTicket(ticketId: number): Promise<Result<KernelReadbackResult, KernelError>> {
    return this.renderer.readbackTicket(ticketId);
  }

  inspectGraph(): CompiledKernelGraphInfo | undefined {
    return this.renderer.inspectGraph();
  }

  stats(): KernelStandardSceneStats {
    return this.renderer.stats();
  }

  dispose(): void {
    for (const adapted of this.adaptedFeatures.values()) adapted.dispose();
    this.adaptedFeatures.clear();
    this.renderer.dispose();
  }
}

export function createKernelRenderHost(
  kernel: RenderKernelExecutionTarget,
  options?: KernelRenderHostOptions,
): Result<KernelRenderHost, KernelError> {
  return KernelRenderHost.create(kernel, options);
}
