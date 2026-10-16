import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
// @forgeax/engine-rhi-null/src/canvas-context - headless canvas context.

import type {
  CanvasConfiguration,
  Result,
  RhiCanvasContext,
  RhiDevice,
  RhiError as RhiErrorType,
  Texture,
  TextureDescriptor,
} from '@forgeax/engine-rhi';
import { RhiError as RhiErrorClass } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { readRecord } from './bookkeeping';

const DEFAULT_USAGE = 0x10;
const VALID_TEXTURE_USAGE = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20;
const TRANSIENT_ATTACHMENT = 0x20;
const RENDER_ATTACHMENT = 0x10;
const SUPPORTED_CONTEXT_FORMATS = new Set(['bgra8unorm', 'rgba8unorm', 'rgba16float']);

type CanvasSurface = Pick<RhiCanvasTarget, 'width' | 'height'>;

interface CanvasExtent {
  readonly width: number;
  readonly height: number;
}

interface CurrentTexture {
  readonly device: RhiDevice;
  readonly texture: Texture;
  readonly extent: CanvasExtent;
  completion?: Promise<undefined> | undefined;
  failure?: RhiErrorType | undefined;
}

function cleanupError(cause: unknown, operation: string): RhiErrorType {
  if (cause instanceof RhiErrorClass) return cause;
  const wrapped = new RhiErrorClass({
    code: 'rhi-not-available',
    expected: `the configured device must ${operation}`,
    hint: `retry the owner operation after repairing its failure: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
  wrapped.cause = cause;
  return wrapped;
}

function error(code: RhiErrorType['code'], expected: string, hint: string): RhiErrorType {
  return new RhiErrorClass({ code, expected, hint });
}

function configurationError(expected: string, hint: string): RhiErrorType {
  return error('rhi-descriptor-invalid', expected, hint);
}

function validateDevice(device: unknown): Result<RhiDevice, RhiErrorType> {
  try {
    if (
      device !== null &&
      typeof device === 'object' &&
      'caps' in device &&
      (device as RhiDevice).caps?.backendKind === 'null' &&
      typeof (device as RhiDevice).createTexture === 'function' &&
      typeof (device as RhiDevice).destroyTexture === 'function'
    ) {
      return ok(device as RhiDevice);
    }
  } catch {
    // A throwing wrapper is not a usable configured RhiDevice.
  }

  return err(
    error(
      'rhi-not-available',
      'CanvasConfiguration.device must be a live RhiNull device',
      'configure the context with the RhiDevice returned by RhiNullAdapter.requestDevice()',
    ),
  );
}

function readCanvasExtent(surface: CanvasSurface | undefined): Result<CanvasExtent, RhiErrorType> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    width = surface?.width;
    height = surface?.height;
  } catch {
    return err(
      configurationError(
        'canvas width and height must be positive integers',
        'the configured canvas extent could not be read',
      ),
    );
  }

  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return err(
      configurationError(
        'canvas width and height must be positive integers',
        `got width=${String(width)}, height=${String(height)}`,
      ),
    );
  }

  return ok({ width, height });
}

function copyConfiguration(configuration: CanvasConfiguration): CanvasConfiguration {
  const copy: CanvasConfiguration = { ...configuration };
  if (configuration.viewFormats !== undefined) {
    copy.viewFormats = [...configuration.viewFormats];
  }
  if (configuration.toneMapping !== undefined) {
    copy.toneMapping = { ...configuration.toneMapping };
  }
  return copy;
}

function readViewFormats(value: unknown): Result<GPUTextureFormat[], RhiErrorType> {
  if (value === undefined) return ok([]);
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'string') ||
    typeof (value as Iterable<unknown>)[Symbol.iterator] !== 'function'
  ) {
    return err(
      configurationError(
        'viewFormats must be an iterable of texture format strings',
        'the canvas configuration contains an invalid viewFormats value',
      ),
    );
  }

  try {
    const viewFormats = Array.from(value as Iterable<unknown>);
    if (viewFormats.some((format) => typeof format !== 'string')) {
      return err(
        configurationError(
          'viewFormats must be an iterable of texture format strings',
          'the canvas configuration contains a non-string view format',
        ),
      );
    }
    return ok(viewFormats as GPUTextureFormat[]);
  } catch (cause) {
    return err(
      configurationError(
        'viewFormats must be an iterable of texture format strings',
        `reading viewFormats raised: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }
}

function isCompatibleViewFormat(format: string, viewFormat: string): boolean {
  return (
    format === viewFormat ||
    (format === 'bgra8unorm' && viewFormat === 'bgra8unorm-srgb') ||
    (format === 'rgba8unorm' && viewFormat === 'rgba8unorm-srgb')
  );
}

function configurationFor(desc: CanvasConfiguration): Result<CanvasConfiguration, RhiErrorType> {
  if (desc === null || typeof desc !== 'object') {
    return err(
      configurationError('a CanvasConfiguration object', 'configure received no descriptor'),
    );
  }

  const device = validateDevice(desc.device);
  if (!device.ok) return device;

  const format = desc.format;
  if (typeof format !== 'string' || !SUPPORTED_CONTEXT_FORMATS.has(format)) {
    return err(
      error(
        'webgpu-runtime-error',
        'one of bgra8unorm/rgba8unorm/rgba16float',
        `got format='${String(format)}'; use the non-srgb canvas format and put an srgb view format in viewFormats`,
      ),
    );
  }

  const usage = desc.usage ?? DEFAULT_USAGE;
  if (
    !Number.isSafeInteger(usage) ||
    usage <= 0 ||
    usage > VALID_TEXTURE_USAGE ||
    (usage & ~VALID_TEXTURE_USAGE) !== 0
  ) {
    return err(
      configurationError(
        'usage must contain one or more supported GPUTextureUsage flags',
        `got usage=${String(usage)}`,
      ),
    );
  }

  const viewFormats = readViewFormats(desc.viewFormats);
  if (!viewFormats.ok) return viewFormats;
  if (viewFormats.value.some((viewFormat) => !isCompatibleViewFormat(format, viewFormat))) {
    return err(
      configurationError(
        'viewFormats must be compatible with the configured canvas format',
        `format='${format}', viewFormats=${viewFormats.value.join(',')}`,
      ),
    );
  }

  if (
    (usage & TRANSIENT_ATTACHMENT) !== 0 &&
    (usage !== (RENDER_ATTACHMENT | TRANSIENT_ATTACHMENT) || viewFormats.value.length !== 0)
  ) {
    return err(
      configurationError(
        'TRANSIENT_ATTACHMENT requires RENDER_ATTACHMENT and an empty viewFormats list',
        `got usage=0x${usage.toString(16)}, viewFormats=${viewFormats.value.length}`,
      ),
    );
  }

  const colorSpace = desc.colorSpace ?? 'srgb';
  if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') {
    return err(
      configurationError(
        "colorSpace must be 'srgb' or 'display-p3'",
        `got colorSpace='${String(colorSpace)}'`,
      ),
    );
  }

  const alphaMode = desc.alphaMode ?? 'opaque';
  if (alphaMode !== 'opaque' && alphaMode !== 'premultiplied') {
    return err(
      configurationError(
        "alphaMode must be 'opaque' or 'premultiplied'",
        `got alphaMode='${String(alphaMode)}'`,
      ),
    );
  }

  const toneMapping = desc.toneMapping;
  if (
    toneMapping !== undefined &&
    (toneMapping === null ||
      typeof toneMapping !== 'object' ||
      (toneMapping.mode !== undefined &&
        toneMapping.mode !== 'standard' &&
        toneMapping.mode !== 'extended'))
  ) {
    return err(
      configurationError(
        "toneMapping.mode must be 'standard' or 'extended'",
        'the canvas configuration contains an invalid toneMapping value',
      ),
    );
  }

  return ok({
    device: device.value,
    format,
    usage,
    viewFormats: viewFormats.value,
    colorSpace,
    alphaMode,
    ...(toneMapping === undefined ? {} : { toneMapping: { ...toneMapping } }),
  });
}

