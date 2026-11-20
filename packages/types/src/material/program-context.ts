/** Domain-owned inputs used to select a raster material program. */
export interface MaterialCookRasterContext {
  readonly backend: 'webgpu' | 'webgl2' | 'wgpu-native';
  readonly capability:
    | 'storage-buffer-minimum'
    | 'storage-buffer-projector'
    | 'storage-buffer'
    | 'storage-buffer-atmosphere'
    | 'uniform-fallback';
  readonly pipeline: 'forward' | 'deferred';
  readonly visibleSurface?: true;
  readonly viewClipping?: true;
  readonly lodCoverage?: true;
  readonly geometry: 'mesh' | 'skinned' | 'sprite' | 'sprite-instances' | 'terrain';
  readonly pass: 'forward' | 'shadow' | 'depth';
  readonly profile: 'forgeax-material-wgsl-v1';
  readonly toolchain: 'naga-oil';
  readonly instrumentation: 'none' | 'validation';
}

/** The authored Surface evaluated at a ray hit or Card capture. */
export interface MaterialCookRayContext {
  readonly backend: 'webgpu' | 'wgpu-native';
  readonly capability: 'storage-buffer';
  readonly pipeline: 'ray';
  readonly geometry: 'mesh';
  readonly pass: 'ray-hit' | 'card-capture';
  readonly profile: 'forgeax-material-ray-v1';
  readonly toolchain: 'naga-oil';
  readonly instrumentation: 'none';
}

export type MaterialCookProgramContext = MaterialCookRasterContext | MaterialCookRayContext;

/** Module identities and provenance retained for deferred shader selection. */
export interface MaterialTemplateSources {
  readonly engine: Readonly<Record<string, string>>;
  readonly project: Readonly<Record<string, string>>;
}
