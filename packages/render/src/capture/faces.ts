import { mat4, vec3 } from '@forgeax/engine-math';
import { CUBE_CAMERA_FACE_ORDER } from '../components/cube-camera';
import { RenderTargetLayerInvalidError } from '../errors/render';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';
import type { CameraSnapshot } from '../render-contract';
import { type RenderTarget, renderTargetLayerCount } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';
import type { PlanarCapture } from './planar-state';
import type { CubeCaptureWork } from './scheduler';

/**
 * What a capture face fits its cascades under. `render-capture-fit` retains one
 * fit per key, so a steady face keeps its matrices and a vanished one releases
 * its cascade views.
 */
export type CaptureFitKey =
  | { readonly kind: 'probe'; readonly probeIndex: number }
  | { readonly kind: 'cube'; readonly target: RenderTarget; readonly layer: number }
  | { readonly kind: 'planar'; readonly target: RenderTarget }
  | { readonly kind: 'auxiliary'; readonly target: RenderTarget; readonly layer: number }
  | {
      readonly kind: 'scene-input';
      readonly featureIdentity: string;
      readonly target: RenderTarget;
    };

/** A non-probe capture face and the key its cascades fit under. */
export interface CaptureFace {
  readonly key: Exclude<CaptureFitKey, { readonly kind: 'probe' }>;
  readonly work: CubeCaptureGraphWork;
}

/** One auxiliary camera's write into a 2D/array/3D target layer; cube targets take no camera. */
export function targetCaptureWork(
  camera: CameraSnapshot,
  physical: RenderTargetPhysical | undefined,
): CubeCaptureGraphWork | undefined {
  if (camera.target === undefined || physical === undefined || physical.descriptor.shape === 'cube')
    return undefined;
  const layer = camera.targetLayer ?? 0;
  const layerCount = renderTargetLayerCount(physical.descriptor);
  if (!Number.isInteger(layer) || layer < 0 || layer >= layerCount)
    throw new RenderTargetLayerInvalidError({
      operation: 'write',
      layer,
      shape: physical.descriptor.shape,
      layerCount,
    });
  return { target: camera.target, layer, physical, faceCamera: camera };
}

function cubeFaceWork(
  item: CubeCaptureWork,
  physical: RenderTargetPhysical,
  layer: number,
  displayCamera: CameraSnapshot,
): CubeCaptureGraphWork {
  const faceWorld = mat4.create();
  mat4.invert(faceWorld, item.view);
  return {
    target: item.target,
    candidateGeneration: item.candidateGeneration,
    layer,
    physical,
    faceCamera: {
      ...displayCamera,
      clipping: { planes: [] },
      position: vec3.create(item.position[0] ?? 0, item.position[1] ?? 0, item.position[2] ?? 0),
      world: faceWorld,
      fov: Math.PI / 2,
      aspect: 1,
      near: item.near,
      far: item.far,
      projection: 'perspective',
    },
  };
}

/**
 * Every non-probe capture face of one view this frame, in capture order:
 * progressive cube faces, the due planar mirror and the auxiliary target
 * cameras, then the Feature scene inputs. Throws a render-target layer error
 * for an out-of-range auxiliary layer; `render-capture-schedule` stores it.
 */
export function buildCaptureFaces(input: {
  readonly cube: readonly CubeCaptureWork[];
  readonly auxiliaryCameras: readonly CameraSnapshot[];
  readonly planar: PlanarCapture | undefined;
  readonly sceneInputs: readonly CubeCaptureGraphWork[];
  readonly displayCamera: CameraSnapshot;
  readonly physicalOf: (target: RenderTarget) => RenderTargetPhysical | undefined;
}): readonly CaptureFace[] {
  const faces: CaptureFace[] = [];
  for (const item of input.cube) {
    const physical = input.physicalOf(item.target);
    const layer = CUBE_CAMERA_FACE_ORDER.indexOf(item.face);
    if (physical === undefined || layer < 0) continue;
    faces.push({
      key: { kind: 'cube', target: item.target, layer },
      work: cubeFaceWork(item, physical, layer, input.displayCamera),
    });
  }
  for (const camera of input.auxiliaryCameras) {
    const planar = camera.planarReflection !== undefined;
    if (camera.target === undefined || (planar && input.planar === undefined)) continue;
    const work = targetCaptureWork(
      camera,
      planar ? input.planar?.physical : input.physicalOf(camera.target),
    );
    if (work === undefined) continue;
    faces.push({
      key: planar
        ? { kind: 'planar', target: work.target }
        : { kind: 'auxiliary', target: work.target, layer: work.layer },
      work,
    });
  }
  for (const work of input.sceneInputs)
    faces.push({
      key: {
        kind: 'scene-input',
        featureIdentity: work.featureIdentity ?? '',
        target: work.target,
      },
      work,
    });
  return faces;
}
