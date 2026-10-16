/** Fixed world-space sampling range, independent of cameras and GI settings. */
export interface RenderFeatureSceneSdfDescriptor {
  readonly origin: readonly [number, number, number];
  readonly dimensions: readonly [number, number, number];
  readonly spacing: number;
  readonly maxDistance: number;
  readonly maxInstances: number;
  readonly maxFieldBytes: number;
}
