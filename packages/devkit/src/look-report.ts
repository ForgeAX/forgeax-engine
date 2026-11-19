/**
 * Frame facts for one composed game frame (`forgeax dev look`): its size and whether
 * it is one flat colour. Judging the picture is left to opening the PNG.
 */

export interface LookMetrics {
  readonly width: number;
  readonly height: number;
  /** One flat colour: nothing rendered, or a full-screen overlay. */
  readonly flat: boolean;
}

/** A frame whose luma standard deviation (0-255) is below this is one flat colour. */
export const FLAT_FRAME_CONTRAST = 2;

/** Summarize an RGBA8 frame; alpha is ignored because a composed screenshot is opaque. */
export function summarizeLook(rgba: Uint8Array, width: number, height: number): LookMetrics {
  let sum = 0;
  let squares = 0;
  const pixels = width * height;
  for (let offset = 0; offset < pixels * 4; offset += 4) {
    const luma =
      0.2126 * (rgba[offset] ?? 0) +
      0.7152 * (rgba[offset + 1] ?? 0) +
      0.0722 * (rgba[offset + 2] ?? 0);
    sum += luma;
    squares += luma * luma;
  }
  const count = Math.max(1, pixels);
  const mean = sum / count;
  const contrast = Math.sqrt(Math.max(0, squares / count - mean * mean));
  return { width, height, flat: contrast < FLAT_FRAME_CONTRAST };
}

/**
 * Findings that make the frame not the scene: a renderer error, else a flat frame.
 * Nothing is said about how the scene looks.
 */
export function lookFindings(
  metrics: LookMetrics,
  rendererError: { readonly code?: unknown } | null | undefined,
): readonly string[] {
  if (rendererError != null)
    return [
      `renderer error ${String(rendererError.code ?? 'unknown')}: the frame is not the scene; repair it first`,
    ];
  if (metrics.flat)
    return ['flat frame: one colour, so nothing rendered or an overlay covers the canvas'];
  return [];
}
