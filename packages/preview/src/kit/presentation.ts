export type PreviewSubject =
  | { readonly kind: 'material'; readonly guid: string; readonly digest: string }
  | { readonly kind: 'mesh'; readonly guid: string; readonly digest: string }
  | { readonly kind: 'vfx'; readonly guid: string; readonly digest: string }
  | { readonly kind: 'texture'; readonly guid: string; readonly digest: string };

export type PreviewSubjectKind = PreviewSubject['kind'];

export type PreviewPresentation =
  | {
      readonly kind: 'lit-asset';
      readonly geometry: 'handle-sphere' | 'asset-mesh';
      readonly skylight: 'engine-canonical';
      readonly directionalLight: 'engine-canonical';
      readonly skybox: 'engine-canonical';
    }
  | {
      readonly kind: 'texture-unlit';
      readonly geometry: 'aspect-quad';
      readonly checkerboard: 'linear-alpha';
    };

export const MATERIAL_PRESENTATION: PreviewPresentation = {
  kind: 'lit-asset',
  geometry: 'handle-sphere',
  skylight: 'engine-canonical',
  directionalLight: 'engine-canonical',
  skybox: 'engine-canonical',
};

export const MESH_PRESENTATION: PreviewPresentation = {
  kind: 'lit-asset',
  geometry: 'asset-mesh',
  skylight: 'engine-canonical',
  directionalLight: 'engine-canonical',
  skybox: 'engine-canonical',
};

export const VFX_PRESENTATION: PreviewPresentation = MATERIAL_PRESENTATION;

export const TEXTURE_PRESENTATION: PreviewPresentation = {
  kind: 'texture-unlit',
  geometry: 'aspect-quad',
  checkerboard: 'linear-alpha',
};