function currentTextureDescriptor(
  configuration: CanvasConfiguration,
  extent: CanvasExtent,
): TextureDescriptor {
  return {
    size: { width: extent.width, height: extent.height, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: configuration.format,
    usage: configuration.usage,
    viewFormats: configuration.viewFormats,
  };
}

/**
 * Structural canvas context backed by real RhiNullDevice texture handles.
 * Acquisitions share a texture until actual related submission or configuration
 * / extent replacement. Submitted textures retire at their exact completion.
 * Null command membership is structural evidence, not browser presentation.
 */
export class RhiNullCanvasContext implements RhiCanvasContext {
  private configuration: CanvasConfiguration | undefined;
  private currentTexture: CurrentTexture | undefined;
  // Only failed retirements are retained here for recovery. Live resource and
  // command membership remain solely in the device's Bookkeeper rows.
  private readonly failedRetirements = new Set<CurrentTexture>();

  constructor(private readonly surface: CanvasSurface | undefined) {}

  configure(desc: CanvasConfiguration): Result<void, RhiErrorType> {
    const validated = configurationFor(desc);
    if (!validated.ok) return validated;

    const extent = readCanvasExtent(this.surface);
    if (!extent.ok) return extent;

    const recovered = this.retryFailedRetirements();
    if (!recovered.ok) return recovered;
    const released = this.releaseCurrentTexture();
    if (!released.ok) return released;

    this.configuration = validated.value;
    return ok(undefined);
  }

  unconfigure(): void {
    const recovered = this.retryFailedRetirements();
    if (!recovered.ok) throw recovered.error;
    const released = this.releaseCurrentTexture();
    if (!released.ok) throw released.error;
    this.configuration = undefined;
  }

  /** Return a defensive copy of the last accepted configuration, or undefined after unconfigure. */
  getConfiguration(): CanvasConfiguration | undefined {
    return this.configuration === undefined ? undefined : copyConfiguration(this.configuration);
  }

  getCurrentTexture(): Result<Texture, RhiErrorType> {
    for (const failed of this.failedRetirements) {
      if (failed.failure !== undefined) return err(failed.failure);
    }
    const configuration = this.configuration;
    if (configuration === undefined) {
      return err(
        error(
          'webgpu-runtime-error',
          'GPUCanvasContext.getCurrentTexture to succeed (context configured)',
          'configure the context before requesting its current texture',
        ),
      );
    }

    const extent = readCanvasExtent(this.surface);
    if (!extent.ok) {
      const released = this.releaseCurrentTexture();
      return released.ok ? extent : released;
    }

    const current = this.currentTexture;
    if (
      current !== undefined &&
      current.extent.width === extent.value.width &&
      current.extent.height === extent.value.height
    ) {
      const record = readRecord(current.texture);
      if (record?.destroyed === false) return ok(current.texture);
    }
    const released = this.releaseCurrentTexture();
    if (!released.ok) return released;

    let created: Result<Texture, RhiErrorType>;
    try {
      created = configuration.device.createTexture(
        currentTextureDescriptor(configuration, extent.value),
      );
    } catch (cause) {
      return err(cleanupError(cause, 'create a live canvas texture'));
    }
    if (!created.ok) return created;

    const record = readRecord(created.value);
    if (record === undefined || record.kind !== 'Texture' || record.destroyed) {
      return err(
        error(
          'rhi-not-available',
          'a real live Null texture returned by the configured owner',
          'repair the configured device; untracked textures cannot observe command submission',
        ),
      );
    }
    const acquired: CurrentTexture = {
      device: configuration.device,
      texture: created.value,
      extent: extent.value,
    };
    record.onSubmitted = (completion) => {
      acquired.completion = completion;
      if (this.currentTexture === acquired) this.currentTexture = undefined;
      // Capture this exact resource, never read the successor acquisition here.
      void completion.then(
        () => {
          if (acquired.completion !== completion) return;
          acquired.completion = undefined;
          const retired = this.retire(acquired);
          if (!retired.ok) this.failedRetirements.add(acquired);
        },
        (cause: unknown) => {
          if (acquired.completion !== completion) return;
          acquired.failure = cleanupError(
            cause,
            'complete submitted canvas work before retirement',
          );
          this.failedRetirements.add(acquired);
        },
      );
    };
    this.currentTexture = acquired;
    return created;
  }

  private releaseCurrentTexture(): Result<void, RhiErrorType> {
    const current = this.currentTexture;
    if (current === undefined) return ok(undefined);

    const retired = this.retire(current);
    if (!retired.ok) return retired;
    if (this.currentTexture === current) this.currentTexture = undefined;
    return ok(undefined);
  }

  private retire(current: CurrentTexture): Result<void, RhiErrorType> {
    if (current.completion !== undefined)
      return current.failure === undefined ? ok(undefined) : err(current.failure);
    const record = readRecord(current.texture);
    if (record?.destroyed === true) {
      record.onSubmitted = undefined;
      return ok(undefined);
    }
    let destroyed: Result<void, RhiErrorType>;
    try {
      destroyed = current.device.destroyTexture(current.texture);
    } catch (cause) {
      current.failure = cleanupError(cause, 'release its previous canvas texture');
      return err(current.failure);
    }

    if (!destroyed.ok) {
      current.failure = destroyed.error;
      return destroyed;
    }
    if (record !== undefined) record.onSubmitted = undefined;
    current.failure = undefined;
    return ok(undefined);
  }

  private retryFailedRetirements(): Result<void, RhiErrorType> {
    for (const current of this.failedRetirements) {
      const retired = this.retire(current);
      if (!retired.ok) return retired;
      this.failedRetirements.delete(current);
    }
    return ok(undefined);
  }
}

/** Acquire a structural canvas context while retaining the supplied surface extent. */
export function acquireCanvasContext(
  canvas?: RhiCanvasTarget | null | undefined,
): Result<RhiCanvasContext, RhiErrorType> {
  return ok(new RhiNullCanvasContext(canvas ?? undefined));
}
