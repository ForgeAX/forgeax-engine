import type { TextureFormat } from '@forgeax/engine-rhi';
import type { RenderTextureSourceToken } from '@forgeax/engine-types';

export interface RenderFeatureTextureReference {
  readonly kind: 'feature-texture';
  readonly featureIdentity: string;
  readonly name: string;
  readonly viewIdentity: string;
  readonly format: TextureFormat;
  readonly sampleCount: 1;
}

export interface RenderFeatureTextureSource extends RenderTextureSourceToken {
  readonly source: 'feature';
}

export function isRenderFeatureTextureReference(
  value: unknown,
): value is RenderFeatureTextureReference {
  if (value === null || typeof value !== 'object') return false;
  const reference = value as Partial<RenderFeatureTextureReference>;
  return (
    reference.kind === 'feature-texture' &&
    typeof reference.featureIdentity === 'string' &&
    reference.featureIdentity.length > 0 &&
    typeof reference.name === 'string' &&
    reference.name.length > 0 &&
    typeof reference.viewIdentity === 'string' &&
    reference.viewIdentity.length > 0 &&
    typeof reference.format === 'string' &&
    reference.sampleCount === 1
  );
}

/** A copyable named graph read. The active graph owns its physical resource and generation. */
export function renderFeatureTextureSource(targetName: string): RenderFeatureTextureSource {
  if (!/^[a-z][a-z0-9.-]{0,127}$/.test(targetName))
    throw new TypeError('A feature texture source requires a valid declared graph target name');
  return Object.freeze({
    kind: 'render-texture-source',
    source: 'feature',
    owner: targetName,
    id: 1,
  });
}
