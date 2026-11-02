import type { RenderableSnapshot } from '../render-system-extract';

/** Retained identity does not imply current raster demand. */
export function hasRasterDemand(
  source: Pick<RenderableSnapshot, 'authorVisible' | 'instances' | 'spriteInstances'>,
): boolean {
  return (
    source.authorVisible !== false &&
    source.instances?.instanceCount !== 0 &&
    source.spriteInstances?.instanceCount !== 0
  );
}
