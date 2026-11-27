import { createRhiInstrumentation } from '@forgeax/engine-app';
import {
  AMBIENT_OCCLUSION_QUALITY_HIGH,
  AMBIENT_OCCLUSION_QUALITY_LOW,
  AMBIENT_OCCLUSION_QUALITY_MEDIUM,
  AmbientOcclusion,
  type AmbientOcclusionSettings,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  buildCubeCameraFaceViews,
  type FrameReceipt,
  type FrameReceiptObservation,
  PlanarReflection,
  type PlanarReflectionData,
  type Renderer,
  type RendererOptions,
  type RenderTargetWrite,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  type CaptureFrameOptions,
  type EncodedTape,
  type RecordableBackend,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import {
  type BundlerOptions,
  constructRuntimeRendererHost,
} from '@forgeax/engine-runtime/internal/renderer-host';
import CanvasTarget from 'three/src/renderers/common/CanvasTarget.js';
import type Color4 from 'three/src/renderers/common/Color4.js';
import type { RenderItem } from 'three/src/renderers/common/Renderer.js';
import type { WebGPURendererParameters as UpstreamParameters } from 'three/src/renderers/webgpu/WebGPURenderer.js';
import {
  type Camera,
  Color,
  type ColorRepresentation,
  CubeCamera,
  CubeTexture,
  HalfFloatType,
  LinearToneMapping,
  NoToneMapping,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  type RenderTarget,
  Scene,
  type ShadowMapType,
  SRGBColorSpace,
  type Texture,
  type ToneMapping,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three/src/Three.Core.js';
import { cameraData } from './camera';
import { invalid, ThreeCompatibilityError, unsupported } from './errors';
import {
  type ExternalTextureDemand,
  ExternalTextures,
  isExternalTexture,
} from './external-textures';
import { prepareMaterialPrograms } from './material-programs';
import { createThreePipeline } from './pipeline';
import { renderThreePostProcessing, type ThreePostProcessing } from './post-processing';
import { RenderTargets } from './render-targets';
import { forwardRendererEvents, type RendererCallbacks } from './renderer-events';
import { SceneProjection, type ThreeSourceIdentity } from './scene';

export interface WebGPURendererParameters extends Omit<UpstreamParameters, 'canvas'> {
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas;
  readonly forgeax?: {
    /** Default: the browser WebGPU backend. An explicit backend is never silently replaced. */
    readonly backend?: RecordableBackend;
    readonly renderer?: Omit<RendererOptions, 'rhi' | 'rhiInstrumentation' | 'pipeline'>;
    readonly bundler?: BundlerOptions;
    /** Build-produced publications. A pending load can overlap device initialization. */
    readonly materialPrograms?: readonly string[] | PromiseLike<readonly string[]>;
  };
}

export interface ThreeFrameCapture {
  readonly tape: EncodedTape;
  readonly receipt: FrameReceipt;
  readonly sources: readonly ThreeSourceIdentity[];
  /** Native source/entity/material/pipeline identities; shared pipelines may represent several draws. */
  readonly observation: FrameReceiptObservation;
}

/** Settings for a native capture owned by a projected display camera. */
export type ThreePlanarReflectionOptions = Partial<Omit<PlanarReflectionData, 'target'>>;
const configurePlanarReflection = Symbol('configurePlanarReflection');
const readFrame = Symbol('readFrame');

export interface ThreeFrameObservation {
  readonly receipt: FrameReceipt;
  readonly observe: (
    request: Parameters<Renderer['observe']>[1],
  ) => ReturnType<Renderer['observe']>;
}

/** Snapshot the latest submission without gathering scene diagnostics or redrawing. */
export function readThreeFrame(renderer: WebGPURenderer): ThreeFrameObservation | undefined {
  return renderer[readFrame]();
}

/** ForgeaX integration entry; source cameras retain the upstream Three contract. */
export function setThreePlanarReflection(
  renderer: WebGPURenderer,
  camera: Camera,
  options: ThreePlanarReflectionOptions | null,
): void {
  renderer[configurePlanarReflection](camera, options);
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function targetWork<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ThreeCompatibilityError(
                'renderer-not-ready',
                'RenderTarget preparation deadline',
                'Inspect the native receipt preparation blocker.',
              ),
            ),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hasBeforeRender(scene: Object3D): boolean {
  return scene instanceof Scene && scene.onBeforeRender !== Scene.prototype.onBeforeRender;
}

/** Three's authoring objects, one Forgeax Renderer, and no upstream GPU renderer. */
export class WebGPURenderer {
  private planarReflections?: WeakMap<Camera, ThreePlanarReflectionOptions>;

  [configurePlanarReflection](camera: Camera, options: ThreePlanarReflectionOptions | null): void {
    const { projection } = this.ready();
    const entity = projection.entityFor(camera);
    const world = projection.world;
    if (entity !== undefined && world.hasComponent(entity, PlanarReflection)) {
      world.removeComponent(entity, PlanarReflection).unwrap();
    }
    if (options === null) {
      this.planarReflections?.delete(camera);
      return;
    }
    this.planarReflections ??= new WeakMap();
    this.planarReflections.set(camera, {
      ...options,
      ...(options.normal === undefined ? {} : { normal: new Float32Array(options.normal) }),
    });
  }

  readonly domElement: HTMLCanvasElement | OffscreenCanvas;
  onDeviceLost: RendererCallbacks['onDeviceLost'] = (info) => {
    console.error(`THREE.WebGPURenderer: ${info.message}`, info);
  };
  onError: RendererCallbacks['onError'] = (info) => {
    console.error(`THREE.WebGPURenderer: Uncaptured ${info.api} ${info.type}: ${info.message}`);
  };
  private textureInitializationRetries: WeakMap<Texture, number> | undefined;
  private opaqueSort: ((a: RenderItem, b: RenderItem) => number) | null = null;
  private transparentSort: ((a: RenderItem, b: RenderItem) => number) | null = null;
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  sortObjects = true;
  transparent = true;
  opaque = true;
  readonly shadowMap: { enabled: boolean; transmitted: boolean; type: ShadowMapType } = {
    enabled: false,
    transmitted: false,
    type: PCFShadowMap,
  };
  readonly coordinateSystem = WebGPUCoordinateSystem;
  readonly isWebGPURenderer = true;
  readonly isRenderer = true;
  readonly depth: boolean;
  readonly stencil: boolean;
  readonly reversedDepthBuffer: boolean;
  readonly logarithmicDepthBuffer = false;
  readonly alpha: boolean;
  private sampleCount = 0;
  private renderTarget: RenderTarget | null = null;
  private asyncTargetOperation = false;
  private cubeFacePoses?: readonly Pick<Object3D, 'position' | 'scale' | 'quaternion'>[];
  private activeCubeFace = 0;
  private activeMipmapLevel = 0;
  private readonly outputType: typeof HalfFloatType | typeof UnsignedByteType;
  toneMapping: ToneMapping = NoToneMapping;
  toneMappingExposure = 1;
  outputColorSpace: string = SRGBColorSpace;
  private readonly recorder: RecorderAttachment;
  private readonly initializing: Promise<void>;
  private readonly profiler: RendererOptions['profiler'];
  private runtime:
    | {
        native: Renderer;
        projection: SceneProjection;
        lease: RenderWorldLease;
        external: ExternalTextures;
        targets: RenderTargets;
        unsubscribe: () => void;
      }
    | undefined;
  private disposed = false;
  private disposing: Promise<void> | undefined;
  private captureAbort: AbortController | undefined;
  private cancelMaterialStartup: (() => void) | undefined;
  private canvasTarget: CanvasTarget;
  private readonly canvasSize = new Vector2();
  private readonly canvasRectangle = new Vector4();
  private readonly clearColorValue = new Color(0);
  private clearAlpha = 1;
  private get antialias(): number {
    return this.sampleCount === 4 ? ANTIALIAS_MSAA : ANTIALIAS_NONE;
  }
  private loop: ((time: number) => void) | null = null;
  private animationRequest: number | undefined;
  private receipt: FrameReceipt | undefined;
  private composerAoBase: AmbientOcclusionSettings | undefined;

  constructor(parameters: WebGPURendererParameters = {}) {
    if (parameters.forgeax?.renderer && 'pipeline' in parameters.forgeax.renderer)
      invalid('forgeax.renderer.pipeline: Three compatibility owns the output pipeline').unwrap();
    for (const key of Object.keys(parameters)) {
      if (
        ![
          'canvas',
          'antialias',
          'alpha',
          'depth',
          'stencil',
          'reversedDepthBuffer',
          'logarithmicDepthBuffer',
          'samples',
          'outputBufferType',
          'forgeax',
        ].includes(key) &&
        parameters[key as keyof WebGPURendererParameters] !== undefined
      )
        unsupported(`WebGPURenderer parameter ${key}`).unwrap();
    }
    this.alpha = parameters.alpha ?? true;
    if (!this.alpha)
      unsupported('alpha=false requires native opaque canvas configuration').unwrap();
    if (parameters.logarithmicDepthBuffer)
      unsupported('logarithmicDepthBuffer requires native logarithmic depth writers').unwrap();
    this.clearAlpha = this.alpha ? 0 : 1;
    this.depth = parameters.depth ?? true;
    this.stencil = parameters.stencil ?? false;
    this.reversedDepthBuffer = parameters.reversedDepthBuffer ?? false;
    this.samples = parameters.samples || (parameters.antialias ? 4 : 0);
    if (![0, 1, 4].includes(this.samples))
      unsupported('WebGPURenderer samples outside 0/1/4').unwrap();
    const output = parameters.outputBufferType ?? HalfFloatType;
    if (output !== HalfFloatType && output !== UnsignedByteType)
      unsupported('WebGPURenderer outputBufferType').unwrap();
    this.outputType = output as typeof HalfFloatType | typeof UnsignedByteType;
    if (parameters.canvas === undefined && typeof document === 'undefined')
      unsupported('WebGPURenderer requires canvas outside a browser').unwrap();
    this.domElement = parameters.canvas ?? document.createElement('canvas');
    this.canvasTarget = new CanvasTarget(this.domElement);
    this.recorder = attachRecorder(parameters.forgeax?.backend ?? webgpu).unwrap();
    this.profiler = parameters.forgeax?.renderer?.profiler;
    this.initializing = this.initialize(
      parameters.forgeax,
      output === HalfFloatType ? 'rgba16float' : 'rgba8unorm',
    );
    // A caller may attach its rejection handler after construction; init() retains the original error.
    void this.initializing.catch(() => undefined);
  }

  private async initialize(
    options: WebGPURendererParameters['forgeax'],
    format: 'rgba16float' | 'rgba8unorm',
  ): Promise<void> {
    let native: Renderer | undefined;
    let projection: SceneProjection | undefined;
    const materialPrograms = Promise.race([
      Promise.resolve(options?.materialPrograms),
      new Promise<undefined>((resolve) => {
        this.cancelMaterialStartup = () => resolve(undefined);
      }),
    ]);
    // Material loading can fail while the native host still owns its startup.
    void materialPrograms.catch(() => undefined);
    try {
      const host = value(
        await constructRuntimeRendererHost(
          this.domElement,
          {
            ...options?.renderer,
            pipeline: createThreePipeline(format),
            rhi: this.recorder.backend.rhi,
            rhiInstrumentation: createRhiInstrumentation(this.recorder),
          },
          options?.bundler,
        ),
      );
      native = host.renderer;
      value(await host.initialization);
      const publications = await materialPrograms;
      if (this.disposed) {
        value(await native.dispose());
        return;
      }
      const external = new ExternalTextures(native);
      const targets = new RenderTargets(native);
      projection = new SceneProjection(
        host.assets,
        external,
        await prepareMaterialPrograms(host.assets, publications),
        { targets, canvasTextures: options?.backend === undefined },
      );
      const lease = value(native.attach(projection.world));
      const unsubscribe = forwardRendererEvents(native, this);
      this.runtime = { native, projection, lease, external, targets, unsubscribe };
    } catch (error) {
      try {
        projection?.dispose();
        if (native !== undefined) value(await native.dispose());
      } finally {
        (await this.recorder.dispose()).unwrap();
      }
      throw error;
    } finally {
      this.cancelMaterialStartup = undefined;
    }
  }

  async init(): Promise<this> {
    this.assertAlive();
    await this.initializing;
    this.ready();
    return this;
  }
  get samples(): number {
    return this.sampleCount;
  }
  set samples(value: number) {
    this.assertNotCapturing();
    if (![0, 1, 4].includes(value)) unsupported('WebGPURenderer samples outside 0/1/4').unwrap();
    this.sampleCount = value;
  }
  get initialized(): boolean {
    return this.runtime !== undefined && !this.disposed;
  }
  hasInitialized(): boolean {
    return this.initialized;
  }
  getOutputBufferType(): typeof HalfFloatType | typeof UnsignedByteType {
    return this.outputType;
  }
  getColorBufferType(): typeof HalfFloatType | typeof UnsignedByteType {
    return this.getOutputBufferType();
  }
  get currentToneMapping(): ToneMapping {
    return this.renderTarget === null ? this.toneMapping : NoToneMapping;
  }
  get currentColorSpace(): string {
    return (
      this.renderTarget?.texture.colorSpace ||
      (this.renderTarget === null ? this.outputColorSpace : 'srgb-linear')
    );
  }
  get isOutputTarget(): boolean {
    return this.renderTarget === null;
  }
  get needsFrameBufferTarget(): boolean {
    return true;
  }
  get currentSamples(): number {
    return this.renderTarget?.samples ?? this.samples;
  }
  getActiveCubeFace(): number {
    return this.activeCubeFace;
  }
  getActiveMipmapLevel(): number {
    return this.activeMipmapLevel;
  }

  getCanvasTarget(): CanvasTarget {
    return this.canvasTarget;
  }

  setCanvasTarget(target: CanvasTarget): void {
    this.assertNotCapturing();
    this.validateCanvasTarget(target);
    this.applyCanvasExtent(target);
    this.canvasTarget = target;
  }

  private fullCanvasRectangle(rectangle: Vector4): boolean {
    const size = this.canvasTarget.getSize(this.canvasSize);
    return (
      rectangle.x === 0 && rectangle.y === 0 && rectangle.z === size.x && rectangle.w === size.y
    );
  }

  /** Direct edits to the public target must pass the same admission as renderer setters. */
  private validateCanvasTarget(target: CanvasTarget): void {
    if (target.domElement !== this.domElement)
      unsupported(
        'CanvasTarget switching to another canvas requires native surface rebinding',
      ).unwrap();
    const size = target.getSize(this.canvasSize);
    const ratio = target.getPixelRatio();
    if (
      !Number.isFinite(size.x) ||
      !Number.isFinite(size.y) ||
      !Number.isFinite(ratio) ||
      size.x <= 0 ||
      size.y <= 0 ||
      ratio <= 0
    )
      invalid('CanvasTarget size/pixelRatio').unwrap();
    this.validateCanvasViewport(target, size.x, size.y);
    const scissor = target.getScissor(this.canvasRectangle);
    if (
      target.getScissorTest() &&
      (scissor.x !== 0 || scissor.y !== 0 || scissor.z !== size.x || scissor.w !== size.y)
    )
      unsupported('Partial scissor requires native per-draw scissor state').unwrap();
  }

  private validateCanvasViewport(target: CanvasTarget, width: number, height: number): void {
    // r187's backend reads this same source-owned viewport for depth bounds.
    const viewport = (
      target as CanvasTarget & {
        _viewport: Vector4 & { minDepth?: number; maxDepth?: number };
      }
    )._viewport;
    if (
      viewport.x !== 0 ||
      viewport.y !== 0 ||
      viewport.z !== width ||
      viewport.w !== height ||
      (viewport.minDepth ?? 0) !== 0 ||
      (viewport.maxDepth ?? 1) !== 1
    )
      unsupported('Partial viewport/depth ranges require native per-draw viewport state').unwrap();
  }

  private applyCanvasExtent(target: CanvasTarget): void {
    const size = target.getDrawingBufferSize(this.canvasSize);
    if (this.domElement.width !== size.x) this.domElement.width = size.x;
    if (this.domElement.height !== size.y) this.domElement.height = size.y;
  }

  setSize(width: number, height: number, updateStyle = true): void {
    this.assertNotCapturing();
    if (![width, height].every((dimension) => Number.isFinite(dimension) && dimension > 0))
      invalid('Renderer.setSize').unwrap();
    this.canvasTarget.setSize(width, height, updateStyle && 'style' in this.domElement);
  }

  getViewport(target: Vector4): Vector4 {
    return this.canvasTarget.getViewport(target);
  }
  setViewport(
    x: number | Vector4,
    y?: number,
    width?: number,
    height?: number,
    minDepth = 0,
    maxDepth = 1,
  ): void {
    this.assertNotCapturing();
    const rectangle = typeof x === 'number' ? new Vector4(x, y, width, height) : x;
    if (minDepth !== 0 || maxDepth !== 1 || !this.fullCanvasRectangle(rectangle))
      unsupported('Partial viewport/depth ranges require native per-draw viewport state').unwrap();
    this.canvasTarget.setViewport(rectangle);
  }
  getScissor(target: Vector4): Vector4 {
    return this.canvasTarget.getScissor(target);
  }
  setScissor(x: number | Vector4, y?: number, width?: number, height?: number): void {
    this.assertNotCapturing();
    const rectangle = typeof x === 'number' ? new Vector4(x, y, width, height) : x;
    if (!rectangle.toArray().every(Number.isFinite)) invalid('Renderer.setScissor').unwrap();
    if (this.getScissorTest() && !this.fullCanvasRectangle(rectangle))
      unsupported('Partial scissor requires native per-draw scissor state').unwrap();
    this.canvasTarget.setScissor(rectangle);
  }
  getScissorTest(): boolean {
    return this.canvasTarget.getScissorTest();
  }
  setScissorTest(enabled: boolean): void {
    this.assertNotCapturing();
    if (enabled && !this.fullCanvasRectangle(this.getScissor(this.canvasRectangle)))
      unsupported('Partial scissor requires native per-draw scissor state').unwrap();
    this.canvasTarget.setScissorTest(enabled);
  }

  getSize(target: Vector2): Vector2 {
    return this.canvasTarget.getSize(target);
  }
  getDrawingBufferSize(target: Vector2): Vector2 {
    return this.canvasTarget.getDrawingBufferSize(target);
  }
  setDrawingBufferSize(width: number, height: number, pixelRatio: number): void {
    this.assertNotCapturing();
    if (![width, height, pixelRatio].every((value) => Number.isFinite(value) && value > 0))
      invalid('Renderer.setDrawingBufferSize').unwrap();
    this.canvasTarget.setDrawingBufferSize(width, height, pixelRatio);
  }
  getPixelRatio(): number {
    return this.canvasTarget.getPixelRatio();
  }
  setPixelRatio(ratio = 1): void {
    this.assertNotCapturing();
    if (!Number.isFinite(ratio) || ratio <= 0) invalid('Renderer.setPixelRatio').unwrap();
    this.canvasTarget.setPixelRatio(ratio);
  }
  setClearColor(color: ColorRepresentation, alpha = 1): void {
    this.assertAlive();
    this.clearColorValue.set(color);
    this.setClearAlpha(alpha);
  }
  getClearColor(target: Color4): Color4;
  getClearColor<T extends Color>(target: T): T;
  getClearColor(target: Color): Color;
  getClearColor<T extends Color>(target: T): T {
    target.copy(this.clearColorValue);
    if ('a' in target) target.a = this.clearAlpha;
    return target;
  }
  setClearAlpha(alpha: number): void {
    this.assertAlive();
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
      invalid('Renderer.setClearAlpha').unwrap();
    this.clearAlpha = alpha;
  }
  getClearAlpha(): number {
    return this.clearAlpha;
  }

  getClearDepth(): number {
    return this.reversedDepthBuffer ? 0 : 1;
  }
  setClearDepth(depth: number): void {
    this.assertAlive();
    if (depth !== 1)
      unsupported('Custom depth clears require native attachment clear values').unwrap();
  }
  getClearStencil(): number {
    return 0;
  }
  setClearStencil(stencil: number): void {
    this.assertAlive();
    if (stencil !== 0)
      unsupported('Custom stencil clears require native attachment clear values').unwrap();
  }
  clearColor(): void {
    this.clear(true, false, false);
  }
  clearDepth(): void {
    this.clear(false, true, false);
  }
  clearStencil(): void {
    this.clear(false, false, true);
  }
  async clearColorAsync(): Promise<void> {
    await this.init();
    this.clearColor();
  }
  async clearDepthAsync(): Promise<void> {
    await this.init();
    this.clearDepth();
  }
  async clearStencilAsync(): Promise<void> {
    await this.init();
    this.clearStencil();
  }

  clear(color = true, depth = true, stencil = true): void {
    this.assertNotCapturing();
    if (this.asyncTargetOperation)
      invalid('Await the active target operation before clearing').unwrap();
    if (this.renderTarget === null) {
      this.validateCanvasTarget(this.canvasTarget);
      this.applyCanvasExtent(this.canvasTarget);
    }
    if (!color && (!this.depth || !depth) && (!this.stencil || !stencil)) return;
    if (
      this.renderTarget === null &&
      (!color || (this.depth && !depth) || (this.stencil && !stencil))
    )
      unsupported('Partial clears require native attachment load/store control').unwrap();
    const { projection } = this.ready();
    const camera = new PerspectiveCamera();
    const entity = projection.sync(
      new Scene(),
      camera,
      {
        ...cameraData(
          camera,
          this.toneMapping === NoToneMapping ? LinearToneMapping : this.toneMapping,
          this.toneMapping === NoToneMapping ? 1 : this.toneMappingExposure,
        ),
        antialias: this.antialias,
        clearColor: new Float32Array([...this.clearColorValue.toArray(), this.clearAlpha]),
      },
      {
        deferResourceSweep: true,
        depth: this.depth,
        stencil: this.stencil,
        sortObjects: false,
        opaque: false,
        transparent: false,
        updateMatrices: true,
      },
    );
    const receipt = this.submit(entity, this.targetWrite(true, color, depth, stencil));
    if (this.renderTarget !== null && receipt.presentation !== 'ready')
      throw new ThreeCompatibilityError(
        'renderer-not-ready',
        'RenderTarget clear preparation',
        'Await clearAsync before consuming this target.',
      );
  }
  async clearAsync(color = true, depth = true, stencil = true): Promise<void> {
    const target = this.renderTarget,
      face = this.activeCubeFace,
      mip = this.activeMipmapLevel;
    await this.init();
    if (
      target !== this.renderTarget ||
      face !== this.activeCubeFace ||
      mip !== this.activeMipmapLevel
    )
      invalid('Render target changed during clearAsync; await the active operation').unwrap();
    const deadline = Date.now() + 20000;
    for (;;) {
      if (
        target !== this.renderTarget ||
        face !== this.activeCubeFace ||
        mip !== this.activeMipmapLevel
      )
        invalid('Render target changed during clearAsync; await the active operation').unwrap();
      try {
        this.clear(color, depth, stencil);
        break;
      } catch (error) {
        if (
          !(error instanceof ThreeCompatibilityError) ||
          error.code !== 'renderer-not-ready' ||
          Date.now() >= deadline
        )
          throw error;
        const receipt = this.receipt;
        if (receipt !== undefined) {
          value(await targetWork(receipt.completed, deadline));
          if (receipt.preparationCompleted !== undefined)
            value(await targetWork(receipt.preparationCompleted, deadline));
        }
      }
    }
    if (this.renderTarget !== null && this.receipt !== undefined)
      value(await targetWork(this.receipt.completed, deadline));
  }

  render(scene: Object3D, camera: Camera): void {
    this.renderScene(scene, camera);
  }

  [renderThreePostProcessing](scene: Object3D, camera: Camera, post: ThreePostProcessing): void {
    if (this.renderTarget !== null)
      unsupported('EffectComposer requires the renderer display target').unwrap();
    this.renderScene(scene, camera, post);
  }

  private renderScene(scene: Object3D, camera: Camera, post?: ThreePostProcessing): void {
    this.assertNotCapturing();
    if (this.asyncTargetOperation)
      invalid('Await the active target operation before rendering').unwrap();
    const receipt = this.submit(this.prepare(scene, camera, undefined, post));
    if (this.renderTarget !== null && receipt.presentation !== 'ready')
      throw new ThreeCompatibilityError(
        'renderer-not-ready',
        'RenderTarget preparation',
        'Await renderAsync(scene, camera) before consuming this target. No deferred scene draw is queued.',
      );
    this.sceneCallback(scene, camera, 'onAfterRender');
  }

  async setAnimationLoop(
    callback: ((time: number, frame?: XRFrame) => void) | null,
  ): Promise<void> {
    this.assertAlive();
    if (this.animationRequest !== undefined) cancelAnimationFrame(this.animationRequest);
    this.animationRequest = undefined;
    this.loop = callback;
    if (callback === null) return;
    if (typeof requestAnimationFrame !== 'function')
      unsupported('setAnimationLoop requires requestAnimationFrame').unwrap();
    await this.initializing;
    if (!this.disposed && this.loop === callback && this.animationRequest === undefined)
      this.schedule();
  }
  getAnimationLoop(): ((time: number, frame?: XRFrame) => void) | null {
    return this.loop;
  }

  private schedule(): void {
    this.animationRequest = requestAnimationFrame((time) => {
      this.animationRequest = undefined;
      if (this.disposed || this.loop === null) return;
      try {
        if (this.captureAbort === undefined) this.loop(time);
      } finally {
        if (!this.disposed && this.loop !== null && this.animationRequest === undefined)
          this.schedule();
      }
    });
  }

  /** Native diagnostics are an explicit migration/debug extension. */
  subscribe(listener: Parameters<Renderer['subscribe']>[0]): () => void {
    return this.ready().native.subscribe(listener);
  }

  inspect(): {
    renderer: ReturnType<Renderer['inspect']>;
    sourceWork: ReturnType<SceneProjection['sourceWork']>;
    sources: readonly ThreeSourceIdentity[];
    receipt: FrameReceipt | undefined;
  } {
    const { native, projection } = this.ready();
    return {
      renderer: native.inspect(),
      sourceWork: projection.sourceWork(),
      sources: projection.sources('admitted'),
      receipt: this.receipt,
    };
  }

  [readFrame](): ThreeFrameObservation | undefined {
    const receipt = this.receipt;
    const native = this.runtime?.native;
    if (receipt === undefined || native === undefined || this.disposed) return undefined;
    return { receipt, observe: (request) => native.observe(receipt, request) };
  }

  /** Capture one already prepared scene through the existing RHI recorder. No simulation time advances. */
  async captureFrame(
    scene: Object3D,
    camera: Camera,
    options: CaptureFrameOptions = {},
  ): Promise<ThreeFrameCapture> {
    this.assertNotCapturing();
    if (this.asyncTargetOperation) invalid('Concurrent target operations').unwrap();
    const entity = this.prepare(scene, camera);
    const { native, projection } = this.ready();
    const sources = projection.sources('admitted');
    const abort = new AbortController();
    this.captureAbort = abort;
    const signal =
      options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
    const pending = this.recorder.captureFrame({ ...options, signal });
    try {
      (await this.recorder.frameBoundary()).unwrap();
      this.assertAlive();
      signal.throwIfAborted();
      const armed = native.requestObservation?.(['final-display']);
      if (armed === undefined) unsupported('Renderer final-display observation').unwrap();
      else value(armed);
      const receipt = this.submit(entity);
      this.sceneCallback(scene, camera, 'onAfterRender');
      value(await receipt.completed);
      if (receipt.presentation !== 'ready')
        unsupported(
          'capture requires a ready scene; render until inspect().receipt.presentation is ready',
        ).unwrap();
      const observation = value(
        await native.observe(receipt, { include: ['draws', 'bindings', 'final-display'] }),
      );
      const tape = (await pending).unwrap();
      return { tape, receipt, sources, observation };
    } finally {
      abort.abort();
      await pending;
      if (this.captureAbort === abort) this.captureAbort = undefined;
    }
  }

  dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing;
    this.disposed = true;
    this.loop = null;
    if (this.animationRequest !== undefined) cancelAnimationFrame(this.animationRequest);
    this.captureAbort?.abort();
    this.cancelMaterialStartup?.();
    this.disposing = (async () => {
      await this.initializing.catch(() => undefined);
      const runtime = this.runtime;
      this.runtime = undefined;
      runtime?.unsubscribe();
      runtime?.lease.dispose();
      runtime?.projection.dispose();
      runtime?.external.dispose();
      runtime?.targets.dispose();
      try {
        if (runtime !== undefined) value(await runtime.native.dispose());
      } finally {
        try {
          (await this.recorder.dispose()).unwrap();
        } finally {
          this.canvasTarget.dispose();
        }
      }
    })();
    return this.disposing;
  }

  getContext(): GPUCanvasContext {
    this.ready();
    const context = this.domElement.getContext('webgpu');
    if (context === null)
      return unsupported('Renderer.getContext requires a WebGPU canvas').unwrap();
    return context as GPUCanvasContext;
  }

  async renderAsync(scene: Object3D, camera: Camera): Promise<void> {
    const target = this.renderTarget,
      face = this.activeCubeFace,
      mip = this.activeMipmapLevel;
    await this.init();
    const assertTarget = () => {
      if (
        target !== this.renderTarget ||
        face !== this.activeCubeFace ||
        mip !== this.activeMipmapLevel
      )
        invalid('Render target changed during renderAsync; await the active operation').unwrap();
      this.assertNotCapturing();
      if (this.asyncTargetOperation) invalid('Concurrent target operations').unwrap();
    };
    assertTarget();
    await this.withPreparedScene(
      scene,
      camera,
      (entity) => {
        assertTarget();
        if (target === null) {
          this.submit(entity);
          return;
        }
        this.asyncTargetOperation = true;
        return this.submitTargetReady(entity).finally(() => {
          this.asyncTargetOperation = false;
        });
      },
      assertTarget,
    );
    this.sceneCallback(scene, camera, 'onAfterRender');
  }

  private async withPreparedScene<T>(
    scene: Object3D,
    camera: Camera,
    consume: (entity: ReturnType<SceneProjection['sync']>) => T,
    assertTarget?: () => void,
  ): Promise<T> {
    const sourceMatricesReady = this.updateScene(scene, camera);
    const demand: ExternalTextureDemand = new Set();
    let entity: ReturnType<SceneProjection['sync']>;
    try {
      entity = this.prepare(scene, camera, sourceMatricesReady, undefined, demand);
    } catch (error) {
      if (error !== demand) throw error;
      const { external } = this.ready();
      await Promise.all(Array.from(demand, (texture) => external.initialize(texture)));
      assertTarget?.();
      // Re-read source admission after the wait. Further uninitialized inputs
      // use the ordinary binding error instead of chasing a moving scene.
      entity = this.prepare(scene, camera, sourceMatricesReady);
    }
    return consume(entity);
  }

  /** Full-target raw readback. Region copies and depth readback are explicit gaps. */
  async readRenderTargetPixelsAsync(
    target: RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
    textureIndex = 0,
    activeCubeFace = 0,
  ): Promise<Uint8Array | Uint16Array> {
    await this.init();
    this.assertNotCapturing();
    if (this.asyncTargetOperation) invalid('Concurrent target operations').unwrap();
    if (x !== 0 || y !== 0 || width !== target.width || height !== target.height)
      unsupported('RenderTarget readback currently requires the complete mip-0 extent').unwrap();
    if (textureIndex !== 0) unsupported('RenderTarget readback MRT attachment index').unwrap();
    const buffer =
      target.texture.type === HalfFloatType
        ? new Uint16Array(width * height * 4)
        : new Uint8Array(width * height * 4);
    const previous = this.renderTarget,
      face = this.activeCubeFace,
      mip = this.activeMipmapLevel;
    try {
      this.setRenderTarget(target, activeCubeFace, 0);
      const { native, targets, projection } = this.ready();
      const nativeTarget = targets.target(target);
      const layer =
        target.texture instanceof CubeTexture && activeCubeFace < 2
          ? 1 - activeCubeFace
          : activeCubeFace;
      const ticket = value(native.requestTargetReadback(nativeTarget, { mipLevel: 0, layer }));
      const camera = new PerspectiveCamera();
      const entity = projection.sync(new Scene(), camera, cameraData(camera, LinearToneMapping, 1));
      const receipt = this.submit(entity, this.targetWrite(true, false, false, false));
      value(await receipt.completed);
      if (receipt.presentation !== 'ready')
        throw new ThreeCompatibilityError(
          'renderer-not-ready',
          'RenderTarget readback preparation',
          'Complete a target renderAsync before readback.',
        );
      const observed = value(
        await native.observe(receipt, { include: ['target-readbacks'], targetReadbacks: [ticket] }),
      );
      const image = observed.targetReadbacks?.[0];
      if (image === undefined) throw new Error('missing target readback');
      const rowBytes = width * (target.texture.type === HalfFloatType ? 8 : 4);
      const destination = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      for (let row = 0; row < height; row++)
        destination.set(
          image.bytes.subarray(row * image.bytesPerRow, row * image.bytesPerRow + rowBytes),
          row * rowBytes,
        );
      return buffer;
    } finally {
      this.setRenderTarget(previous, face, mip);
    }
  }

  /** Six ordered native face writes followed by one native IBL filter. */
  async captureCubeAsync(camera: CubeCamera, scene: Scene): Promise<void> {
    if (camera.activeMipmapLevel !== 0)
      unsupported(
        'Cube environment capture requires mip 0; use explicit target writes for other mips',
        camera.uuid,
      ).unwrap();
    await this.init();
    this.assertNotCapturing();
    if (this.asyncTargetOperation) invalid('Concurrent target operations').unwrap();
    const target = this.renderTarget,
      face = this.activeCubeFace,
      mip = this.activeMipmapLevel;
    if (camera.parent === null) camera.updateMatrixWorld();
    if (camera.coordinateSystem !== this.coordinateSystem) {
      camera.coordinateSystem = this.coordinateSystem;
      camera.updateCoordinateSystem();
    }
    const cubeTarget = camera.renderTarget;
    const texture = cubeTarget.texture;
    const generateMipmaps = texture.generateMipmaps;
    texture.generateMipmaps = false;
    try {
      camera.updateWorldMatrix(true, false);
      const world = camera.matrixWorld.elements;
      if (
        world.some(
          (value, index) =>
            index !== 12 &&
            index !== 13 &&
            index !== 14 &&
            Math.abs(value - (index % 5 === 0 ? 1 : 0)) > 1e-6,
        )
      )
        unsupported(
          'Native cube capture accepts world translation; rotation/scale require an explicit environment transform',
          camera.uuid,
        ).unwrap();
      const source = camera.children[0];
      if (!(source instanceof PerspectiveCamera))
        invalid('CubeCamera requires its original PerspectiveCamera children').unwrap();
      const near = (source as PerspectiveCamera).near,
        far = (source as PerspectiveCamera).far;
      if (!Number.isFinite(near) || near <= 0 || !Number.isFinite(far) || far <= near)
        invalid('CubeCamera near/far').unwrap();
      if (this.cubeFacePoses === undefined) {
        const original = new CubeCamera(near, far, cubeTarget);
        original.coordinateSystem = this.coordinateSystem;
        original.updateCoordinateSystem();
        this.cubeFacePoses = original.children.map(({ position, scale, quaternion }) => ({
          position,
          scale,
          quaternion,
        }));
      }
      const facePoses = this.cubeFacePoses;
      if (
        camera.children.length !== 6 ||
        camera.children.some((child, index) => {
          const expected = facePoses[index];
          return (
            !(child instanceof PerspectiveCamera) ||
            expected === undefined ||
            child.fov !== -90 ||
            child.aspect !== 1 ||
            child.near !== near ||
            child.far !== far ||
            child.zoom !== 1 ||
            child.view !== null ||
            child.filmOffset !== 0 ||
            !child.position.equals(expected.position) ||
            !child.scale.equals(expected.scale) ||
            !child.quaternion.equals(expected.quaternion) ||
            child.layers.mask !== camera.layers.mask
          );
        })
      )
        unsupported(
          'CubeCamera requires six original, matching face lenses and transforms',
          camera.uuid,
        ).unwrap();
      const faces = buildCubeCameraFaceViews({
        position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
        near,
        far,
      });
      const { lease, targets } = this.ready();
      this.renderTarget = cubeTarget;
      this.activeMipmapLevel = 0;
      this.asyncTargetOperation = true;
      let projected: PerspectiveCamera;
      await targets.captureEnvironment(cubeTarget, {
        prepareFace: async (layer) => {
          const view = faces[layer];
          if (view === undefined) throw new Error('Missing cube camera face');
          this.activeCubeFace = layer < 2 ? 1 - layer : layer;
          projected = new PerspectiveCamera(90, 1, near, far);
          projected.layers.mask = camera.layers.mask;
          projected.matrixAutoUpdate = false;
          projected.matrix.fromArray(view.view).invert();
          projected.matrixWorld.copy(projected.matrix);
          return this.withPreparedScene(scene, projected, (entity) => ({
            source: lease,
            camera: { entityKey: entity },
            geometryLane: 'direct' as const,
            clearColor: this.autoClear && this.autoClearColor,
            clearDepth: this.autoClear && this.autoClearDepth,
            clearStencil: this.autoClear && this.autoClearStencil,
          }));
        },
        onFaceSubmitted: (_layer, receipt) => {
          this.noteSubmission(receipt);
          this.sceneCallback(scene, projected, 'onAfterRender');
        },
      });
    } finally {
      this.asyncTargetOperation = false;
      texture.generateMipmaps = generateMipmaps;
      this.renderTarget = target;
      this.activeCubeFace = face;
      this.activeMipmapLevel = mip;
    }
  }

  /** Explicit GPU cube radiance -> native diffuse/PMREM, with no CPU readback. */
  async prepareEnvironment(texture: Texture): Promise<void> {
    await this.init();
    this.assertNotCapturing();
    if (this.asyncTargetOperation) invalid('Concurrent target operations').unwrap();
    await this.ready().targets.prepareEnvironment(texture);
  }

  async initTextureAsync(texture: Texture): Promise<void> {
    await this.init();
    if (isExternalTexture(texture)) await this.ready().external.initialize(texture);
    else this.initTexture(texture);
  }

  initTexture(texture: Texture): void {
    this.assertNotCapturing();
    if (isExternalTexture(texture))
      unsupported('External textures require await initTextureAsync()', texture.uuid).unwrap();
    const { projection, native } = this.ready();
    const prepared = projection.prepareTexture(texture);
    const result = native.prepareTextureResidency(projection.world, prepared.handle);
    if (!result.ok) {
      this.textureInitializationRetries ??= new WeakMap();
      this.textureInitializationRetries.set(texture, texture.version);
      throw result.error;
    }
    const retry = this.textureInitializationRetries?.get(texture) === texture.version;
    this.textureInitializationRetries?.delete(texture);
    projection.textureInitialized(texture, prepared.uploaded || retry);
  }

  hasFeature(name: string): boolean {
    return value(this.ready().native.nativeDevice()).features.has(name as GPUFeatureName);
  }
  async hasFeatureAsync(name: string): Promise<boolean> {
    await this.init();
    return this.hasFeature(name);
  }

  /** Legacy declaration API: waits for physical completion of prior queue work. */
  async waitForGPU(): Promise<void> {
    await value(this.ready().native.nativeDevice()).queue.onSubmittedWorkDone();
  }

  hasCompatibility(name: string): boolean {
    // Comparison sampling is part of this WebGPU route; unknown hints are never granted.
    value(this.ready().native.nativeDevice());
    return name === 'texture-compare';
  }

  setOpaqueSort(method: ((a: RenderItem, b: RenderItem) => number) | null): void {
    this.assertNotCapturing();
    this.opaqueSort = method;
  }

  setTransparentSort(method: ((a: RenderItem, b: RenderItem) => number) | null): void {
    this.assertNotCapturing();
    this.transparentSort = method;
  }

  resetState(): void {
    // WebGPU state belongs to individual passes. Native recording binds every pass anew.
    this.ready();
  }

  getMaxAnisotropy(): number {
    this.ready();
    return 16;
  }

  /** Default-state edges used by RendererUtils; GPU overrides remain explicit gaps. */
  getMRT(): null {
    return null;
  }
  setMRT(
    value: Parameters<import('three/src/renderers/common/Renderer.js').default['setMRT']>[0],
  ): this {
    if (value !== null) unsupported('Renderer.setMRT').unwrap();
    return this;
  }
  getRenderObjectFunction(): null {
    return null;
  }
  setRenderObjectFunction(
    value: Parameters<
      import('three/src/renderers/common/Renderer.js').default['setRenderObjectFunction']
    >[0],
  ): void {
    if (value !== null) unsupported('Renderer.setRenderObjectFunction').unwrap();
  }
  setRenderTarget(
    target: import('three/src/Three.Core.js').RenderTarget | null,
    activeCubeFace = 0,
    activeMipmapLevel = 0,
  ): void {
    this.assertNotCapturing();
    if (this.asyncTargetOperation)
      invalid('Await the active target operation before switching targets').unwrap();
    if (target !== null) this.ready().targets.target(target);
    if (
      !Number.isInteger(activeCubeFace) ||
      activeCubeFace < 0 ||
      activeCubeFace > 5 ||
      !Number.isSafeInteger(activeMipmapLevel) ||
      activeMipmapLevel < 0
    )
      invalid('Renderer.setRenderTarget face/mip selectors').unwrap();
    // r187 retains these selectors even on the default framebuffer; they do not select a GPU subresource there.
    this.renderTarget = target;
    this.activeCubeFace = activeCubeFace;
    this.activeMipmapLevel = activeMipmapLevel;
  }
  getRenderTarget(): RenderTarget | null {
    return this.renderTarget;
  }

  private sceneCallback(
    scene: Object3D,
    camera: Camera,
    event: 'onBeforeRender' | 'onAfterRender',
  ): void {
    if (scene instanceof Scene)
      Reflect.apply(scene[event], scene, [this, scene, camera, this.renderTarget]);
  }

  private updateScene(scene: Object3D, camera: Camera): boolean {
    if (
      camera.coordinateSystem !== this.coordinateSystem ||
      camera.reversedDepth !== this.reversedDepthBuffer
    ) {
      Object.assign(camera, { _reversedDepth: this.reversedDepthBuffer });
      camera.coordinateSystem = this.coordinateSystem;
      if ('updateProjectionMatrix' in camera && typeof camera.updateProjectionMatrix === 'function')
        camera.updateProjectionMatrix();
    }
    const sourceMatricesReady = hasBeforeRender(scene);
    if (sourceMatricesReady) this.ready().projection.updateMatrices(scene, camera);
    this.sceneCallback(scene, camera, 'onBeforeRender');
    return sourceMatricesReady;
  }

  private prepare(
    scene: Object3D,
    camera: Camera,
    sourceMatricesReady?: boolean,
    post?: ThreePostProcessing,
    externalDemand?: ExternalTextureDemand,
  ) {
    const { projection, native } = this.ready();
    if (this.shadowMap.transmitted)
      unsupported('Transmitted-color shadow maps require native colored shadow transport').unwrap();
    if (
      this.renderTarget === null &&
      (!this.autoClear ||
        !this.autoClearColor ||
        (this.depth && !this.autoClearDepth) ||
        (this.stencil && !this.autoClearStencil))
    )
      unsupported('Renderer partial/no-clear rendering').unwrap();
    if (this.outputColorSpace !== SRGBColorSpace && this.outputColorSpace !== 'display-p3')
      unsupported('Renderer.outputColorSpace outside sRGB/Display P3').unwrap();
    if (this.renderTarget === null) {
      this.validateCanvasTarget(this.canvasTarget);
      this.applyCanvasExtent(this.canvasTarget);
    }
    value(
      native.setOutputColorSpace(this.outputColorSpace === 'display-p3' ? 'display-p3' : 'srgb'),
    );
    const sourceReady = sourceMatricesReady ?? this.updateScene(scene, camera);
    const entity = projection.syncCamera(
      scene,
      camera,
      {
        toneMapping: this.toneMapping === NoToneMapping ? LinearToneMapping : this.toneMapping,
        exposure: this.toneMapping === NoToneMapping ? 1 : this.toneMappingExposure,
        antialias: this.antialias,
        bloom: post?.bloom,
        clearColor: this.clearColorValue,
        clearAlpha: this.clearAlpha,
      },
      {
        externalDemand,
        deferResourceSweep: this.renderTarget !== null,
        pixelRatio: this.getPixelRatio(),
        depth: this.renderTarget?.depthBuffer ?? this.depth,
        stencil: this.renderTarget?.stencilBuffer ?? this.stencil,
        sortObjects: this.sortObjects,
        nativeTransparentOrder: this.sortObjects && this.transparentSort === null,
        transparentSort: this.transparentSort,
        opaqueOrder: true,
        opaqueSort: this.opaqueSort,
        opaque: this.opaque,
        transparent: this.transparent,
        updateMatrices: !sourceReady,
        ecsPoses: !sourceReady,
        shadowMap: { ...this.shadowMap, cameraLayers: camera.layers.mask },
      },
    );
    this.projectCameraEffects(projection, entity, camera, post);
    this.projectComposerProfile(native, post);
    return entity;
  }

  private projectComposerProfile(
    native: ReturnType<WebGPURenderer['ready']>['native'],
    post: ThreePostProcessing | undefined,
  ): void {
    const composerUsesGtao = post?.ao !== undefined;
    if (composerUsesGtao !== (this.composerAoBase !== undefined)) {
      const { profile } = native.inspect({ fields: ['profile'] });
      const ambientOcclusion = this.composerAoBase ?? {
        ...profile.ambientOcclusion,
        method: 'gtao' as const,
        gtao: {
          ...(post?.ao?.radius === undefined ? {} : { falloffEnd: post.ao.radius }),
          ...(post?.ao?.downsample === undefined ? {} : { downsample: post.ao.downsample }),
        },
      };
      value(native.setProfile({ ...profile, ambientOcclusion }));
      this.composerAoBase = composerUsesGtao ? profile.ambientOcclusion : undefined;
    }
  }

  private projectCameraEffects(
    projection: SceneProjection,
    entity: ReturnType<SceneProjection['sync']>,
    camera: Camera,
    post: ThreePostProcessing | undefined,
  ): void {
    const hasAO = projection.world.hasComponent(entity, AmbientOcclusion);
    if (post?.ao !== undefined) {
      const { samples, downsample: _downsample, ...settings } = post.ao;
      const quality =
        samples === undefined || samples > 16
          ? AMBIENT_OCCLUSION_QUALITY_HIGH
          : samples > 8
            ? AMBIENT_OCCLUSION_QUALITY_MEDIUM
            : AMBIENT_OCCLUSION_QUALITY_LOW;
      const data = { ...settings, quality };
      if (hasAO) projection.world.set(entity, AmbientOcclusion, data).unwrap();
      else projection.world.addComponent(entity, { component: AmbientOcclusion, data }).unwrap();
    } else if (hasAO) {
      projection.world.removeComponent(entity, AmbientOcclusion).unwrap();
    }
    const reflection = this.renderTarget === null ? this.planarReflections?.get(camera) : undefined;
    if (reflection !== undefined && !projection.world.hasComponent(entity, PlanarReflection)) {
      projection.world
        .addComponent(entity, { component: PlanarReflection, data: reflection })
        .unwrap();
    }
  }

  private targetWrite(
    clearOnly = false,
    color = this.autoClear && this.autoClearColor,
    depth = this.autoClear && this.autoClearDepth,
    stencil = this.autoClear && this.autoClearStencil,
  ): RenderTargetWrite | undefined {
    const target = this.renderTarget;
    if (target === null) return undefined;
    const cube = target.texture instanceof CubeTexture;
    if (
      (!cube && this.activeCubeFace !== 0) ||
      this.activeMipmapLevel > Math.floor(Math.log2(Math.max(target.width, target.height)))
    )
      invalid('Renderer target face/mip extent').unwrap();
    return {
      target: this.ready().targets.target(target),
      layer: cube && this.activeCubeFace < 2 ? 1 - this.activeCubeFace : this.activeCubeFace,
      mipLevel: this.activeMipmapLevel,
      clearColor: color,
      clearDepth: depth,
      clearStencil: stencil,
      clearOnly,
    };
  }

  private async submitTargetReady(entity: ReturnType<SceneProjection['sync']>): Promise<void> {
    const deadline = Date.now() + 20000;
    const write = this.targetWrite();
    for (;;) {
      const receipt = this.submit(entity, write);
      const completed = await targetWork(receipt.completed, deadline);
      value(completed);
      if (receipt.presentation === 'ready') return;
      if (Date.now() >= deadline)
        throw new ThreeCompatibilityError(
          'renderer-not-ready',
          'RenderTarget preparation deadline',
          'Inspect the native receipt preparation blocker.',
        );
      if (receipt.preparationCompleted !== undefined)
        value(await targetWork(receipt.preparationCompleted, deadline));
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private submit(
    entity: ReturnType<SceneProjection['sync']>,
    targetWrite = this.targetWrite(),
  ): FrameReceipt {
    const { native, lease } = this.ready();
    const profileFrame = this.profiler?.activeSession()?.currentFrameToken();
    const receipt = value(
      native.draw({
        source: lease,
        camera: { entityKey: entity },
        geometryLane: 'direct',
        ...(profileFrame === undefined ? {} : { profileFrame }),
        ...(targetWrite === undefined ? {} : { targetWrite }),
      }),
    );
    this.noteSubmission(receipt);
    return receipt;
  }

  private noteSubmission(receipt: FrameReceipt): void {
    this.receipt = receipt;
    if (receipt.presentation === 'ready') {
      this.ready().projection.submitted();
      if (this.renderTarget !== null && this.activeMipmapLevel === 0)
        this.ready().targets.submitted(this.renderTarget);
    }
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new ThreeCompatibilityError(
        'renderer-disposed',
        'WebGPURenderer',
        'Create a new renderer.',
      );
  }
  private assertNotCapturing(): void {
    this.assertAlive();
    if (this.captureAbort !== undefined)
      throw new ThreeCompatibilityError(
        'renderer-capture-busy',
        'WebGPURenderer',
        'Await the current capture before rendering or capturing again.',
      );
  }
  private ready() {
    this.assertAlive();
    if (this.runtime === undefined)
      throw new ThreeCompatibilityError(
        'renderer-not-ready',
        'WebGPURenderer',
        'Await renderer.init() or use setAnimationLoop().',
      );
    return this.runtime;
  }
}
