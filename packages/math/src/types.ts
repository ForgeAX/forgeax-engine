// types.ts — seven-piece brand SSOT (AC-01 / D-P15)
//
// Single type SSOT for the whole package: every dim file does `import type` from here,
// no other file may re-define these.
// `brand` is a pure compile-time phantom (Float32Array & { readonly __<name>: void }):
//   - At runtime it is just Float32Array; every TypedArray API (subarray/length/index) works directly
//   - At compile time dimensions are mutually exclusive: mat4.multiply(out, vec3, vec3) → tsc error
//   - When uploading to GPU the brand widens to Float32Array automatically, no unbrand needed
//
// `as Vec*/Mat*/Quat/Color` casts are only allowed inside factory functions under
// packages/math/src/ (enforced by lint-brand-cast.mjs).
//
// Related: requirements §AC-01 type ABI seven-piece + AC-02 brand mutual exclusion;
//          research §Finding 7.1 types.ts template (copy verbatim);
//          plan-strategy §1.1 file layering + D-P15 brand-cast funnel;
//          wiki/typescript-branded-types §1.1 / §7.1.

// === seven-piece brand ===

/** 2D vector storage: Float32Array length 2, brand=__vec2. */
export type Vec2 = Float32Array & { readonly __vec2: void };

/** 3D vector storage: Float32Array length 3, brand=__vec3. */
export type Vec3 = Float32Array & { readonly __vec3: void };

/** 4D vector / homogeneous coordinate storage: Float32Array length 4, brand=__vec4. */
export type Vec4 = Float32Array & { readonly __vec4: void };

/** Quaternion storage: Float32Array length 4 [x,y,z,w], brand=__quat (mutually exclusive with Vec4). */
export type Quat = Float32Array & { readonly __quat: void };

/** 3x3 matrix storage: Float32Array length 9 packed layout (D-P4); column-major (toGpuLayout hook reserved). */
export type Mat3 = Float32Array & { readonly __mat3: void };

/** 4x4 matrix storage: Float32Array length 16 column-major, brand=__mat4. */
export type Mat4 = Float32Array & { readonly __mat4: void };

/** Linear-space RGBA color: Float32Array length 4 [r,g,b,a] ∈ [0,1], brand=__color (mutually exclusive with Vec4). */
export type Color = Float32Array & { readonly __color: void };

// === Euler angle (plain object, not Float32Array) ===

/** Euler angle: enum of six intrinsic rotation orders (D-P19). */
export type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';

/**
 * Euler angle interface: x/y/z radians + order rotation order.
 *
 * Not a Float32Array because length=3 plus a string order needs plain-object storage;
 * performance-insensitive (euler is only used at editor/IO boundary; runtime always converts to Quat).
 */
export interface Euler {
  x: number;
  y: number;
  z: number;
  order: EulerOrder;
}

// === ArrayLike input aliases (seven-piece companion) ===
//
// *Like is for readable-input parameters in function signatures; return values still use brand.
// e.g. function add(out: Vec3, a: Vec3Like, b: Vec3Like): Vec3
// This both accepts vec3 inputs and literal [1,2,3] calls while keeping the return type brand-locked.

/** Vec2 readable input: ArrayLike<number> of length 2. */
export type Vec2Like = ArrayLike<number>;
/** Vec3 readable input: ArrayLike<number> of length 3. */
export type Vec3Like = ArrayLike<number>;
/** Vec4 readable input: ArrayLike<number> of length 4. */
export type Vec4Like = ArrayLike<number>;
/** Quat readable input: ArrayLike<number> of length 4. */
export type QuatLike = ArrayLike<number>;
/** Mat3 readable input: ArrayLike<number> of length 9. */
export type Mat3Like = ArrayLike<number>;
/** Mat4 readable input: ArrayLike<number> of length 16. */
export type Mat4Like = ArrayLike<number>;
/** Color readable input: ArrayLike<number> of length 4. */
export type ColorLike = ArrayLike<number>;
