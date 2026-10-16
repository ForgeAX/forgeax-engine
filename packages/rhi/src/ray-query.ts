// @forgeax/engine-rhi/src/ray-query - hardware Ray Query vocabulary.
//
// Capability absence is data: every backend reports `caps.rayQuery`, either a
// closed unsupported reason or the admitted acceleration-structure limits. The
// handle and descriptor shapes mirror wgpu's experimental acceleration
// structure API (`create_blas` / `create_tlas` / `build_acceleration_structures`)
// so a native lowering is a field rename, not a policy translation. No
// browser WebGPU implementation exposes a ray-tracing feature, so the browser
// backends report `backend-has-no-ray-query`.

import type { Result, RhiError as RhiErrorType } from './errors.js';
import { err, ok, RhiError } from './errors.js';
import type { BindGroupLayoutDescriptor, Buffer } from './index';

declare const RhiBlasBrand: unique symbol;
/** Bottom-level acceleration structure opaque handle (triangle geometry). */
export interface Blas {
  readonly [RhiBlasBrand]: void;
}

declare const RhiTlasBrand: unique symbol;
/** Top-level acceleration structure opaque handle (BLAS instances). */
export interface Tlas {
  readonly [RhiTlasBrand]: void;
}

/**
 * Why a device cannot run Ray Query.
 *
 * - `backend-has-no-ray-query`: the backend family has no acceleration
 *   structures (browser WebGPU, wgpu WebGL2, the default RhiNull device).
 * - `adapter-lacks-feature`: a native wgpu adapter without
 *   `EXPERIMENTAL_RAY_QUERY` (Vulkan without VK_KHR_ray_query, Metal before
 *   macOS 15 / iOS 18).
 */
export type RhiRayQueryUnsupportedReason = 'backend-has-no-ray-query' | 'adapter-lacks-feature';

/** Admitted acceleration-structure limits of a Ray Query device. */
export interface RhiRayQueryLimits {
  readonly maxBlasGeometryCount: number;
  readonly maxBlasPrimitiveCount: number;
  readonly maxTlasInstanceCount: number;
  readonly maxAccelerationStructuresPerShaderStage: number;
}

/** `caps.rayQuery`: unsupported with a closed reason, or supported with limits. */
export type RhiRayQueryCaps =
  | { readonly supported: false; readonly reason: RhiRayQueryUnsupportedReason }
  | ({ readonly supported: true } & RhiRayQueryLimits);

/** The unsupported value shared by every backend family without acceleration structures. */
export const RAY_QUERY_BACKEND_UNSUPPORTED: RhiRayQueryCaps = Object.freeze({
  supported: false,
  reason: 'backend-has-no-ray-query',
});

/**
 * Device feature name of wgpu's experimental Ray Query extension
 * (`Features::EXPERIMENTAL_RAY_QUERY`). A WebGPU-shaped device that exposes
 * acceleration structures reports it in `features` together with the four
 * `RhiRayQueryLimits` names in `limits`.
 */
export const RAY_QUERY_FEATURE = 'wgpu-ray-query';

/**
 * Derive `caps.rayQuery` from a device's feature set and limits. `extension`
 * says whether the backend family can expose acceleration structures at all;
 * a family that can but whose adapter lacks the feature reports
 * `adapter-lacks-feature`.
 */
export function deriveRayQueryCaps(
  extension: boolean,
  hasFeature: boolean,
  limits: Readonly<Record<string, unknown>>,
): RhiRayQueryCaps {
  if (!extension) return RAY_QUERY_BACKEND_UNSUPPORTED;
  const limit = (name: keyof RhiRayQueryLimits): number => {
    const value = limits[name];
    return typeof value === 'number' ? value : 0;
  };
  const admitted: RhiRayQueryLimits = {
    maxBlasGeometryCount: limit('maxBlasGeometryCount'),
    maxBlasPrimitiveCount: limit('maxBlasPrimitiveCount'),
    maxTlasInstanceCount: limit('maxTlasInstanceCount'),
    maxAccelerationStructuresPerShaderStage: limit('maxAccelerationStructuresPerShaderStage'),
  };
  if (!hasFeature || Object.values(admitted).some((value) => value <= 0)) {
    return Object.freeze({ supported: false, reason: 'adapter-lacks-feature' });
  }
  return Object.freeze({ supported: true, ...admitted });
}

