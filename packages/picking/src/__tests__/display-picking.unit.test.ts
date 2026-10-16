import type { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import {
  attachBarrelDistortionCameraFrame,
  createBarrelDistortionMapping,
} from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import {
  computeDisplayScreenRay,
  displayToScenePixel,
  pickDisplay,
  pickVertexDisplay,
  pickVertexOnEntityDisplay,
} from '../display-picking';

describe('display picking frame authority', () => {
  it('uses the accepted identity frame after an unrendered camera mutation', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, undefined).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
      },
    );
    // A live World fallback would throw here. The submitted camera matrices
    // remain the sole source for the displayed frame after a later mutation.
    const mutatedWorld = {
      get: () => {
        throw new Error('unrendered camera state must not be read');
      },
    } as unknown as World;
    const ray = computeDisplayScreenRay(mutatedWorld, 17 as never, 320, 180, mapping, 640, 360);
    expect(ray).toBeDefined();
  });

  it('uses the submitted camera matrices for the display ray', () => {
    const viewMatrix = mat4.create();
    viewMatrix[12] = -0.5;
    const projectionMatrix = mat4.create();
    projectionMatrix[0] = 0.75;
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(64, 64, undefined).unwrap(),
      {
        projection: 'orthographic',
        far: 100,
        viewMatrix,
        projectionMatrix,
      },
    );
    const world = {
      get: () => {
        throw new Error('display picking must use the accepted mapping');
      },
    } as unknown as World;
    const ray = computeDisplayScreenRay(world, 17 as never, 32, 32, mapping, 64, 64);
    expect(ray).toMatchObject({ projectionKind: 'orthographic' });
    expect(ray).toBeDefined();
    if (ray === undefined) return;
    expect(Array.from(ray.view)).toEqual(Array.from(viewMatrix));
    expect(Array.from(ray.proj)).toEqual(Array.from(projectionMatrix));
  });

  it('rejects a display query without an accepted frame context', () => {
    const world = {
      get: () => {
        throw new Error('missing frame context must not consult World');
      },
    } as unknown as World;
    expect(
      computeDisplayScreenRay(world, 17 as never, 10, 10, undefined, 640, 360),
    ).toBeUndefined();
  });

  it('rejects a viewport that disagrees with the submitted mapping extent', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, undefined).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
      },
    );
    const world = {} as World;
    expect(
      computeDisplayScreenRay(world, 17 as never, 640, 360, mapping, 1280, 720),
    ).toBeUndefined();
    const out = { x: 0, y: 0 };
    expect(displayToScenePixel(out, undefined, 10, 10)).toBe(false);
  });

  it('uses caller-normalized DPR and embedded offsets while rejecting crop misses', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, undefined).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
      },
    );
    const world = {} as World;
    const embeddedOffset = { left: 37, top: 19 };
    const devicePixelRatio = 2;
    const cssPoint = { x: embeddedOffset.left + 160, y: embeddedOffset.top + 90 };
    const submittedPixel = {
      x: (cssPoint.x - embeddedOffset.left) * devicePixelRatio,
      y: (cssPoint.y - embeddedOffset.top) * devicePixelRatio,
    };

    // Offset/DPR normalization belongs to the host display adapter. The
    // public picking API consumes the resulting physical pixel against the
    // accepted submitted extent.
    expect(
      computeDisplayScreenRay(
        world,
        17 as never,
        submittedPixel.x,
        submittedPixel.y,
        mapping,
        640,
        360,
      ),
    ).toBeDefined();
    expect(
      computeDisplayScreenRay(world, 17 as never, -1, submittedPixel.y, mapping, 640, 360),
    ).toBeUndefined();
    expect(
      computeDisplayScreenRay(world, 17 as never, 640, submittedPixel.y, mapping, 640, 360),
    ).toBeDefined();
    expect(
      computeDisplayScreenRay(world, 17 as never, 641, submittedPixel.y, mapping, 640, 360),
    ).toBeUndefined();
    // A DPR-sized viewport is a different submitted extent and must fail
    // closed instead of silently selecting a second display mapping.
    expect(
      computeDisplayScreenRay(
        world,
        17 as never,
        submittedPixel.x,
        submittedPixel.y,
        mapping,
        1280,
        720,
      ),
    ).toBeUndefined();
  });

  it('fails closed for omitted display context across every display entrypoint', () => {
    const world = {
      get: () => {
        throw new Error('missing frame context must not consult World');
      },
    } as unknown as World;
    expect(pickDisplay(world, 10, 10, undefined, 640, 360)).toBeUndefined();
    expect(pickVertexDisplay(world, 17 as never, 10, 10, undefined, 640, 360)).toBeUndefined();
    expect(
      pickVertexOnEntityDisplay(world, 17 as never, 10, 10, undefined, 640, 360, 18 as never),
    ).toBeUndefined();
  });
});
