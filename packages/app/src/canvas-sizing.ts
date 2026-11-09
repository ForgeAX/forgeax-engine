import { type Renderer, renderAblation } from '@forgeax/engine-render';

type CanvasSurface = Pick<
  HTMLCanvasElement,
  'clientWidth' | 'clientHeight' | 'width' | 'height'
> & {
  readonly style?: Pick<CSSStyleDeclaration, 'width' | 'height'>;
};

// WebGPU guarantees this conservative size before a device is available.
const STARTUP_DIMENSION_LIMIT = 2048;
const deviceLimits = new WeakMap<object, number>();
const measurements = new WeakMap<
  object,
  {
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly intrinsic: boolean;
    readonly drawingWidth: number;
    readonly drawingHeight: number;
  }
>();

export function resetCanvasDeviceLimit(canvas: CanvasSurface): void {
  deviceLimits.delete(canvas);
}

/**
 * Record a device texture bound reported by another realm (the Render Worker).
 * Invalid values keep the conservative startup budget.
 */
export function setCanvasDeviceLimit(canvas: CanvasSurface, maxTextureDimension2D: number): void {
  deviceLimits.set(canvas, deviceLimit(maxTextureDimension2D));
}

/** Synchronize layout or explicit physical pixels within the same size budgets. */
export function syncCanvasDrawingBuffer(
  canvas: CanvasSurface,
  requestedSize?: { readonly width: number; readonly height: number },
  pixelRatio?: number,
): void {
  const measured = requestedSize === undefined ? measurement(canvas, pixelRatio) : undefined;
  const size =
    requestedSize !== undefined && hasPositiveExtent(requestedSize.width, requestedSize.height)
      ? boundedSize(canvas, requestedSize.width, requestedSize.height, 1)
      : (measured ?? retainedSize(canvas));
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  if (measured !== undefined) {
    measurements.set(canvas, {
      cssWidth: measured.cssWidth,
      cssHeight: measured.cssHeight,
      intrinsic: measured.intrinsic,
      drawingWidth: size.width,
      drawingHeight: size.height,
    });
  }
}

/** Measure the same bounded size without allocating or changing the canvas. */
export function measureCanvasDrawingBuffer(
  canvas: CanvasSurface,
  maxCanvasPixelRatio?: number,
  display?: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  const pixelRatio =
    typeof maxCanvasPixelRatio === 'number' &&
    Number.isFinite(maxCanvasPixelRatio) &&
    maxCanvasPixelRatio > 0
      ? Math.min(devicePixelRatio(), maxCanvasPixelRatio)
      : 1;
  return measureCanvasDrawingBufferAtRatio(canvas, pixelRatio, display);
}

/** Measure using an exact explicit scale for the browser App host. */
export function measureCanvasDrawingBufferAtRatio(
  canvas: CanvasSurface,
  pixelRatio: number | undefined,
  display?: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  const measured = measurement(canvas, pixelRatio, display);
  return measured === undefined
    ? retainedSize(canvas)
    : { width: measured.width, height: measured.height };
}

function devicePixelRatio(): number {
  return Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0
    ? Math.max(1, globalThis.devicePixelRatio)
    : 1;
}

export function refreshCanvasDeviceLimit(
  canvas: CanvasSurface,
  renderer: Pick<Renderer, 'inspect'>,
  pixelRatio?: number,
): void {
  let limit: number | undefined;
  try {
    limit = renderer.inspect({ fields: ['limits'] }).limits?.maxTextureDimension2D;
  } catch {
    // Optional inspection cannot bypass the conservative startup budget.
  }
  deviceLimits.set(canvas, deviceLimit(limit));
  syncCanvasDrawingBuffer(canvas, undefined, pixelRatio);
}

function deviceLimit(limit: unknown): number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 1
    ? Math.floor(limit)
    : STARTUP_DIMENSION_LIMIT;
}

/** Cache limits per renderer generation, releasing the subscription with its host. */
export function observeCanvasDeviceLimit(
  canvas: CanvasSurface,
  renderer: Pick<Renderer, 'inspect' | 'subscribe'>,
  pixelRatio?: number,
): () => void {
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind !== 'state-changed') return;
    if (event.current === 'alive') refreshCanvasDeviceLimit(canvas, renderer, pixelRatio);
    else if (event.current === 'device-lost' || event.current === 'recovering') {
      deviceLimits.set(
        canvas,
        Math.min(deviceLimits.get(canvas) ?? STARTUP_DIMENSION_LIMIT, STARTUP_DIMENSION_LIMIT),
      );
      syncCanvasDrawingBuffer(canvas, undefined, pixelRatio);
    }
  });
  return () => {
    try {
      unsubscribe();
    } finally {
      resetCanvasDeviceLimit(canvas);
    }
  };
}

