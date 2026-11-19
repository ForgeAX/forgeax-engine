import type { RenderTextureSourceToken } from '@forgeax/engine-types';
import { isRenderTextureSourceToken } from '../textures/source-token';

export interface RenderFeatureTextureSource extends RenderTextureSourceToken {
  readonly source: 'feature';
  readonly name: string;
}
/** Durable renderer-local name; the feature host resolves its current device
 * generation. No GPU handle or duplicated asset registry enters World data. */
export function createRenderFeatureTextureSource(
  featureIdentity: string,
  name: string,
): RenderFeatureTextureSource {
  if (!featureIdentity || !name)
    throw Error('Feature texture source needs an owner and resource name');
  return Object.freeze({
    kind: 'render-texture-source',
    source: 'feature',
    owner: featureIdentity,
    id: 1,
    name,
  });
}
export function isRenderFeatureTextureSource(value: unknown): value is RenderFeatureTextureSource {
  return (
    isRenderTextureSourceToken(value) &&
    value.source === 'feature' &&
    typeof value.name === 'string' &&
    value.name.length > 0
  );
}
