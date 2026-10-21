import type { RenderTextureSourceToken } from '@forgeax/engine-types';

/** Stable across structured cloning; native state stays with the producer. */
export function renderTextureSourceKey(source: RenderTextureSourceToken): string {
  return `${source.owner}:${source.id}`;
}

export function isRenderTextureSourceToken(value: unknown): value is RenderTextureSourceToken {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Partial<RenderTextureSourceToken>;
  return (
    source.kind === 'render-texture-source' &&
    typeof source.owner === 'string' &&
    source.owner.length > 0 &&
    Number.isSafeInteger(source.id) &&
    (source.id ?? 0) > 0 &&
    (source.source === 'target' || source.source === 'canvas' || source.source === 'external')
  );
}