function retainedSize(canvas: CanvasSurface): { width: number; height: number } {
  const { width, height } = canvas;
  const limit = deviceLimits.get(canvas) ?? STARTUP_DIMENSION_LIMIT;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    (width <= limit && height <= limit)
  )
    return { width, height };
  const ratio = limit / Math.max(width, height);
  return {
    width: boundedPixel(width, ratio, limit, true),
    height: boundedPixel(height, ratio, limit, true),
  };
}

function boundedPixel(value: number, ratio: number, limit: number, limited: boolean): number {
  return Math.max(
    1,
    Math.min(limit, limited ? Math.floor(value * ratio + 1e-9) : Math.round(value * ratio)),
  );
}

function hasPositiveExtent(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function measurement(
  canvas: CanvasSurface,
  pixelRatio?: number,
  display?: { readonly width: number; readonly height: number },
) {
  // A browser host can consume its existing native display notification instead
  // of synchronizing unrelated pending layout on every Worker admission.
  const clientWidth = display === undefined ? canvas.clientWidth : display.width;
  const clientHeight = display === undefined ? canvas.clientHeight : display.height;
  if (!hasPositiveExtent(clientWidth, clientHeight)) return undefined;
  const previous = measurements.get(canvas);
  const bufferMirrorsLayout =
    previous !== undefined &&
    canvas.width === previous.drawingWidth &&
    canvas.height === previous.drawingHeight &&
    clientWidth === previous.drawingWidth &&
    clientHeight === previous.drawingHeight;
  const cssWidth = bufferMirrorsLayout ? previous.cssWidth : clientWidth;
  const cssHeight = bufferMirrorsLayout ? previous.cssHeight : clientHeight;
  const explicitCss = (canvas.style?.width ?? '') !== '' || (canvas.style?.height ?? '') !== '';
  // A layout that diverges from the buffer establishes stylesheet sizing.
  const intrinsic =
    !explicitCss &&
    (previous?.intrinsic ?? true) &&
    clientWidth === canvas.width &&
    clientHeight === canvas.height;
  const ratio = drawingBufferPixelRatio(pixelRatio, intrinsic);
  // Diagnostic render-scale ablation scales the layout-derived buffer only.
  const scale = renderAblation()?.renderScale ?? 1;
  return {
    cssWidth,
    cssHeight,
    intrinsic,
    ...boundedSize(canvas, cssWidth, cssHeight, ratio * scale),
  };
}

function drawingBufferPixelRatio(pixelRatio: number | undefined, intrinsic: boolean): number {
  if (intrinsic) return 1;
  return typeof pixelRatio === 'number' && Number.isFinite(pixelRatio) && pixelRatio > 0
    ? pixelRatio
    : 1;
}

function boundedSize(canvas: CanvasSurface, width: number, height: number, pixelRatio: number) {
  const limit = deviceLimits.get(canvas) ?? STARTUP_DIMENSION_LIMIT;
  const attributes = canvas as CanvasSurface & { getAttribute?: (name: string) => string | null };
  const widthBudget = Number(attributes.getAttribute?.('data-forgeax-render-width-limit'));
  const heightBudget = Number(attributes.getAttribute?.('data-forgeax-render-height-limit'));
  const validBudget =
    Number.isFinite(widthBudget) &&
    widthBudget >= 1 &&
    Number.isFinite(heightBudget) &&
    heightBudget >= 1;
  const landscape = width >= height;
  const maxRatio = Math.min(
    limit / Math.max(width, height),
    validBudget
      ? Math.min(
          (landscape ? widthBudget : heightBudget) / width,
          (landscape ? heightBudget : widthBudget) / height,
        )
      : Infinity,
  );
  const ratio = Math.min(pixelRatio, maxRatio);
  return {
    width: boundedPixel(width, ratio, limit, pixelRatio > maxRatio),
    height: boundedPixel(height, ratio, limit, pixelRatio > maxRatio),
  };
}
