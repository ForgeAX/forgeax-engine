export type FieldVec3 = readonly [number, number, number];
export type FieldBounds = { readonly min: FieldVec3; readonly max: FieldVec3 };
export type DistanceFieldPolicy =
  | { readonly kind: 'signed-solid' | 'two-sided'; readonly errorBound: number }
  | {
      readonly kind: 'sampled-visibility';
      readonly sourceDigest: string;
      readonly mostlyTwoSided: boolean;
      readonly traceBounds: FieldBounds;
      readonly distanceBand: number;
    };
export interface MeshDistanceField {
  /** SHA-256 of canonical f32 positions/u32 topology, independent of materials and instances. */
  readonly meshDigest: string;
  /** Geometric distance bounds and sampled scene visibility have different hit semantics. */
  readonly policy: DistanceFieldPolicy;
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