/** Builder optimisation target. Default `'fast-trace'`. */
export type AccelerationStructureBuildPreference = 'fast-trace' | 'fast-build';

/**
 * Behaviour of a later `buildAccelerationStructures` on the same handle.
 * `'rebuild'` (default) always performs a full build; `'refit'` admits an
 * in-place update when the topology is unchanged (wgpu `ALLOW_UPDATE` +
 * `PreferUpdate`). Both keep the handle; re-building is how a TLAS updates
 * instance transforms every frame.
 */
export type AccelerationStructureUpdateMode = 'rebuild' | 'refit';

/** BLAS vertex positions. Extended formats are not admitted. */
export type BlasVertexFormat = 'float32x3';

/** Size declaration of one opaque triangle geometry, fixed at BLAS creation. */
export interface BlasTriangleGeometrySize {
  readonly vertexFormat: BlasVertexFormat;
  readonly vertexCount: number;
  /** Indexed geometry; omit for a non-indexed triangle list. */
  readonly index?: { readonly format: GPUIndexFormat; readonly count: number } | undefined;
}

export interface BlasDescriptor {
  readonly label?: string | undefined;
  /** One or more opaque triangle geometries; build entries supply data in the same order. */
  readonly geometries: readonly BlasTriangleGeometrySize[];
  readonly preference?: AccelerationStructureBuildPreference | undefined;
  readonly updateMode?: AccelerationStructureUpdateMode | undefined;
}

export interface TlasDescriptor {
  readonly label?: string | undefined;
  readonly maxInstances: number;
  readonly preference?: AccelerationStructureBuildPreference | undefined;
  readonly updateMode?: AccelerationStructureUpdateMode | undefined;
}

/** Build-time data of one geometry declared by `BlasDescriptor.geometries[i]`. */
export interface BlasTriangleGeometry {
  readonly vertexBuffer: Buffer;
  readonly firstVertex?: number | undefined;
  /** Byte stride between positions; at least 12 and a multiple of 4. */
  readonly vertexStride: number;
  /** Required exactly when the size declaration is indexed. */
  readonly index?:
    | { readonly buffer: Buffer; readonly firstIndex?: number | undefined }
    | undefined;
}

export interface BlasBuildEntry {
  readonly blas: Blas;
  readonly geometries: readonly BlasTriangleGeometry[];
}

/**
 * One TLAS instance. `transform` is the 3x4 row-major object-to-world matrix
 * (12 numbers, translation in elements 3/7/11) - the layout every native API
 * consumes. `customIndex` (24-bit) is returned to the shader as
 * `RayIntersection.instance_custom_data`; `mask` (8-bit) is ANDed with the
 * ray's cull mask.
 */
export interface TlasInstance {
  readonly blas: Blas;
  readonly transform: ArrayLike<number>;
  readonly customIndex: number;
  readonly mask: number;
}

export interface TlasBuildEntry {
  readonly tlas: Tlas;
  /** Dense instance list; replaces the previous contents on every build. */
  readonly instances: readonly TlasInstance[];
}

/**
 * Buffer usage bit of a BLAS build input (vertex positions or indices). It
 * extends the W3C `GPUBufferUsage` mask outside its range and equals wgpu
 * `BufferUsages::BLAS_INPUT` (`1 << 10`), so native lowering is identity.
 * `createBuffer` admits it only when `caps.rayQuery.supported`; every
 * `buildAccelerationStructures` geometry buffer must carry it.
 */
export const BLAS_INPUT_BUFFER_USAGE = 0x400;

/** Gate a buffer descriptor's usage: `BLAS_INPUT_BUFFER_USAGE` requires `caps.rayQuery.supported`. */
export function validateRayQueryBufferUsage(
  caps: RhiRayQueryCaps,
  usage: number,
): Result<void, RhiErrorType> {
  if (caps.supported || (usage & BLAS_INPUT_BUFFER_USAGE) === 0) return ok(undefined);
  return err(rayQueryNotEnabled('a buffer with BLAS_INPUT_BUFFER_USAGE', caps));
}

