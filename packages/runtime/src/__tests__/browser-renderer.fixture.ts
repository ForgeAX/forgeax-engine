import type { Renderer } from '@forgeax/engine-render';
import { afterAll } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

/** Reuse only assembly for serial pixel cases that do not test cold start or loss. */
export function browserRendererFixture(size: number) {
  let prepared:
    | Promise<{
        canvas: HTMLCanvasElement;
        renderer: Renderer;
      }>
    | undefined;
  afterAll(async () => {
    if (prepared === undefined) return;
    const { canvas, renderer } = await prepared;
    try {
      const disposed = await renderer.dispose();
      if (!disposed.ok) throw disposed.error;
    } finally {
      canvas.remove();
    }
  });
  return () =>
    (prepared ??= (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      document.body.append(canvas);
      const result = await constructRuntimeRendererHost(canvas);
      if (!result.ok) {
        canvas.remove();
        throw result.error;
      }
      return { canvas, renderer: result.value.renderer };
    })());
}
