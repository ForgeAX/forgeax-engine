import { err, type GltfError, gltfErr, ok, type Result } from './errors';
export type GltfCameraIr =
  | {
      readonly projection: 0;
      readonly autoAspect: boolean;
      readonly fov: number;
      readonly aspect: number;
      readonly near: number;
      readonly far: number;
    }
  | {
      readonly projection: 1;
      readonly autoAspect: false;
      readonly fov: 0;
      readonly aspect: number;
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly bottom: number;
      readonly near: number;
      readonly far: number;
    };
export interface GltfCameraJson {
  readonly type: string;
  readonly perspective?: {
    readonly yfov: number;
    readonly aspectRatio?: number;
    readonly znear: number;
    readonly zfar?: number;
  };
  readonly orthographic?: {
    readonly xmag: number;
    readonly ymag: number;
    readonly znear: number;
    readonly zfar: number;
  };
}
/** Finite Float32 far sentinel keeps infinite-far projection portable through JSON Cook. */
export function parseCamera(
  camera: GltfCameraJson | undefined,
  cameraIndex: number,
): Result<GltfCameraIr, GltfError> {
  const invalid = () => err(gltfErr('gltf-camera-invalid', { cameraIndex }));
  if (camera?.type === 'perspective' && camera.perspective !== undefined) {
    const p = camera.perspective,
      aspect = p.aspectRatio ?? 1,
      far = p.zfar ?? 3.4028234663852886e38;
    if (
      ![p.yfov, aspect, p.znear, far].every((value) => Number.isFinite(Math.fround(value))) ||
      Math.fround(p.yfov) <= 0 ||
      Math.fround(p.yfov) >= Math.PI ||
      Math.fround(aspect) <= 0 ||
      Math.fround(p.znear) <= 0 ||
      Math.fround(far) <= Math.fround(p.znear)
    )
      return invalid();
    return ok({
      projection: 0,
      autoAspect: p.aspectRatio === undefined,
      fov: p.yfov,
      aspect,
      near: p.znear,
      far,
    });
  }
  if (camera?.type === 'orthographic' && camera.orthographic !== undefined) {
    const p = camera.orthographic;
    if (
      ![p.xmag, p.ymag, p.znear, p.zfar, p.xmag / p.ymag].every((value) =>
        Number.isFinite(Math.fround(value)),
      ) ||
      Math.fround(p.xmag) <= 0 ||
      Math.fround(p.ymag) <= 0 ||
      Math.fround(p.xmag / p.ymag) <= 0 ||
      p.znear < 0 ||
      Math.fround(p.zfar) <= Math.fround(p.znear)
    )
      return invalid();
    return ok({
      projection: 1,
      autoAspect: false,
      fov: 0,
      aspect: p.xmag / p.ymag,
      left: -p.xmag,
      right: p.xmag,
      top: p.ymag,
      bottom: -p.ymag,
      near: p.znear,
      far: p.zfar,
    });
  }
  return invalid();
}