/** Bind-group-layout entry member for a TLAS binding (`acceleration_structure` in WGSL). */
export type AccelerationStructureBindingLayout = Readonly<Record<string, never>>;

/**
 * The WGSL directive a Ray Query module starts with. Modules that contain it
 * are a capability-gated shader variant; browser builds never load them.
 */
export const RAY_QUERY_WGSL_ENABLE = 'enable wgpu_ray_query;';

const ENABLE_DIRECTIVE = /^\s*enable\s+([^;]+);/gm;

/** Whether WGSL source enables the `wgpu_ray_query` extension. */
export function wgslEnablesRayQuery(code: string): boolean {
  for (const match of code.matchAll(ENABLE_DIRECTIVE)) {
    const names = (match[1] ?? '').split(',').map((name) => name.trim());
    if (names.includes('wgpu_ray_query')) return true;
  }
  return false;
}

function rayQueryNotEnabled(operation: string, caps: RhiRayQueryCaps): RhiErrorType {
  const reason = caps.supported ? 'supported' : caps.reason;
  return new RhiError({
    code: 'feature-not-enabled',
    expected: 'caps.rayQuery.supported === true',
    hint: `${operation} requires hardware Ray Query; this device reports caps.rayQuery.reason='${reason}'. Select the compute-BVH or SDF traversal instead`,
  });
}

function invalid(expected: string, hint: string): RhiErrorType {
  return new RhiError({ code: 'rhi-descriptor-invalid', expected, hint });
}

function isCount(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min;
}

/** Gate a shader module: Ray Query WGSL requires `caps.rayQuery.supported`. */
export function validateRayQueryShader(
  caps: RhiRayQueryCaps,
  code: string,
): Result<void, RhiErrorType> {
  if (caps.supported || !wgslEnablesRayQuery(code)) return ok(undefined);
  return err(rayQueryNotEnabled(`a shader module with '${RAY_QUERY_WGSL_ENABLE}'`, caps));
}

/** Primitive count of one declared geometry, or undefined when the declaration is malformed. */
function primitiveCount(size: BlasTriangleGeometrySize): number | undefined {
  if (size.vertexFormat !== 'float32x3' || !isCount(size.vertexCount, 3)) return undefined;
  const count = size.index === undefined ? size.vertexCount : size.index.count;
  if (!isCount(count, 3) || count % 3 !== 0) return undefined;
  return count / 3;
}

/** Structural BLAS creation contract shared by every backend. */
export function validateBlasDescriptor(
  caps: RhiRayQueryCaps,
  desc: BlasDescriptor,
): Result<void, RhiErrorType> {
  if (!caps.supported) return err(rayQueryNotEnabled('createBlas', caps));
  const count = desc.geometries.length;
  if (count === 0 || count > caps.maxBlasGeometryCount) {
    return err(
      invalid(
        `1..caps.rayQuery.maxBlasGeometryCount (${caps.maxBlasGeometryCount}) geometries`,
        `got ${count}; split the mesh across several BLAS`,
      ),
    );
  }
  let primitives = 0;
  for (const [index, size] of desc.geometries.entries()) {
    const geometryPrimitives = primitiveCount(size);
    if (geometryPrimitives === undefined) {
      return err(
        invalid(
          'float32x3 positions with a whole triangle list (vertex or index count a positive multiple of 3)',
          `geometries[${index}] is not a triangle list`,
        ),
      );
    }
    primitives += geometryPrimitives;
  }
  if (primitives > caps.maxBlasPrimitiveCount) {
    return err(
      invalid(
        `at most caps.rayQuery.maxBlasPrimitiveCount (${caps.maxBlasPrimitiveCount}) triangles per BLAS`,
        `got ${primitives}; split the mesh across several BLAS`,
      ),
    );
  }
  return ok(undefined);
}

