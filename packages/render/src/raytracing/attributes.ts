import { ok, type Result } from '@forgeax/engine-types';
import {
  buildRayReferenceScene,
  type RayMeshInstance,
  type RayReferenceError,
  type RayReferenceScene,
  rayReferenceFailure,
} from './scene';

export interface RaySurfaceInstance extends RayMeshInstance {
  /** Indexed vertex data. Missing sets are absent, not invented authored UVs. */
  readonly uvSets?: readonly ArrayLike<number>[];
  readonly colors?: ArrayLike<number>;
  readonly normals?: ArrayLike<number>;
  /** Object-space xyz plus authored tangent handedness (+1 or -1). */
  readonly tangents?: ArrayLike<number>;
}
export interface RaySurfaceScene extends RayReferenceScene {
  /** Three 128-byte vertices: object position, RGBA, UV0..7, world normal/winding, world tangent. */
  readonly attributes: Uint8Array;
  readonly instanceAttributes: ReadonlyMap<
    number,
    { readonly uvCount: number; readonly tangentFrame: boolean }
  >;
}
export const RAY_ATTRIBUTE_TRIANGLE_STRIDE = 384;
export const RAY_MATERIAL_INPUT_STRIDE = 224;
export const RAY_MATERIAL_SURFACE_STRIDE = 96;

/** Geometry facts remain derived from the same indexed source as traversal. */
export function buildRaySurfaceScene(
  instances: readonly RaySurfaceInstance[],
): Result<RaySurfaceScene, RayReferenceError> {
  const scene = buildRayReferenceScene(instances);
  if (!scene.ok) return scene;
  const byId = new Map(instances.map((i) => [i.instanceId, i]));
  const instanceAttributes = new Map<number, { uvCount: number; tangentFrame: boolean }>();
  for (const i of instances) {
    const count = i.positions.length / 3;
    if (
      (i.uvSets?.length ?? 0) > 8 ||
      i.uvSets?.some((uv) => uv.length !== count * 2 || !Array.from(uv).every(finite32)) ||
      (i.colors !== undefined &&
        (i.colors.length !== count * 4 ||
          !Array.from(i.colors).every((v) => finite32(v) && v >= 0 && v <= 1)))
    )
      return rayReferenceFailure(
        'expected 0..8 finite per-vertex UV sets and optional linear RGBA in [0,1]',
      );
    instanceAttributes.set(i.instanceId, {
      uvCount: i.uvSets?.length ?? 0,
      tangentFrame: i.normals !== undefined && i.tangents !== undefined,
    });
    for (const [data, stride] of [
      [i.normals, 3],
      [i.tangents, 4],
    ] as const) {
      if (data === undefined) continue;
      if (data.length !== count * stride || !Array.from(data).every(finite32))
        return rayReferenceFailure('expected finite per-vertex normals and xyzw tangents');
      for (let v = 0; v < count; v++) {
        if (
          Math.hypot(
            data[v * stride] ?? 0,
            data[v * stride + 1] ?? 0,
            data[v * stride + 2] ?? 0,
          ) === 0 ||
          (stride === 4 && Math.abs(data[v * stride + 3] ?? 0) !== 1)
        )
          return rayReferenceFailure(
            'normal/tangent directions must be nonzero; handedness is +1 or -1',
          );
      }
    }
  }
  const attributes = new Uint8Array(
    Math.max(1, scene.value.triangleCount) * RAY_ATTRIBUTE_TRIANGLE_STRIDE,
  );
  const out = new DataView(attributes.buffer);
  const triangles = new DataView(scene.value.triangles.buffer);
  for (let triangle = 0; triangle < scene.value.triangleCount; triangle++) {
    const instanceId = triangles.getUint32(triangle * 80 + 48, true);
    const primitive = triangles.getUint32(triangle * 80 + 56, true);
    const instance = byId.get(instanceId);
    if (instance === undefined) return rayReferenceFailure('missing source instance');
    const m = instance.transform;
    const columns = [read3(m, 0), read3(m, 4), read3(m, 8)] as const;
    const cofactor = [
      cross(columns[1], columns[2]),
      cross(columns[2], columns[0]),
      cross(columns[0], columns[1]),
    ] as const;
    const winding = Math.sign(dot(columns[0], cofactor[0]));
    const positions = ([0, 1, 2] as const).map((c) =>
      read3(instance.positions, (instance.indices[primitive * 3 + c] ?? 0) * 3),
    );
    const a = positions[0],
      b = positions[1],
      c = positions[2];
    if (!a || !b || !c) return rayReferenceFailure('missing indexed triangle');
    const face = cross(sub(b, a), sub(c, a));
    for (let corner = 0; corner < 3; corner++) {
      const vertex = instance.indices[primitive * 3 + corner] ?? -1;
      const offset = triangle * RAY_ATTRIBUTE_TRIANGLE_STRIDE + corner * 128;
      for (let axis = 0; axis < 3; axis++)
        out.setFloat32(offset + axis * 4, instance.positions[vertex * 3 + axis] ?? 0, true);
      for (let c = 0; c < 4; c++)
        out.setFloat32(offset + 16 + c * 4, instance.colors?.[vertex * 4 + c] ?? 1, true);
      for (let set = 0; set < 8; set++) {
        const uv = instance.uvSets?.[Math.min(set, (instance.uvSets?.length ?? 1) - 1)];
        for (let c = 0; c < 2; c++)
          out.setFloat32(offset + 32 + set * 8 + c * 4, uv?.[vertex * 2 + c] ?? 0, true);
      }
      // Normalized cofactor * sign(det) is inverse-transpose without an unstable division.
      const localNormal =
        instance.normals === undefined ? face : read3(instance.normals, vertex * 3);
      const normal = unit(multiply(cofactor, localNormal).map((v) => v * winding) as V3);
      const tangent =
        instance.tangents === undefined
          ? cross(Math.abs(normal[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], normal)
          : multiply(columns, read3(instance.tangents, vertex * 4));
      const projected = sub(tangent, normal.map((v) => v * dot(normal, tangent)) as V3);
      if (!normal.every(finite32) || Math.hypot(...projected) <= Math.hypot(...tangent) * 1e-8)
        return rayReferenceFailure(
          `instance ${instanceId} primitive ${primitive} vertex ${vertex} normal/tangent frame degenerates under the instance transform`,
        );
      const frame = [
        ...normal,
        winding,
        ...unit(projected),
        instance.tangents === undefined ? 1 : (instance.tangents[vertex * 4 + 3] ?? 1) * winding,
      ];
      for (let lane = 0; lane < 8; lane++)
        out.setFloat32(offset + 96 + lane * 4, frame[lane] ?? 0, true);
    }
  }
  return ok({ ...scene.value, attributes, instanceAttributes });
}
type V3 = [number, number, number];
const read3 = (v: ArrayLike<number>, o: number): V3 => [v[o] ?? 0, v[o + 1] ?? 0, v[o + 2] ?? 0];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: V3): V3 => v.map((x) => x / Math.hypot(...v)) as V3;
const multiply = (m: readonly [V3, V3, V3], v: V3): V3 =>
  ([0, 1, 2] as const).map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]) as V3;
function finite32(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}
