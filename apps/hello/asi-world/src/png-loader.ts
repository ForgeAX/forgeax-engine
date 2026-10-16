// PNG → RGBA8 bytes via OffscreenCanvas / HTMLCanvasElement, so we can hand
// the bytes straight to `world.allocSharedRef('TextureAsset', { kind: 'texture',
// data, ... })` without going through the build-time vite-plugin-pack importer
// (the demo stays self-contained).

export interface DecodedTexture {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export async function fetchPngAsRgba(url: string): Promise<DecodedTexture> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`[asi-world] fetch ${url} -> HTTP ${resp.status}`);
  }
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
  const w = bitmap.width;
  const h = bitmap.height;
  const ctx = getCanvasCtx(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imgData = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, rgba: new Uint8Array(imgData.data.buffer) };
}

function getCanvasCtx(w: number, h: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d');
    if (!ctx) throw new Error('[asi-world] OffscreenCanvas 2d context unavailable');
    return ctx as OffscreenCanvasRenderingContext2D;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('[asi-world] canvas 2d context unavailable');
  return ctx;
}
