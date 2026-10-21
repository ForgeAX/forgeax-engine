// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
} from '@forgeax/engine-render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CameraProjection,
  cameraProjectionFromF32,
} from '../../../render/src/components/camera';

function componentFieldType(component: { fields: Record<string, { type: string }> }, name: string) {
  return component.fields[name]?.type;
}
afterEach(() => vi.restoreAllMocks());
{
  // --- from camera-ortho.test.ts ---

  // Column-major 4x4 matrix-vector multiply (mat4 is column-major per
  // @forgeax/engine-math types.ts SSOT). Returns [cx, cy, cz, cw].
  function mulMat4Vec4(
    m: Mat4Like,
    v: readonly [number, number, number, number],
  ): [number, number, number, number] {
    const [x, y, z, w] = v;
    return [
      (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number) * w,
      (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number) * w,
      (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number) * w,
      (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number) * w,
    ];
  }

  describe('Camera schema (33 fields: projection, exposure, color grading, post-process, target, targetLayer, clearColor, and aspect-sync)', () => {
    it('Camera.schema has 33 fields including auto exposure and color grading state', () => {
      expect(Object.keys(Camera.fields).length).toBe(33);
      expect(componentFieldType(Camera, 'targetLayer')).toBe('u32');
      expect(componentFieldType(Camera, 'fov')).toBe('f32');
      expect(componentFieldType(Camera, 'aspect')).toBe('f32');
      expect(componentFieldType(Camera, 'near')).toBe('f32');
      expect(componentFieldType(Camera, 'far')).toBe('f32');
      expect(componentFieldType(Camera, 'projection')).toBe('f32');
      expect(componentFieldType(Camera, 'left')).toBe('f32');
      expect(componentFieldType(Camera, 'right')).toBe('f32');
      expect(componentFieldType(Camera, 'bottom')).toBe('f32');
      expect(componentFieldType(Camera, 'top')).toBe('f32');
      // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.2 (AC-01 + D-1).
      expect(componentFieldType(Camera, 'tonemap')).toBe('f32');
      expect(componentFieldType(Camera, 'exposure')).toBe('f32');
      // feat-20260827-auto-exposure-hdr-color-grading: exposure control state.
      expect(componentFieldType(Camera, 'exposureMode')).toBe('f32');
      expect(componentFieldType(Camera, 'compensationEv')).toBe('f32');
      expect(componentFieldType(Camera, 'rangeEv')).toBe('array<f32, 2>');
      expect(componentFieldType(Camera, 'rates')).toBe('array<f32, 2>');
      expect(componentFieldType(Camera, 'whitePoint')).toBe('f32');
      expect(componentFieldType(Camera, 'temperature')).toBe('f32');
      expect(componentFieldType(Camera, 'tint')).toBe('f32');
      expect(componentFieldType(Camera, 'colorLut')).toBe('asset<texture>');
      expect(componentFieldType(Camera, 'colorLutStrength')).toBe('f32');
      expect(componentFieldType(Camera, 'antialias')).toBe('f32');
      expect(componentFieldType(Camera, 'historyVersion')).toBe('u32');
      // feat-20260531-bloom-first-declarative-render-graph-pass / w2.
      expect(componentFieldType(Camera, 'bloom')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomThreshold')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomIntensity')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomSmoothWidth')).toBe('f32');
      expect(componentFieldType(Camera, 'bloomRadius')).toBe('f32');
      // feat-20260709 M3 / D-3: clear-color collapsed into one array<f32,4>.
      expect(componentFieldType(Camera, 'clearColor')).toBe('array<f32, 4>');
      // feat-20260617-host-engine-contract-and-video-cutscene / M3: aspect-sync
      // opt-out flag (bool column tier).
      expect(componentFieldType(Camera, 'autoAspect')).toBe('bool');
      // feat-20260927-order-independent-transparency: sorted vs weighted blended.
      expect(componentFieldType(Camera, 'transparency')).toBe('f32');
    });
  });

  describe('Camera.projection discriminator narrowing (AC-16)', () => {
    it('cameraProjectionFromF32 narrows 0 to perspective, 1 to orthographic', () => {
      const p: CameraProjection = cameraProjectionFromF32(CAMERA_PROJECTION_PERSPECTIVE);
      const o: CameraProjection = cameraProjectionFromF32(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(p).toBe('perspective');
      expect(o).toBe('orthographic');
    });

    it('defensive fall-back: unknown discriminator values narrow to perspective', () => {
      expect(cameraProjectionFromF32(2)).toBe('perspective');
      expect(cameraProjectionFromF32(-1)).toBe('perspective');
      expect(cameraProjectionFromF32(Number.NaN)).toBe('perspective');
    });

    it('world.spawn with orthographic data stores all 9 f32 fields losslessly', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: 0,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
            left: -10,
            right: 10,
            bottom: -10,
            top: 10,
          },
        })
        .unwrap();
      const r = world.get(e, Camera).unwrap();
      expect(r.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(r.left).toBe(-10);
      expect(r.right).toBe(10);
      expect(r.bottom).toBe(-10);
      expect(r.top).toBe(10);
      expect(cameraProjectionFromF32(r.projection)).toBe('orthographic');
    });
  });

  describe('Orthographic projection matrix NDC z ∈ [0, 1] (AC-16 numeric precision)', () => {
    it('point on the near plane maps to NDC z = 0', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -0.1, 1]);
      const ndcZ = clip[2] / clip[3];
      expect(ndcZ).toBeCloseTo(0, 5);
    });

    it('point on the far plane maps to NDC z = 1', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -100, 1]);
      const ndcZ = clip[2] / clip[3];
      expect(ndcZ).toBeCloseTo(1, 5);
    });

    it('point at the center of the ortho view maps to NDC x = 0 and y = 0', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -50, 1]);
      expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
    });

    it('off-center point maps to the expected NDC x/y inside [-1, 1]', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, 10, -10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [5, -5, -50, 1]);
      // x = 5 sits at 0.5 of the ortho half-extent 10
      expect(clip[0] / clip[3]).toBeCloseTo(0.5, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(-0.5, 5);
    });

    it('asymmetric ortho bounds preserve linear mapping to NDC [-1, 1] x/y', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, 0, 20, 10, 0, 0.1, 100);
      // midpoint of [0, 20] x [0, 10] = (10, 5) should map to NDC (0, 0)
      const clip = mulMat4Vec4(proj, [10, 5, -50, 1]);
      expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
    });
  });
}
