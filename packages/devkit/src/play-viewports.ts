/** One play viewport, CSS pixels. */
export interface PlayViewport {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_PLAY_VIEWPORTS = '1280x720,1280x600';
const MAX_VIEWPORTS = 4;
const MIN_SIDE = 200;
const MAX_SIDE = 4096;

export function viewportName(viewport: PlayViewport): string {
  return `${viewport.width}x${viewport.height}`;
}

/** Parses `WxH[,WxH...]`; the first viewport runs the script, the rest are checked after it. */
export function parsePlayViewports(
  value: string,
): { ok: true; value: readonly PlayViewport[] } | { ok: false; message: string } {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length > MAX_VIEWPORTS)
    return { ok: false, message: `at most ${MAX_VIEWPORTS} viewports; got ${parts.length}` };
  const viewports: PlayViewport[] = [];
  for (const part of parts) {
    const match = /^(\d+)x(\d+)$/.exec(part);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (
      match === null ||
      [width, height].some((side) => side < MIN_SIDE || side > MAX_SIDE) ||
      viewports.some((seen) => seen.width === width && seen.height === height)
    )
      return {
        ok: false,
        message: `viewport ${JSON.stringify(part)} must be a distinct WxH with sides ${MIN_SIDE}-${MAX_SIDE}`,
      };
    viewports.push({ width, height });
  }
  return { ok: true, value: viewports };
}
