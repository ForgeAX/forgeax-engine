export interface CanvasCaptureError {
  readonly code: 'canvas-capture-failed';
  readonly hint: string;
}

export type CanvasCaptureResult =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly error: CanvasCaptureError };

export async function captureCanvasPixels(canvas: HTMLCanvasElement): Promise<CanvasCaptureResult> {
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value === null) reject(new Error('canvas.toBlob returned null'));
        else resolve(value);
      }, 'image/png');
    });
    const bitmap = await createImageBitmap(blob);
    const surface = document.createElement('canvas');
    surface.width = canvas.width;
    surface.height = canvas.height;
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('2d capture context unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      ok: true,
      value: new Uint8Array(context.getImageData(0, 0, surface.width, surface.height).data),
    };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: 'canvas-capture-failed',
        hint: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}
