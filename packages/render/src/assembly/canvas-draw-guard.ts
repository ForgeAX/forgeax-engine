import { RhiError } from '@forgeax/engine-rhi';

export function rejectZeroCanvasSize(width: number, height: number): RhiError | undefined {
  return width > 0 && height > 0
    ? undefined
    : new RhiError({
        code: 'rhi-not-available',
        expected: 'canvas drawing buffer has positive width and height before drawing',
        hint: 'restore a positive canvas width and height before retrying renderer.draw',
      });
}
