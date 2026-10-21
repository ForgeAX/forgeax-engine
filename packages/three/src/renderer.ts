import { createRhiInstrumentation } from '@forgeax/engine-app';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  type FrameReceipt,
  type FrameReceiptObservation,
  type Renderer,
  type RendererOptions,
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
import type Color4 from 'three/src/renderers/common/Color4.js';
import type { WebGPURendererParameters as UpstreamParameters } from 'three/src/renderers/webgpu/WebGPURenderer.js';
import {
  type BufferGeometry,
  type Camera,
  Color,
  type ColorRepresentation,
  HalfFloatType,
  Line,
  LinearToneMapping,
  LOD,
  Mesh,
  NoToneMapping,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Points,
  Scene,
  type ShadowMapType,
  Sprite,
  SRGBColorSpace,
  Texture,
  type ToneMapping,
  UnsignedByteType,
  type Vector2,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three/src/Three.Core.js';
import { cameraData } from './camera';
import { invalid, ThreeCompatibilityError, unsupported } from './errors';
import { ExternalTextures, isExternalTexture } from './external-textures';
import { materialTextures, validateMaterial } from './material';
import { prepareMaterialPrograms } from './material-programs';
import { threePipeline } from './pipeline';
import { SceneProjection, type ThreeSourceIdentity } from './scene';

export interface WebGPURendererParameters extends Omit<UpstreamParameters, 'canvas'> {
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas;
  readonly forgeax?: {
    /** Default: the browser WebGPU backend. An explicit backend is never silently replaced. */
    readonly backend?: RecordableBackend;
    readonly renderer?: Omit<RendererOptions, 'rhi' | 'rhiInstrumentation' | 'pipeline'>;
    readonly bundler?: BundlerOptions;
    /** Extra exact Physical texture variants, produced by three/build at build time. */
    readonly materialPrograms?: readonly string[];
  };
}

export interface ThreeFrameCapture {
  readonly tape: EncodedTape;
  readonly receipt: FrameReceipt;
  readonly sources: readonly ThreeSourceIdentity[];
  /** Native source/entity/material/pipeline identities; shared pipelines may represent several draws. */
  readonly observation: FrameReceiptObservation;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Three's authoring objects, one Forgeax Renderer, and no upstream GPU renderer. */
export class WebGPURenderer {
  readonly domElement: HTMLCanvasElement | OffscreenCanvas;
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  sortObjects = true;
  transparent = true;
  opaque = true;
  readonly shadowMap: { enabled: boolean; type: ShadowMapType } = {
    enabled: false,
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
  private readonly outputType: typeof HalfFloatType | typeof UnsignedByteType;
  toneMapping: ToneMapping = NoToneMapping;
  toneMappingExposure = 1;
  outputColorSpace: string = SRGBColorSpace;
  private readonly recorder: RecorderAttachment;
  private readonly initializing: Promise<void>;
  private runtime:
    | {
        native: Renderer;
        projection: SceneProjection;
        lease: RenderWorldLease;
        external: ExternalTextures;
      }
    | undefined;
  private disposed = false;
  private disposing: Promise<void> | undefined;
  private captureAbort: AbortController | undefined;
  private pixelRatio = 1;
  private readonly viewport = new Vector4();
  private readonly scissor = new Vector4();
  private scissorTest = false;
  private width: number;
  private height: number;
  private readonly clearColorValue = new Color(0);
  private clearAlpha = 1;
  private get antialias(): number {
    return this.sampleCount === 4 ? ANTIALIAS_MSAA : ANTIALIAS_NONE;
  }
  private loop: ((time: number) => void) | null = null;
  private animationRequest: number | undefined;
  private receipt: FrameReceipt | undefined;

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
    this.width = this.domElement.width;
    this.height = this.domElement.height;
    this.viewport.set(0, 0, this.width, this.height);
    this.scissor.copy(this.viewport);
    this.recorder = attachRecorder(parameters.forgeax?.backend ?? webgpu).unwrap();
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
    try {
      const host = value(
        await constructRuntimeRendererHost(
          this.domElement,
          {
            ...options?.renderer,
            pipeline: threePipeline(format),
            rhi: this.recorder.backend.rhi,
            rhiInstrumentation: createRhiInstrumentation(this.recorder),
          },
          options?.bundler,
        ),
      );
      native = host.renderer;
      value(await host.initialization);
      if (this.disposed) {
        value(await native.dispose());
        return;
      }
      const external = new ExternalTextures(native);
      projection = new SceneProjection(
        host.assets,
        external,
        await prepareMaterialPrograms(host.assets, options?.materialPrograms),
      );
      const lease = value(native.attach(projection.world));
      this.runtime = { native, projection, lease, external };
    } catch (error) {
      try {
        projection?.dispose();
        if (native !== undefined) value(await native.dispose());
      } finally {
        (await this.recorder.dispose()).unwrap();
      }
      throw error;
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
    return this.toneMapping;
  }
  get currentColorSpace(): string {
    return this.outputColorSpace;
  }
  get isOutputTarget(): boolean {
    return true;
  }
  get needsFrameBufferTarget(): boolean {
    return true;
  }
  get currentSamples(): number {
    return 0;
  }
  getActiveCubeFace(): number {
    return 0;
  }
  getActiveMipmapLevel(): number {
    return 0;
  }

  setSize(width: number, height: number, updateStyle = true): void {
    this.assertNotCapturing();
    if (![width, height].every((dimension) => Number.isFinite(dimension) && dimension > 0))
      invalid('Renderer.setSize').unwrap();
    this.width = width;
    this.height = height;
    this.viewport.set(0, 0, width, height);
    this.domElement.width = Math.floor(width * this.pixelRatio);
    this.domElement.height = Math.floor(height * this.pixelRatio);
    if (updateStyle && 'style' in this.domElement) {
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
    }
  }

  getViewport(target: Vector4): Vector4 {
    return target.copy(this.viewport);
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
    if (
      minDepth !== 0 ||
      maxDepth !== 1 ||
      !rectangle.equals(new Vector4(0, 0, this.width, this.height))
    )
      unsupported('Partial viewport/depth ranges require native per-draw viewport state').unwrap();
    this.viewport.copy(rectangle);
  }
  getScissor(target: Vector4): Vector4 {
    return target.copy(this.scissor);
  }
  setScissor(x: number | Vector4, y?: number, width?: number, height?: number): void {
    this.assertNotCapturing();
    const rectangle = typeof x === 'number' ? new Vector4(x, y, width, height) : x;
    if (!rectangle.toArray().every(Number.isFinite)) invalid('Renderer.setScissor').unwrap();
    if (this.scissorTest && !rectangle.equals(new Vector4(0, 0, this.width, this.height)))
      unsupported('Partial scissor requires native per-draw scissor state').unwrap();
    this.scissor.copy(rectangle);
  }
  getScissorTest(): boolean {
    return this.scissorTest;
  }
  setScissorTest(enabled: boolean): void {
    this.assertNotCapturing();
    if (enabled && !this.scissor.equals(new Vector4(0, 0, this.width, this.height)))
      unsupported('Partial scissor requires native per-draw scissor state').unwrap();
    this.scissorTest = enabled;
  }

  getSize(target: Vector2): Vector2 {
    return target.set(this.width, this.height);
  }
  getDrawingBufferSize(target: Vector2): Vector2 {
    return target.set(this.domElement.width, this.domElement.height);
  }
  setDrawingBufferSize(width: number, height: number, pixelRatio: number): void {
    this.assertNotCapturing();
    if (![width, height, pixelRatio].every((value) => Number.isFinite(value) && value > 0))
      invalid('Renderer.setDrawingBufferSize').unwrap();
    this.pixelRatio = pixelRatio;
    this.setSize(width, height, false);
  }
  getPixelRatio(): number {
    return this.pixelRatio;
  }
  setPixelRatio(ratio = 1): void {
    this.assertNotCapturing();
    if (!Number.isFinite(ratio) || ratio <= 0) invalid('Renderer.setPixelRatio').unwrap();
    this.pixelRatio = ratio;
    this.setSize(this.width, this.height, false);
  }
  setClearColor(color: ColorRepresentation, alpha = 1): void {
    this.assertAlive();
    this.clearColorValue.set(color);
    this.setClearAlpha(alpha);
  }
  getClearColor(target: Color4): Color4;
  getClearColor<T extends Color>(target: T): T;
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
    if (!color && (!this.depth || !depth) && (!this.stencil || !stencil)) return;
    if (!color || (this.depth && !depth) || (this.stencil && !stencil))
      unsupported('Partial clears require native attachment load/store control').unwrap();
    const { projection } = this.ready();
    const camera = new PerspectiveCamera();
    const entity = projection.sync(new Scene(), camera, {
      ...cameraData(
        camera,
        this.toneMapping === NoToneMapping ? LinearToneMapping : this.toneMapping,
        this.toneMapping === NoToneMapping ? 1 : this.toneMappingExposure,
      ),
      antialias: this.antialias,
      clearColor: new Float32Array([...this.clearColorValue.toArray(), this.clearAlpha]),
    });
    this.submit(entity);
  }
  async clearAsync(color = true, depth = true, stencil = true): Promise<void> {
    await this.init();
    this.clear(color, depth, stencil);
  }

  render(scene: Object3D, camera: Camera): void {
    this.assertNotCapturing();
    this.submit(this.prepare(scene, camera));
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
    sources: readonly ThreeSourceIdentity[];
    receipt: FrameReceipt | undefined;
  } {
    const { native, projection } = this.ready();
    return {
      renderer: native.inspect(),
      sources: projection.sources(),
      receipt: this.receipt,
    };
  }

  /** Capture one already prepared scene through the existing RHI recorder. No simulation time advances. */
  async captureFrame(
    scene: Object3D,
    camera: Camera,
    options: CaptureFrameOptions = {},
  ): Promise<ThreeFrameCapture> {
    this.assertNotCapturing();
    const entity = this.prepare(scene, camera);
    const { native, projection } = this.ready();
    const sources = projection.sources();
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
    this.disposing = (async () => {
      await this.initializing.catch(() => undefined);
      const runtime = this.runtime;
      this.runtime = undefined;
      runtime?.lease.dispose();
      runtime?.projection.dispose();
      runtime?.external.dispose();
      try {
        if (runtime !== undefined) value(await runtime.native.dispose());
      } finally {
        (await this.recorder.dispose()).unwrap();
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
    await this.init();
    this.updateScene(scene, camera);
    scene.traverseVisible((object) => {
      if (object instanceof LOD && object.autoUpdate && object.layers.test(camera.layers))
        object.update(camera);
    });
    const pending: Promise<void>[] = [];
    scene.traverseVisible((object) => {
      if (!object.layers.test(camera.layers)) return;
      if (
        !(
          object instanceof Mesh ||
          object instanceof Sprite ||
          object instanceof Line ||
          object instanceof Points
        )
      )
        return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const geometry = object.geometry as BufferGeometry;
      const slots = Array.isArray(object.material)
        ? geometry.groups
            .filter(
              (group) =>
                Math.min(
                  group.start + group.count,
                  geometry.drawRange.start + geometry.drawRange.count,
                ) > Math.max(group.start, geometry.drawRange.start),
            )
            .map((group) => group.materialIndex ?? 0)
        : [0];
      for (const slot of new Set(slots)) {
        const material = materials[slot];
        if (material === undefined || !material.visible) continue;
        const effective =
          scene instanceof Scene && material.allowOverride && scene.overrideMaterial !== null
            ? scene.overrideMaterial
            : material;
        // Overrides inherit coverage from the original material in r184.
        const textures = materialTextures(validateMaterial(effective).unwrap());
        if (
          effective !== material &&
          'alphaMap' in material &&
          material.alphaMap instanceof Texture
        )
          textures.push(['alphaTexture', material.alphaMap]);
        for (const [, texture] of textures)
          if (isExternalTexture(texture)) pending.push(this.ready().external.initialize(texture));
      }
    });
    await Promise.all(pending);
    this.assertNotCapturing();
    this.submit(this.prepare(scene, camera, true));
    this.sceneCallback(scene, camera, 'onAfterRender');
  }

  async initTextureAsync(texture: Texture): Promise<void> {
    await this.init();
    if (!isExternalTexture(texture))
      return unsupported(
        'initTexture for asset textures requires native eager upload admission',
      ).unwrap();
    await this.ready().external.initialize(texture);
  }

  hasFeature(name: string): boolean {
    return value(this.ready().native.nativeDevice()).features.has(name as GPUFeatureName);
  }
  async hasFeatureAsync(name: string): Promise<boolean> {
    await this.init();
    return this.hasFeature(name);
  }

  getMaxAnisotropy(): number {
    this.ready();
    return 16;
  }

  setRenderTarget(target: null): void {
    if (target !== null) unsupported('Renderer.setRenderTarget').unwrap();
  }
  getRenderTarget(): null {
    return null;
  }

  private sceneCallback(
    scene: Object3D,
    camera: Camera,
    event: 'onBeforeRender' | 'onAfterRender',
  ): void {
    if (scene instanceof Scene) Reflect.apply(scene[event], scene, [this, scene, camera, null]);
  }

  private updateScene(scene: Object3D, camera: Camera): void {
    if (
      camera.coordinateSystem !== this.coordinateSystem ||
      camera.reversedDepth !== this.reversedDepthBuffer
    ) {
      Object.assign(camera, { _reversedDepth: this.reversedDepthBuffer });
      camera.coordinateSystem = this.coordinateSystem;
      if ('updateProjectionMatrix' in camera && typeof camera.updateProjectionMatrix === 'function')
        camera.updateProjectionMatrix();
    }
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();
    this.sceneCallback(scene, camera, 'onBeforeRender');
  }

  private prepare(scene: Object3D, camera: Camera, updated = false) {
    const { projection, native } = this.ready();
    if (
      !this.autoClear ||
      !this.autoClearColor ||
      (this.depth && !this.autoClearDepth) ||
      (this.stencil && !this.autoClearStencil)
    )
      unsupported('Renderer partial/no-clear rendering').unwrap();
    if (this.outputColorSpace !== SRGBColorSpace && this.outputColorSpace !== 'display-p3')
      unsupported('Renderer.outputColorSpace outside sRGB/Display P3').unwrap();
    if (this.scissorTest && !this.scissor.equals(new Vector4(0, 0, this.width, this.height)))
      unsupported('Partial scissor requires native per-draw scissor state').unwrap();
    value(
      native.setOutputColorSpace(this.outputColorSpace === 'display-p3' ? 'display-p3' : 'srgb'),
    );
    if (!updated) this.updateScene(scene, camera);
    const data = cameraData(
      camera,
      this.toneMapping === NoToneMapping ? LinearToneMapping : this.toneMapping,
      this.toneMapping === NoToneMapping ? 1 : this.toneMappingExposure,
    );
    const background =
      scene instanceof Scene && scene.background instanceof Color
        ? scene.background
        : this.clearColorValue;
    return projection.sync(
      scene,
      camera,
      {
        ...data,
        antialias: this.antialias,
        clearColor: new Float32Array([
          ...background.toArray(),
          scene instanceof Scene && scene.background instanceof Color ? 1 : this.clearAlpha,
        ]),
      },
      {
        depth: this.depth,
        stencil: this.stencil,
        sortObjects: this.sortObjects,
        opaque: this.opaque,
        transparent: this.transparent,
        updateMatrices: false,
        shadowMap: { ...this.shadowMap, cameraLayers: camera.layers.mask },
      },
    );
  }

  private submit(entity: ReturnType<SceneProjection['sync']>): FrameReceipt {
    const { native, lease } = this.ready();
    const receipt = value(
      native.draw({
        leases: [lease],
        camera: { lease, entityKey: entity },
        environment: { lease },
        geometryLane: 'direct',
      }),
    );
    this.receipt = receipt;
    if (receipt.presentation === 'ready') this.ready().projection.submitted();
    return receipt;
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
