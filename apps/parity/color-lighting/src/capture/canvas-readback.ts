/**
 * Read the compositor-visible RGBA8 canvas through one browser-owned path.
 *
 * Native WebGPU canvas snapshots can expose the current swap-chain image to
 * `createImageBitmap(canvas)` before Chromium has consumed it, yielding an
 * all-zero bitmap even though the renderer's attachment is populated. A
 * lossless PNG Blob is the browser's presentation serialization boundary; it
 * lets the compositor finish the same frame without redrawing or retrying on
 * the observed pixel result. The Blob path remains the single authoritative
 * readback route for both ForgeaX and Three captures.
 */

export type CanvasReadbackErrorCode =
  | 'canvas-blob-null'
  | 'canvas-compositor-length'
  | 'canvas-2d-context-unavailable'
  | 'canvas-image-bitmap-failed';

export class CanvasReadbackError extends Error {
  readonly code: CanvasReadbackErrorCode;
  readonly expected: string;
  readonly hint: string;

  constructor(code: CanvasReadbackErrorCode, expected: string, hint: string, detail?: string) {
    super(`${code}: ${expected} (${hint})${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'CanvasReadbackError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
  }
}

type WebkitCanvasReadback = (request: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}) => Promise<readonly number[]>;

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(
          new CanvasReadbackError(
            'canvas-blob-null',
            'canvas.toBlob must return a PNG Blob',
            'keep the final-display capture fail-closed and inspect canvas security or lifecycle state',
          ),
        );
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

/** Read the final-display RGBA8 pixels without a second capture authority. */
export async function readCanvasPixels(
  canvas: HTMLCanvasElement,
  useWebkitCompositor = false,
): Promise<Uint8Array> {
  if (useWebkitCompositor) {
    const hook = (globalThis as unknown as { __forgeaxWebkitCanvasReadback?: WebkitCanvasReadback })
      .__forgeaxWebkitCanvasReadback;
    if (hook !== undefined) {
      const rect = canvas.getBoundingClientRect();
      const pixels = await hook({
        x: rect.x,
        y: rect.y,
        width: canvas.width,
        height: canvas.height,
      });
      const expectedLength = canvas.width * canvas.height * 4;
      if (pixels.length !== expectedLength) {
        throw new CanvasReadbackError(
          'canvas-compositor-length',
          `WebKit compositor readback must return ${expectedLength} bytes`,
          'inspect the compositor bridge response before publishing final-display evidence',
          `received ${pixels.length} bytes`,
        );
      }
      return Uint8Array.from(pixels);
    }
  }

  const blob = await canvasBlob(canvas);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CanvasReadbackError(
      'canvas-image-bitmap-failed',
      'PNG Blob must decode as an ImageBitmap',
      'inspect the browser image decoder and keep the final-display capture failed',
      detail,
    );
  }
  try {
    const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    const context = offscreen.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      throw new CanvasReadbackError(
        'canvas-2d-context-unavailable',
        'an OffscreenCanvas 2D context for RGBA8 readback',
        'enable the browser OffscreenCanvas 2D surface before capturing final-display evidence',
      );
    }
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
  } finally {
    bitmap.close();
  }
}
