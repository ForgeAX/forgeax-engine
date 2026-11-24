export type FieldVec3 = readonly [number, number, number];
export type FieldBounds = { readonly min: FieldVec3; readonly max: FieldVec3 };
/** Flat canonical source geometry and a complete derived BVH. Source digest,
 * material-sidedness identity and actual draw eligibility are separate gates. */
export interface MeshDistanceFieldSurface {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleSidedness: Uint32Array;
  /** LE32: min.xyz:f32, escape:u32, max.xyz:f32, first*4+count:u32.
   * Count 0 is internal; 1/2 is a leaf. Escape is the exclusive subtree end. */
  readonly nodes: Uint8Array;
  /** Original nondegenerate source primitive IDs, each exactly once. */
  readonly primitiveOrder: Uint32Array;
}
export type DistanceFieldPolicy =
  | { readonly kind: 'signed-solid' | 'two-sided'; readonly errorBound: number }
  | {
      readonly kind: 'sampled-visibility';
      readonly sourceDigest: string;
      readonly mostlyTwoSided: boolean;
      readonly traceBounds: FieldBounds;
      readonly distanceBand: number;
      /** Error of each stored f32 magnitude against min(true unsigned distance, band).
       * This is not a signed-distance, interpolation or GPU arithmetic bound. */
      readonly unsignedSampleError: number;
    };
interface MeshDistanceFieldData {
  /** SHA-256 of canonical f32 positions/u32 topology, independent of materials and instances. */
  readonly meshDigest: string;
  readonly dimensions: FieldVec3;
  readonly origin: FieldVec3;
  readonly spacing: number;
  /** Each 4-cubed brick addresses 64 exact f32 samples; identical payloads may share offsets. */
  readonly bricks: Uint32Array;
  readonly values: Float32Array;
  /** Actual geometry extent. Trace bounds and the stored gradient border are separate. */
  readonly bounds: FieldBounds;
  readonly quality: { readonly negativeSamples: number; readonly testedTriangles: number };
}
/** Sampled visibility requires the same canonical source surface as its samples.
 * Geometric fields retain their existing explicit distance-bound policy. */
export type MeshDistanceField = MeshDistanceFieldData &
  (
    | {
        readonly policy: Extract<
          DistanceFieldPolicy,
          { readonly kind: 'signed-solid' | 'two-sided' }
        >;
        readonly surface?: never;
      }
    | {
        readonly policy: Extract<DistanceFieldPolicy, { readonly kind: 'sampled-visibility' }>;
        readonly surface: MeshDistanceFieldSurface;
      }
  );
