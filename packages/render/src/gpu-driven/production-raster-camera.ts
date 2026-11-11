import { frustum, mat4 } from '@forgeax/engine-math';
import { cameraLensProjection } from '../camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import type { GpuDrivenOcclusionCamera } from './view-gpu';

function createCameraScratch() {
  return { projection: mat4.create(), view: mat4.create(), viewProjection: mat4.create() };
}
let retainedScratch: ReturnType<typeof createCameraScratch> | undefined;
let usingScratch = false;

export function activeFrustum(camera: CameraSnapshot): Float32Array {
  const outer = usingScratch;
  if (!outer && retainedScratch === undefined) retainedScratch = createCameraScratch();
  const scratch = outer
    ? createCameraScratch()
    : (retainedScratch as ReturnType<typeof createCameraScratch>);
  usingScratch = true;
  try {
    cameraLensProjection(camera, scratch.projection);
    mat4.invert(scratch.view, camera.world);
    mat4.multiply(scratch.viewProjection, scratch.projection, scratch.view);
    return frustum.fromViewProjection(frustum.create(), scratch.viewProjection);
  } finally {
    usingScratch = outer;
  }
}

/** The camera clipping shadow casters honor; empty when shadows ignore it. */
export function shadowViewClipping(camera: CameraSnapshot): string {
  const clipping = camera.clipping;
  if (clipping?.clipShadows !== true || clipping.planes.length === 0) return '';
  return `${clipping.intersection === true ? 'and' : 'or'}:${clipping.planes.flat().join(',')}`;
}

/**
 * Unjittered camera facts for the late HZB test. They derive from the same
 * helpers as the View UBO, so the pyramid and the test share one projection.
 */
export function occlusionCamera(camera: CameraSnapshot): GpuDrivenOcclusionCamera {
  const outer = usingScratch;
  if (!outer && retainedScratch === undefined) retainedScratch = createCameraScratch();
  const scratch = outer
    ? createCameraScratch()
    : (retainedScratch as ReturnType<typeof createCameraScratch>);
  usingScratch = true;
  try {
    const viewProjection = mat4.multiply(
      mat4.create(),
      computeProjectionMatrix(camera, scratch.projection),
      computeViewMatrix(camera, scratch.view),
    );
    return {
      viewProjection,
      near: camera.near,
      far: camera.far,
      orthographic: camera.projection === 'orthographic',
      historyKey: `${camera.worldId ?? ''}:${camera.entityKey ?? 0}:${camera.historyVersion ?? 0}:${camera.aspect}`,
    };
  } finally {
    usingScratch = outer;
  }
}

/**
 * Light NDC to world, or undefined when the light matrix has no usable inverse.
 * `mat4.invert` treats |det| < 1e-8 as singular and returns identity, which a
 * kilometre-wide orthographic cascade reaches; scaling the world axes first
 * keeps the determinant near one, and the round trip rejects a truly singular
 * matrix so the kernel never builds a receiver prism in the wrong space.
 *
 * @internal
 */
export function invertLightViewProjection(
  lightViewProjection: Float32Array,
): Float32Array | undefined {
  let scale = 0;
  for (let index = 0; index < 12; index += 1) {
    if (index % 4 !== 3) scale = Math.max(scale, Math.abs(lightViewProjection[index] as number));
  }
  if (!(scale > 0 && Number.isFinite(scale))) return undefined;
  const scaled = mat4.create();
  scaled.set(lightViewProjection.subarray(0, 16));
  for (let index = 0; index < 12; index += 1) scaled[index] = (scaled[index] as number) / scale;
  const inverse = mat4.invert(mat4.create(), scaled);
  const product = mat4.multiply(mat4.create(), scaled, inverse);
  for (let index = 0; index < 16; index += 1) {
    const expected = index % 5 === 0 ? 1 : 0;
    if (!(Math.abs((product[index] as number) - expected) <= 1e-4)) return undefined;
  }
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      inverse[column * 4 + row] = (inverse[column * 4 + row] as number) / scale;
    }
  }
  return inverse;
}
