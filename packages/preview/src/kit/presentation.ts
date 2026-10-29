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
