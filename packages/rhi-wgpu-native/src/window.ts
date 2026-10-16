import { type RhiCanvasTarget, RhiError, type RhiInstance } from '@forgeax/engine-rhi';
import { type GpuLike, requestAdapterFrom, rhi as webgpuRhi } from '@forgeax/engine-rhi-webgpu';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { NativeWindowBinding } from './binding';
import { NativeGPU, NativeGPUDevice, NativeGPUTexture } from './gpu';

export interface NativeWindowOptions {
  readonly title?: string;
  /** Initial physical pixel dimensions; subsequent facts come from the native window. */
  readonly width: number;
  readonly height: number;
}

export interface NativeWindowFacts {
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
  readonly visible: boolean;
}

export type NativeWindowEvent =
  | { readonly kind: 'redraw' | 'display' | 'close-requested' | 'surface-lost' }
  | { readonly kind: 'visibility'; readonly visible: boolean };

function operation<T>(name: string, run: () => T): Result<T, RhiError> {
  try {
    return ok(run());
  } catch (cause) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: `a live native window can ${name}`,
        hint: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
}

class NativeCanvasContext {
  private configuration: GPUCanvasConfiguration | undefined;
  private current: NativeGPUTexture | undefined;
  private removePresenter: (() => void) | undefined;
  private width = 0;
  private height = 0;

  constructor(private readonly native: NativeWindowBinding) {}

  get supportedAlphaModes(): readonly GPUCanvasAlphaMode[] {
    return Object.freeze(this.native.supportedAlphaModes());
  }

  configure(configuration: GPUCanvasConfiguration): void {
    if (!(configuration.device instanceof NativeGPUDevice))
      throw new TypeError('A native surface requires a device from its native GPU');
    if (
      (configuration.colorSpace ?? 'srgb') !== 'srgb' ||
      (configuration.toneMapping?.mode ?? 'standard') !== 'standard'
    )
      throw new TypeError('Native surfaces currently support standard sRGB presentation');
    const facts = JSON.parse(this.native.facts()) as NativeWindowFacts;
    this.expire();
    this.native.configure(
      configuration.device.native,
      JSON.stringify({
        format: configuration.format,
        alphaMode: configuration.alphaMode ?? 'opaque',
        usage: configuration.usage ?? 0x10,
        viewFormats: Array.from(configuration.viewFormats ?? []),
      }),
    );
    this.removePresenter?.();
    this.configuration = {
      ...configuration,
      viewFormats: Array.from(configuration.viewFormats ?? []),
    };
    this.width = facts.width;
    this.height = facts.height;
    this.removePresenter = configuration.device.attachSurface({
      present: (textures) => {
        if (this.current === undefined || !textures.has(this.current)) return;
        try {
          this.native.present();
        } finally {
          this.expire();
        }
      },
      retire: () => this.unconfigure(),
    });
  }

  unconfigure(): void {
    this.expire();
    this.removePresenter?.();
    this.removePresenter = undefined;
    this.configuration = undefined;
    this.native.unconfigure();
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    return this.configuration ? { ...this.configuration } : null;
  }

  getCurrentTexture(): NativeGPUTexture {
    const configuration = this.configuration;
    if (!configuration)
      throw new DOMException('Native surface is unconfigured', 'InvalidStateError');
    const facts = JSON.parse(this.native.facts()) as NativeWindowFacts;
    if (facts.width !== this.width || facts.height !== this.height) this.configure(configuration);
    if (this.current) return this.current;
    const device = configuration.device as unknown as NativeGPUDevice;
    this.current = new NativeGPUTexture(
      device,
      {
        label: 'native-window-surface',
        size: { width: this.width, height: this.height },
        format: configuration.format,
        usage: configuration.usage ?? 0x10,
        viewFormats: Array.from(configuration.viewFormats ?? []),
      },
      this.native.acquireTexture(device.native),
    );
    return this.current;
  }

  private expire(): void {
    this.current?.expire();
    this.current = undefined;
  }
}

/** A native target with the existing canvas-context shape, without DOM identity or GPU readback. */
export interface NativeWindowCanvas extends RhiCanvasTarget {
  getContext(kind: string): NativeCanvasContext | null;
}

/** Host-owned native window. Renderer borrows its canvas and owns its ordinary GPU device. */
export class NativeWindow {
  readonly gpu: NativeGPU;
  readonly rhi: typeof webgpuRhi & RhiInstance;
  readonly canvas: NativeWindowCanvas;
  private readonly context: NativeCanvasContext;
  private closed = false;

  constructor(
    private readonly native: NativeWindowBinding,
    hidden: ReadonlySet<string>,
  ) {
    this.gpu = new NativeGPU(
      {
        requestAdapter: (power, fallback) => native.requestAdapter(power, fallback),
        preferredCanvasFormat: () => native.preferredFormat(),
      },
      hidden,
    );
    this.rhi = {
      ...webgpuRhi,
      requestAdapter: (options) => requestAdapterFrom(this.gpu as unknown as GpuLike, options),
    };
    const context = new NativeCanvasContext(native);
    this.context = context;
    this.canvas = {
      get width() {
        return (JSON.parse(native.facts()) as NativeWindowFacts).width;
      },
      get height() {
        return (JSON.parse(native.facts()) as NativeWindowFacts).height;
      },
      getContext: (kind) => (kind === 'webgpu' ? context : null),
    };
  }

  facts(): Result<NativeWindowFacts, RhiError> {
    return operation(
      'read display facts',
      () => JSON.parse(this.native.facts()) as NativeWindowFacts,
    );
  }

  pollEvents(): Result<readonly NativeWindowEvent[], RhiError> {
    return operation(
      'poll events',
      () => JSON.parse(this.native.pollEvents()) as NativeWindowEvent[],
    );
  }

  requestRedraw(): Result<void, RhiError> {
    return operation('request a native frame', () => this.native.requestRedraw());
  }

  resize(width: number, height: number): Result<void, RhiError> {
    return operation('resize', () => {
      if (
        ![width, height].every(
          (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff,
        )
      )
        throw new RangeError('Native window dimensions must be positive u32 integers');
      this.native.resize(width, height);
    });
  }

  close(): Result<void, RhiError> {
    if (this.closed) return ok(undefined);
    this.closed = true;
    return operation('close', () => {
      const errors: unknown[] = [];
      try {
        this.context.unconfigure();
      } catch (cause) {
        errors.push(cause);
      }
      try {
        this.native.close();
      } catch (cause) {
        errors.push(cause);
      }
      if (errors.length) throw new AggregateError(errors, 'Native surface/window cleanup failed');
    });
  }
}
