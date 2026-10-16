import type { PreviewPresentation, PreviewSubjectKind } from './presentation.js';

export interface CanonicalPreviewRecipe {
  readonly schemaVersion: '1.0.0';
  readonly rig:
    | Extract<PreviewPresentation, { readonly kind: 'lit-asset' }>['geometry']
    | 'asset-quad';
  readonly environment: 'engine-canonical' | 'black';
  readonly skybox: 'engine-canonical' | 'none';
  readonly skylight: 'engine-canonical' | 'none';
  readonly directionalLight: 'engine-canonical' | 'none';
  readonly stage: 'neutral-material-checker-unlit' | 'texture-unlit-black';
  readonly camera: 'bounds-derived' | 'texture-orthographic';
  readonly recipeDigest: string;
}

export function createCanonicalPreviewRecipe(kind: PreviewSubjectKind): CanonicalPreviewRecipe {
  const texture = kind === 'texture';
  return {
    schemaVersion: '1.0.0',
    rig: kind === 'mesh' ? 'asset-mesh' : texture ? 'asset-quad' : 'handle-sphere',
    environment: texture ? 'black' : 'engine-canonical',
    skybox: texture ? 'none' : 'engine-canonical',
    skylight: texture ? 'none' : 'engine-canonical',
    directionalLight: texture ? 'none' : 'engine-canonical',
    stage: texture ? 'texture-unlit-black' : 'neutral-material-checker-unlit',
    camera: texture ? 'texture-orthographic' : 'bounds-derived',
    recipeDigest: `canonical:${kind}:${texture ? 'texture-orthographic' : 'bounds-derived'}`,
  };
}

export function canonicalPresentation(kind: PreviewSubjectKind): PreviewPresentation {
  if (kind === 'texture') {
    return {
      kind: 'texture-unlit',
      geometry: 'aspect-quad',
      checkerboard: 'linear-alpha',
    };
  }
  return {
    kind: 'lit-asset',
    geometry: kind === 'mesh' ? 'asset-mesh' : 'handle-sphere',
    skylight: 'engine-canonical',
    directionalLight: 'engine-canonical',
    skybox: 'engine-canonical',
  };
}
