/** Ordered Landscape layer semantics; alpha layers composite after the weight group. */
export type TerrainLayer =
  | { readonly material: string; readonly blend: 'weight' | 'alpha' }
  | {
      readonly material: string;
      readonly blend: 'height';
      readonly height: string;
      readonly heightRange: readonly [number, number];
    };

/** Author input. Samples are metres, X-fast row-major on the local XZ plane. */
export interface TerrainSource {
  readonly columns: number;
  readonly rows: number;
  readonly spacing: number;
  readonly subsectionVertices: number;
  readonly heights: Float32Array;
  /** Sample-major, one linear weight per ordered layer. */
  readonly weights: Float32Array;
  readonly layers: readonly TerrainLayer[];
}

/** Cooked subsection. Edge values are derived from the same source coordinates. */
export interface TerrainSection {
  readonly x: number;
  readonly z: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly activeLayers: readonly number[];
  readonly heightTexture: string;
  readonly weightTexture: string;
  readonly material: string;
}

/** Cook policy; compact controls are derived data, never the author painting format. */
export type TerrainMaterialEncoding =
  | { readonly kind: 'weights' }
  | { readonly kind: 'ids'; readonly maxWeightError: number };

/** Controlled-size Landscape closure; per-view state never enters this asset. */
export interface TerrainAsset extends TerrainSource {
  readonly kind: 'terrain';
  readonly materialEncoding: TerrainMaterialEncoding;
  readonly heightRange: readonly [number, number];
  readonly sections: readonly TerrainSection[];
  /** Shared integer-LOD grid meshes, finest first. */
  readonly grids: readonly string[];
}

export type TerrainErrorCode =
  | 'terrain-input-invalid'
  | 'terrain-layer-invalid'
  | 'terrain-layer-budget-exceeded'
  | 'terrain-pose-unsupported'
  | 'terrain-query-unavailable';

export interface TerrainError {
  readonly code: TerrainErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly actual?: unknown };
}
