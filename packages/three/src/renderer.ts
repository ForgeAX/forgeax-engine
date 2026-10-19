import { createRhiInstrumentation } from '@forgeax/engine-app';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  type FrameReceipt,
  type FrameReceiptObservation,
  type Renderer,
  type RendererOptions,
  type RenderWorldLease,
  TONEMAP_NONE,
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
import type { MaterialAsset } from '@forgeax/engine-types';
import type { WebGLRendererParameters as UpstreamParameters } from 'three/src/renderers/WebGLRenderer.js';
import {
  type Camera,
  Color,
  ColorManagement,
  type ColorRepresentation,
  NoToneMapping,
  type Object3D,
  Scene,
  SRGBColorSpace,
  type ToneMapping,
  type Vector2,
  WebGLCoordinateSystem,
} from 'three/src/Three.Core.js';
import { cameraData } from './camera';
import { invalid, migration, ThreeCompatibilityError, unsupported } from './errors';
import { prepareMaterialPrograms } from './material-programs';
import { threePipeline } from './pipeline';
import { SceneProjection, type ThreeSourceIdentity } from './scene';

export interface WebGLRendererParameters extends Omit<UpstreamParameters, 'canvas'> {
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas;
  readonly forgeax?: {
    /** Default: the browser WebGPU backend. An explicit backend is never silently replaced. */
    readonly backend?: RecordableBackend;
    readonly renderer?: Omit<RendererOptions, 'rhi' | 'rhiInstrumentation' | 'pipeline'>;
    readonly bundler?: BundlerOptions;
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
export class WebGLRenderer {
  readonly domElement: HTMLCanvasElement | OffscreenCanvas;
  autoClear = true;
  autoClearColor = true;
  autoClearDepth = true;
  autoClearStencil = true;
  readonly coordinateSystem = WebGLCoordinateSystem;
  toneMapping: ToneMapping = NoToneMapping;
  toneMappingExposure = 1;
  outputColorSpace: string = SRGBColorSpace;
  private materialProgram: ((material: MaterialAsset) => MaterialAsset) | undefined;
  private readonly projection = new SceneProjection((material) => {
    if (this.materialProgram === undefined)
      throw new Error('material programs are not initialized');
    return this.materialProgram(material);
  });
  private readonly recorder: RecorderAttachment;
  private readonly initializing: Promise<void>;
  private native: Renderer | undefined;
  private lease: RenderWorldLease | undefined;
  private disposed = false;
  private disposing: Promise<void> | undefined;
  private captureAbort: AbortController | undefined;
  private pixelRatio = 1;
  private width: number;
  private height: number;
  private readonly clearColor = new Color(0);
  private clearAlpha = 1;
  private readonly antialias: number;
  private loop: ((time: number) => void) | null = null;
  private animationRequest: number | undefined;
  private receipt: FrameReceipt | undefined;

  constructor(parameters: WebGLRendererParameters = {}) {
    if (parameters.forgeax?.renderer && 'pipeline' in parameters.forgeax.renderer)
      invalid('forgeax.renderer.pipeline: Three compatibility owns the output pipeline').unwrap();
    for (const key of Object.keys(parameters)) {
      if (
        !['canvas', 'antialias', 'alpha', 'forgeax'].includes(key) &&
        parameters[key as keyof WebGLRendererParameters] !== undefined
      )
        unsupported(`WebGLRenderer parameter ${key}`).unwrap();
    }
    if (parameters.alpha === true) unsupported('WebGLRenderer alpha canvas compositing').unwrap();
    if (parameters.canvas === undefined && typeof document === 'undefined')
      unsupported('WebGLRenderer requires canvas outside a browser').unwrap();
    this.domElement = parameters.canvas ?? document.createElement('canvas');
    this.width = this.domElement.width;
    this.height = this.domElement.height;
    this.antialias = parameters.antialias ? ANTIALIAS_MSAA : ANTIALIAS_NONE;
    this.recorder = attachRecorder(parameters.forgeax?.backend ?? webgpu).unwrap();
    this.initializing = this.initialize(parameters.forgeax);
    // A caller may attach its rejection handler after construction; init() retains the original error.
    void this.initializing.catch(() => undefined);
  }

  private async initialize(options: WebGLRendererParameters['forgeax']): Promise<void> {
    let native: Renderer | undefined;
    try {
      const host = value(
        await constructRuntimeRendererHost(
          this.domElement,
          {
            ...options?.renderer,
            pipeline: threePipeline,
            rhi: this.recorder.backend.rhi,
            rhiInstrumentation: createRhiInstrumentation(this.recorder),
          },
          options?.bundler,
        ),
      );
      native = host.renderer;
      value(await host.initialization);
      this.materialProgram = await prepareMaterialPrograms(host.assets);
      if (this.disposed) {
        value(await native.dispose());
        return;
      }
      this.lease = value(native.attach(this.projection.world));
      this.native = native;
    } catch (error) {
      this.native = undefined;
      try {
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

  setSize(width: number, height: number, updateStyle = true): void {
    this.assertNotCapturing();
    if (![width, height].every((dimension) => Number.isFinite(dimension) && dimension > 0))
      invalid('Renderer.setSize').unwrap();
    this.width = width;
    this.height = height;
    this.domElement.width = Math.floor(width * this.pixelRatio);
    this.domElement.height = Math.floor(height * this.pixelRatio);
    if (updateStyle && 'style' in this.domElement) {
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
    }
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
  setPixelRatio(ratio: number): void {
    this.assertNotCapturing();
    if (!Number.isFinite(ratio) || ratio <= 0) invalid('Renderer.setPixelRatio').unwrap();
    this.pixelRatio = ratio;
    this.setSize(this.width, this.height, false);
  }
  setClearColor(color: ColorRepresentation, alpha = 1): void {
    this.assertAlive();
    this.clearColor.set(color);
    this.setClearAlpha(alpha);
  }
  getClearColor(target: Color): Color {
    return target.copy(this.clearColor);
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

  render(scene: Object3D, camera: Camera): void {
    this.assertNotCapturing();
    this.submit(this.prepare(scene, camera));
  }

  setAnimationLoop(callback: ((time: number) => void) | null): void {
    this.assertAlive();
    if (this.animationRequest !== undefined) cancelAnimationFrame(this.animationRequest);
    this.animationRequest = undefined;
    this.loop = callback;
    if (callback === null) return;
    if (typeof requestAnimationFrame !== 'function')
      unsupported('setAnimationLoop requires requestAnimationFrame').unwrap();
    void this.initializing
      .then(() => {
        if (!this.disposed && this.loop === callback && this.animationRequest === undefined)
          this.schedule();
      })
      .catch((error: unknown) => {
        if (!this.disposed) globalThis.reportError(error);
      });
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
    return this.ready().subscribe(listener);
  }

  inspect(): {
    renderer: ReturnType<Renderer['inspect']>;
    sources: readonly ThreeSourceIdentity[];
    receipt: FrameReceipt | undefined;
  } {
    return {
      renderer: this.ready().inspect(),
      sources: this.projection.sources(),
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
    const native = this.ready();
    const sources = this.projection.sources();
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
      this.lease?.dispose();
      this.projection.dispose();
      try {
        if (this.native !== undefined) value(await this.native.dispose());
      } finally {
        (await this.recorder.dispose()).unwrap();
      }
    })();
    return this.disposing;
  }

  getContext(): never {
    return migration('Renderer.getContext: Forgeax does not expose a WebGL context').unwrap();
  }
  setRenderTarget(target: null): void {
    if (target !== null) unsupported('Renderer.setRenderTarget').unwrap();
  }
  getRenderTarget(): null {
    return null;
  }

  private prepare(scene: Object3D, camera: Camera) {
    this.ready();
    if (!this.autoClear || !this.autoClearColor || !this.autoClearDepth || !this.autoClearStencil)
      unsupported('Renderer partial/no-clear rendering').unwrap();
    if (this.outputColorSpace !== SRGBColorSpace)
      unsupported('Renderer.outputColorSpace other than SRGBColorSpace').unwrap();
    const data = cameraData(camera, this.toneMapping, this.toneMappingExposure);
    const background = ColorManagement.workingToColorSpace(
      (scene instanceof Scene && scene.background instanceof Color
        ? scene.background
        : this.clearColor
      ).clone(),
      this.outputColorSpace,
    );
    return this.projection.sync(
      scene,
      camera,
      {
        ...data,
        tonemap: TONEMAP_NONE,
        exposure: 1,
        antialias: this.antialias,
        clearColor: new Float32Array([
          ...background.toArray(),
          scene instanceof Scene && scene.background instanceof Color ? 1 : this.clearAlpha,
        ]),
      },
      [data.tonemap ?? TONEMAP_NONE, this.toneMappingExposure, 1, 0],
    );
  }

  private submit(entity: ReturnType<SceneProjection['sync']>): FrameReceipt {
    const native = this.ready();
    const lease = this.lease;
    if (lease === undefined)
      throw new Error('ready compatibility renderer missing its World lease');
    const receipt = value(
      native.draw({
        leases: [lease],
        camera: { lease, entityKey: entity },
        environment: { lease },
        geometryLane: 'direct',
      }),
    );
    this.receipt = receipt;
    return receipt;
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new ThreeCompatibilityError(
        'renderer-disposed',
        'WebGLRenderer',
        'Create a new renderer.',
      );
  }
  private assertNotCapturing(): void {
    this.assertAlive();
    if (this.captureAbort !== undefined)
      throw new ThreeCompatibilityError(
        'renderer-capture-busy',
        'WebGLRenderer',
        'Await the current capture before rendering or capturing again.',
      );
  }
  private ready(): Renderer {
    this.assertAlive();
    if (this.native === undefined)
      throw new ThreeCompatibilityError(
        'renderer-not-ready',
        'WebGLRenderer',
        'Await renderer.init() or use setAnimationLoop().',
      );
    return this.native;
  }
}