/** Structural TLAS creation contract shared by every backend. */
export function validateTlasDescriptor(
  caps: RhiRayQueryCaps,
  desc: TlasDescriptor,
): Result<void, RhiErrorType> {
  if (!caps.supported) return err(rayQueryNotEnabled('createTlas', caps));
  if (!isCount(desc.maxInstances, 1) || desc.maxInstances > caps.maxTlasInstanceCount) {
    return err(
      invalid(
        `maxInstances in 1..caps.rayQuery.maxTlasInstanceCount (${caps.maxTlasInstanceCount})`,
        `got ${desc.maxInstances}`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Validate BLAS build data against the descriptor the handle was created with.
 * `usageOf` returns the creation usage of a live buffer of this device; every
 * vertex and index buffer must carry `BLAS_INPUT_BUFFER_USAGE`.
 */
export function validateBlasBuild(
  desc: BlasDescriptor,
  entry: BlasBuildEntry,
  usageOf: (buffer: Buffer) => number,
): Result<void, RhiErrorType> {
  if (entry.geometries.length !== desc.geometries.length) {
    return err(
      invalid(
        `one build geometry per declared geometry (${desc.geometries.length})`,
        `got ${entry.geometries.length}; BLAS topology is fixed at creation, create a new BLAS to change it`,
      ),
    );
  }
  for (const [index, geometry] of entry.geometries.entries()) {
    const size = desc.geometries[index];
    const indexed = size?.index !== undefined;
    if (indexed !== (geometry.index !== undefined)) {
      return err(
        invalid(
          'build geometry index buffer present exactly when the declaration is indexed',
          `geometries[${index}] disagrees with its creation-time declaration`,
        ),
      );
    }
    if (!isCount(geometry.vertexStride, 12) || geometry.vertexStride % 4 !== 0) {
      return err(
        invalid('vertexStride >= 12 and a multiple of 4', `geometries[${index}] stride is invalid`),
      );
    }
    for (const buffer of [geometry.vertexBuffer, geometry.index?.buffer]) {
      if (buffer !== undefined && (usageOf(buffer) & BLAS_INPUT_BUFFER_USAGE) === 0) {
        return err(
          invalid(
            'BLAS vertex and index buffers created with BLAS_INPUT_BUFFER_USAGE',
            `geometries[${index}] binds a buffer without it; add BLAS_INPUT_BUFFER_USAGE to its usage`,
          ),
        );
      }
    }
  }
  return ok(undefined);
}

/** Validate one TLAS build entry against the TLAS creation descriptor. */
export function validateTlasBuild(
  desc: TlasDescriptor,
  entry: TlasBuildEntry,
): Result<void, RhiErrorType> {
  if (entry.instances.length > desc.maxInstances) {
    return err(
      invalid(
        `at most TlasDescriptor.maxInstances (${desc.maxInstances}) instances`,
        `got ${entry.instances.length}; create a larger TLAS`,
      ),
    );
  }
  for (const [index, instance] of entry.instances.entries()) {
    const transform = instance.transform;
    let finite = transform.length === 12;
    for (let i = 0; finite && i < 12; i++) finite = Number.isFinite(transform[i]);
    if (!finite) {
      return err(
        invalid(
          'transform of 12 finite numbers (3x4 row-major)',
          `instances[${index}] transform is invalid`,
        ),
      );
    }
    const { customIndex, mask } = instance;
    if (!Number.isInteger(customIndex) || customIndex < 0 || customIndex >= 1 << 24)
      return err(
        invalid('customIndex in 0..2^24-1', `instances[${index}] customIndex=${customIndex}`),
      );
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xff)
      return err(invalid('mask in 0..255', `instances[${index}] mask=${mask}`));
  }
  return ok(undefined);
}

/** Gate a bind group layout: an `accelerationStructure` entry requires `caps.rayQuery.supported`. */
export function validateRayQueryBindGroupLayout(
  caps: RhiRayQueryCaps,
  desc: BindGroupLayoutDescriptor,
): Result<void, RhiErrorType> {
  if (caps.supported) return ok(undefined);
  for (const entry of desc.entries) {
    if (entry.accelerationStructure !== undefined) {
      return err(
        rayQueryNotEnabled(
          `bind group layout entry ${entry.binding} (accelerationStructure)`,
          caps,
        ),
      );
    }
  }
  return ok(undefined);
}

/** The error every non-Ray-Query backend returns from BLAS/TLAS operations. */
export function rayQueryUnsupported(
  operation: string,
  caps: RhiRayQueryCaps,
): Result<never, RhiErrorType> {
  return err(rayQueryNotEnabled(operation, caps));
}
