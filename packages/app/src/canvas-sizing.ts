import type { Renderer } from '@forgeax/engine-render';

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

/** Synchronize layout or explicit physical pixels within the same size budgets. */
export function syncCanvasDrawingBuffer(
  canvas: CanvasSurface,
  requestedSize?: { readonly width: number; readonly height: number },
): void {
  const measured = requestedSize === undefined ? measurement(canvas) : undefined;
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
): { readonly width: number; readonly height: number } {
  const measured = measurement(canvas, maxCanvasPixelRatio);
  return measured === undefined
    ? retainedSize(canvas)
    : { width: measured.width, height: measured.height };
}

export function refreshCanvasDeviceLimit(
  canvas: CanvasSurface,
  renderer: Pick<Renderer, 'inspect'>,
): void {
  let limit: number | undefined;
  try {
    limit = renderer.inspect().limits?.maxTextureDimension2D;
  } catch {
    // Optional inspection cannot bypass the conservative startup budget.
  }
  deviceLimits.set(
    canvas,
    typeof limit === 'number' && Number.isFinite(limit) && limit >= 1
      ? Math.floor(limit)
      : STARTUP_DIMENSION_LIMIT,
  );
  syncCanvasDrawingBuffer(canvas);
}

/** Cache limits per renderer generation, releasing the subscription with its host. */
export function observeCanvasDeviceLimit(
  canvas: CanvasSurface,
  renderer: Pick<Renderer, 'inspect' | 'subscribe'>,
): () => void {
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind !== 'state-changed') return;
    if (event.current === 'alive') refreshCanvasDeviceLimit(canvas, renderer);
    else if (event.current === 'device-lost' || event.current === 'recovering') {
      deviceLimits.set(
        canvas,
        Math.min(deviceLimits.get(canvas) ?? STARTUP_DIMENSION_LIMIT, STARTUP_DIMENSION_LIMIT),
      );
      syncCanvasDrawingBuffer(canvas);
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

function measurement(canvas: CanvasSurface, maxCanvasPixelRatio?: number) {
  // Layout reads can synchronize pending style changes. Reuse one current snapshot
  // within this measurement; the next frame still observes resize and visibility.
  const { clientWidth, clientHeight } = canvas;
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
  const deviceRatio =
    Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0
      ? Math.max(1, globalThis.devicePixelRatio)
      : 1;
  const dpr = intrinsic
    ? 1
    : maxCanvasPixelRatio === undefined ||
        !Number.isFinite(maxCanvasPixelRatio) ||
        maxCanvasPixelRatio <= 0
      ? deviceRatio
      : Math.min(deviceRatio, maxCanvasPixelRatio);
  return { cssWidth, cssHeight, intrinsic, ...boundedSize(canvas, cssWidth, cssHeight, dpr) };
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
