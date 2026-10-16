/** Metres, Y-up, finite ground agents. Recast quantizes clearance conservatively. */
export interface NavigationBakeSettings {
  readonly radius: number;
  readonly height: number;
  readonly maxSlopeDeg: number;
  readonly maxStep: number;
  readonly cellSize: number;
  readonly cellHeight: number;
}
/** Compiler-free, portable convex polygons in world coordinates. */
export interface NavigationMeshAsset {
  readonly kind: 'navigation-mesh';
  readonly version: 'recast-poly/1';
  /** Producer SHA256 of version, all placed geometry and effective settings. */
  readonly sourceDigest: string;
  readonly settings: NavigationBakeSettings;
  readonly vertices: readonly number[];
  readonly polygons: readonly (readonly number[])[];
}
