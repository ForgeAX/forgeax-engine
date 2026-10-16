import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { cameraLensProjection } from '../camera-projection';
import { Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import {
  resolveStereoCamera,
  StereoCamera,
  type StereoCameraData,
  type StereoCameraSnapshot,
  type StereoEye,
  StereoLayoutValue,
  stereoEyeCamera,
  stereoEyeCameras,
  stereoEyeViewport,
  stereoFrustumShift,
} from '../components/stereo-camera';
import { StereoCameraInvalidError } from '../errors/render';
import { renderFeatureViewIdentity } from '../features/view';
import { computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import { cameraForView, selectCameraRoles } from '../render-system-extract';

/** Transcription of three.js r184 StereoCamera.update for one eye (zoom = 1, aspect scale = 1). */
function threeStereoEye(
  eye: StereoEye,
  input: { fov: number; aspect: number; near: number; far: number; focus: number; eyeSep: number },
) {
  const eyeSepHalf = input.eyeSep / 2;
  const eyeSepOnProjection = (eyeSepHalf * input.near) / input.focus;
  const ymax = input.near * Math.tan(input.fov * 0.5);
  const shift = eye === 'left' ? eyeSepOnProjection : -eyeSepOnProjection;
  const xmin = -ymax * input.aspect + shift;
  const xmax = ymax * input.aspect + shift;
  return {
    m0: (2 * input.near) / (xmax - xmin),
    m8: (xmax + xmin) / (xmax - xmin),
    eyeOffsetX: eye === 'left' ? -eyeSepHalf : eyeSepHalf,
  };
}

const identity = () => mat4.identity(mat4.create());

function snapshot(overrides: Partial<CameraSnapshot> = {}): CameraSnapshot {
  const world = identity();
  world[12] = 1;
  world[13] = 2;
  world[14] = 3;
  return {
    world,
    position: vec3.create(1, 2, 3),
    fov: Math.PI / 3,
    aspect: 16 / 9,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    stereo: { eyeSeparation: 0.2, convergence: 4, layout: 'side-by-side', swapEyes: false },
    ...overrides,
  } as CameraSnapshot;
}

function projectNdcX(camera: CameraSnapshot, point: readonly [number, number, number]): number {
  const clip = mat4.multiply(
    mat4.create(),
    cameraLensProjection(camera),
    computeViewMatrix(camera),
  );
  const [x, y, z] = point;
  const cx = (clip[0] ?? 0) * x + (clip[4] ?? 0) * y + (clip[8] ?? 0) * z + (clip[12] ?? 0);
  const cw = (clip[3] ?? 0) * x + (clip[7] ?? 0) * y + (clip[11] ?? 0) * z + (clip[15] ?? 0);
  return cx / cw;
}

describe('StereoCamera projection', () => {
  const cases = [
    { fov: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 100, focus: 10, eyeSep: 0.064 },
    { fov: (50 * Math.PI) / 180, aspect: 0.5, near: 0.5, far: 50, focus: 2, eyeSep: 0.3 },
    { fov: 1.2, aspect: 1, near: 0.01, far: 10, focus: 0.5, eyeSep: 0 },
  ];
  it.each(cases)('matches three.js StereoCamera off-axis terms for %o', (input) => {
    for (const eye of ['left', 'right'] as const) {
      const expected = threeStereoEye(eye, input);
      const camera = stereoEyeCamera(
        snapshot({
          fov: input.fov,
          aspect: input.aspect,
          near: input.near,
          far: input.far,
          world: identity(),
          position: vec3.create(0, 0, 0),
          stereo: {
            eyeSeparation: input.eyeSep,
            convergence: input.focus,
            layout: 'side-by-side',
            swapEyes: false,
          },
        }),
        eye,
      );
      const projection = cameraLensProjection(camera);
      const mono = mat4.perspectiveReverseZ(
        mat4.create(),
        input.fov,
        input.aspect,
        input.near,
        input.far,
      );
      expect(projection[0]).toBeCloseTo(expected.m0, 6);
      expect(projection[8]).toBeCloseTo(expected.m8, 6);
      expect(
        stereoFrustumShift(
          { eyeSeparation: input.eyeSep, convergence: input.focus },
          eye,
          input.fov,
          input.aspect,
        ),
      ).toBeCloseTo(expected.m8, 9);
      for (const index of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15])
        expect(projection[index]).toBeCloseTo(mono[index] ?? Number.NaN, 6);
      expect(camera.world[12]).toBeCloseTo(expected.eyeOffsetX, 6);
      expect(camera.position[0]).toBeCloseTo(expected.eyeOffsetX, 6);
    }
  });

  it('offsets each eye along the camera local X axis', () => {
    const rotated = mat4.fromRotation(mat4.create(), [0, 1, 0], Math.PI / 2);
    rotated[12] = 5;
    const camera = snapshot({ world: rotated, position: vec3.create(5, 0, 0) });
    const [left, right] = stereoEyeCameras(camera);
    // Local +X of a +90 degree yaw points to world -Z.
    expect(left?.position[0]).toBeCloseTo(5, 6);
    expect(left?.position[2]).toBeCloseTo(0.1, 6);
    expect(right?.position[2]).toBeCloseTo(-0.1, 6);
  });

  it('has zero parallax at convergence and crossed parallax nearer than it', () => {
    const camera = snapshot({ world: identity(), position: vec3.create(0, 0, 0) });
    const [left, right] = stereoEyeCameras(camera);
    if (left === undefined || right === undefined) throw new Error('expected two eyes');
    const at = (depth: number) =>
      projectNdcX(left, [0, 0, -depth]) - projectNdcX(right, [0, 0, -depth]);
    expect(Math.abs(at(4))).toBeLessThan(1e-6);
    expect(at(2)).toBeGreaterThan(0);
    expect(at(40)).toBeLessThan(0);
    const tan = Math.tan(camera.fov * 0.5);
    // Analytic screen disparity: s / (tan * aspect) * (1 / d - 1 / f) in NDC units.
    expect(at(2)).toBeCloseTo((0.2 / (tan * camera.aspect)) * (1 / 2 - 1 / 4), 5);
  });

  it('keeps a mono camera untouched and a zero separation pair identical', () => {
    const mono = snapshot();
    const { stereo: _stereo, ...plain } = mono;
    expect(stereoEyeCameras(plain as CameraSnapshot)).toEqual([plain]);
    const [left, right] = stereoEyeCameras(
      snapshot({
        stereo: { eyeSeparation: 0, convergence: 4, layout: 'side-by-side', swapEyes: false },
      }),
    );
    // +0 and -0 shifts are the same GPU value.
    const matrix = (camera: CameraSnapshot | undefined) =>
      Array.from(cameraLensProjection(camera as CameraSnapshot), (value) => value + 0);
    expect(matrix(left)).toEqual(matrix(right));
    expect(Array.from(left?.world ?? [])).toEqual(Array.from(right?.world ?? []));
  });
});

describe('StereoCamera layout', () => {
  const stereo = (layout: StereoCameraSnapshot['layout'], swapEyes = false) => ({
    eyeSeparation: 0.1,
    convergence: 3,
    layout,
    swapEyes,
  });
  it('splits the outer CameraView rectangle', () => {
    const outer = [0.2, 0.1, 0.6, 0.8];
    const round = (v: Float32Array) => Array.from(v, (x) => Math.round(x * 1e6) / 1e6);
    expect(round(stereoEyeViewport(outer, stereo('side-by-side'), 'left'))).toEqual([
      0.2, 0.1, 0.3, 0.8,
    ]);
    expect(round(stereoEyeViewport(outer, stereo('side-by-side'), 'right'))).toEqual([
      0.5, 0.1, 0.3, 0.8,
    ]);
    expect(round(stereoEyeViewport(outer, stereo('top-bottom'), 'left'))).toEqual([
      0.2, 0.1, 0.6, 0.4,
    ]);
    expect(round(stereoEyeViewport(outer, stereo('top-bottom'), 'right'))).toEqual([
      0.2, 0.5, 0.6, 0.4,
    ]);
    expect(round(stereoEyeViewport(outer, stereo('side-by-side', true), 'left'))).toEqual([
      0.5, 0.1, 0.3, 0.8,
    ]);
    expect(round(stereoEyeViewport(outer, stereo('anaglyph'), 'right'))).toEqual(
      round(new Float32Array(outer)),
    );
  });

  it('derives the eye physical aspect before the off-axis term', () => {
    const camera = snapshot({ entityKey: 7, autoAspect: true } as Partial<CameraSnapshot>);
    const eye = cameraForView([camera], 7, { width: 320, height: 360, eye: 'right' });
    expect(eye?.aspect).toBeCloseTo(320 / 360, 6);
    expect(eye?.eye?.side).toBe('right');
    expect(eye?.eye?.frustumShift).toBeCloseTo(
      stereoFrustumShift(camera.stereo as StereoCameraSnapshot, 'right', camera.fov, 320 / 360),
      9,
    );
    expect(renderFeatureViewIdentity(eye)).toBe('camera:7:right');
    expect(renderFeatureViewIdentity(camera)).toBe('camera:7');
  });
});

describe('StereoCamera World extraction', () => {
  const spawn = (stereo: Partial<StereoCameraData>, view = false) => {
    const world = new World();
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 1, 5] } },
        { component: Camera, data: { fov: Math.PI / 3, near: 0.1, far: 100 } },
        { component: StereoCamera, data: stereo as never },
        ...(view ? [{ component: CameraView, data: { viewport: [0, 0, 0.5, 1] } } as never] : []),
      )
      .unwrap();
    propagateTransforms(world).unwrap();
    return { world, entity: Number(entity) };
  };

  it('composes a full-screen view and carries validated stereo facts', () => {
    const { world, entity } = spawn({ eyeSeparation: 0.1, convergence: 3 });
    const display = selectCameraRoles(world, entity).display;
    expect(display[0]?.view?.viewport).toEqual(new Float32Array([0, 0, 1, 1]));
    expect(display[0]?.stereo).toEqual({
      eyeSeparation: expect.closeTo(0.1, 6),
      convergence: 3,
      layout: 'side-by-side',
      swapEyes: false,
    });
    const eye = selectCameraRoles(world, entity, { width: 100, height: 200, eye: 'left' })
      .display[0];
    expect(eye?.eye?.side).toBe('left');
    expect(eye?.position[0]).toBeCloseTo(-0.05, 6);
  });

  it('keeps an authored CameraView rectangle as the outer stereo rectangle', () => {
    const { world, entity } = spawn({ layout: StereoLayoutValue['top-bottom'] }, true);
    const camera = selectCameraRoles(world, entity).display[0];
    expect(camera?.view?.viewport).toEqual(new Float32Array([0, 0, 0.5, 1]));
    expect(camera?.stereo?.layout).toBe('top-bottom');
  });

  it.each([
    [{ eyeSeparation: -0.1 }, 'eyeSeparation'],
    [{ eyeSeparation: Number.POSITIVE_INFINITY }, 'eyeSeparation'],
    [{ convergence: 0.1 }, 'convergence'],
    [{ convergence: 0.05 }, 'convergence'],
  ] as const)('rejects %o with field %s', (data, field) => {
    const { world, entity } = spawn(data);
    let caught: unknown;
    try {
      selectCameraRoles(world, entity);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StereoCameraInvalidError);
    const error = caught as StereoCameraInvalidError;
    expect(error.code).toBe('stereo-camera-invalid');
    expect(error.detail.field).toBe(field);
    expect(error.expected).toBeTypeOf('string');
    expect(error.hint).toBeTypeOf('string');
  });

  it('rejects orthographic, targeted and reflected cameras', () => {
    const base = {
      eyeSeparation: 0.1,
      convergence: 3,
      layout: StereoLayoutValue['side-by-side'],
      swapEyes: false,
    };
    const context = {
      projection: 'perspective',
      near: 0.1,
      target: false,
      planarReflection: false,
    };
    expect(() =>
      resolveStereoCamera(base, { ...context, projection: 'orthographic' } as never),
    ).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ field: 'projection' }) }),
    );
    expect(() => resolveStereoCamera(base, { ...context, target: true } as never)).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ field: 'target' }) }),
    );
    expect(() =>
      resolveStereoCamera(base, { ...context, planarReflection: true } as never),
    ).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ field: 'planarReflection' }) }),
    );
    expect(() => resolveStereoCamera({ ...base, layout: 9 }, context as never)).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ field: 'layout' }) }),
    );
  });
});
