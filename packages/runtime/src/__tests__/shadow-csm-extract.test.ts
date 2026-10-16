// shadow-csm-extract.test.ts — feat-20260621-merge-directionallightshadow-into-directionallight M2
// TDD red test: castShadow gate + ExtractedLights bias/PCF fields.
//
// After M1 (component merge), DirectionalLight carries the 9 shadow fields
// and castShadow:bool (default true).
// This test asserts the extract stage:
//   (a) castShadow:true  → CSM path runs (lightViewProj + cascades populated)
//   (b) castShadow:false → CSM path skipped (no cascade output)
//   (c) ExtractedLights carries depthBias/normalBias and accepted filter quality
//   (d) bias/filter fields are undefined when castShadow:false
// RED before m2-t2/m2-t3: extract still queries the deleted
// castShadow: true; lightViewProj won't populate.

import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  type CsmCameraData,
  computeDirectionalCsm,
  prepareExtractContext,
} from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

function makeWorld(castShadow?: boolean): World {
  const world = new World();
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [0, -1, 0],
      castShadow: castShadow ?? true,
      depthBias: 0.01,
      normalBias: 0.08,
      shadowFilter: 3,
      shadowAngularRadius: 0.01,
      maxPenumbraTexels: 48,
    },
  });
  world.spawn(
    { component: Transform, data: {} },
    {
      component: Camera,
      data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 },
    },
  );
  return world;
}

describe('ExtractedLights interface (M2 castShadow gate)', () => {
  describe('castShadow=true (default): CSM path runs', () => {
    it('lightViewProj is an array of 4 Float32Array mat4s', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      const { lightViewProj } = frame.lights;
      expect(lightViewProj).toBeDefined();
      if (lightViewProj === undefined) return;
      expect(Array.isArray(lightViewProj)).toBe(true);
      expect(lightViewProj.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        const m = lightViewProj[i];
        expect(m).toBeInstanceOf(Float32Array);
        expect(m).toHaveLength(16);
      }
    });

    it('splitPlanes is a Float32Array of four vec4 metric lanes', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      const { splitPlanes } = frame.lights;
      expect(splitPlanes).toBeDefined();
      if (splitPlanes === undefined) return;
      expect(splitPlanes).toBeInstanceOf(Float32Array);
      expect(splitPlanes.length).toBe(16);
      for (let i = 0; i < 4; i++) {
        const v = splitPlanes[i * 4];
        expect(typeof v).toBe('number');
        expect(Number.isFinite(v)).toBe(true);
      }
    });

    it('cascadeCount and cascadeBlend scalars match component defaults', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.cascadeCount).toBe(4);
      expect(frame.lights.cascadeBlend).toBeCloseTo(0.2, 5);
    });
  });

  describe('castShadow=false: CSM path skipped', () => {
    it('lightViewProj is undefined when castShadow=false', () => {
      const world = makeWorld(false);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.lightViewProj).toBeUndefined();
    });

    it('splitPlanes, cascadeCount, cascadeBlend are undefined', () => {
      const world = makeWorld(false);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.splitPlanes).toBeUndefined();
      expect(frame.lights.cascadeCount).toBeUndefined();
      expect(frame.lights.cascadeBlend).toBeUndefined();
    });
  });

  describe('ExtractedLights carries bias and accepted Directional quality', () => {
    it('depthBias populated when castShadow=true', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.depthBias).toBeCloseTo(0.01, 5);
    });

    it('normalBias populated when castShadow=true', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.normalBias).toBeCloseTo(0.08, 5);
    });

    it('accepted Directional quality is populated when castShadow=true', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.directionalShadowQuality).toEqual({ kind: 'pcf', kernel: 5 });
    });

    it('quality is undefined when castShadow=false', () => {
      const world = makeWorld(false);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.depthBias).toBeUndefined();
      expect(frame.lights.normalBias).toBeUndefined();
      expect(frame.lights.directionalShadowQuality).toBeUndefined();
    });

    it('withholds an invalid PCSS candidate and exposes a structured error', () => {
      const world = new World();
      const spawned = world.spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          shadowFilter: 4,
          shadowAngularRadius: 999,
          maxPenumbraTexels: 32,
        },
      });
      expect(spawned.ok).toBe(true);
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );

      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.directionalShadowError?.code).toBe('shadow-invalid-config');
      expect(frame.lights.directionalShadowError?.detail).toMatchObject({
        field: 'shadowAngularRadius',
        actual: 999,
      });
      expect(frame.lights.directionalShadowQuality).toBeUndefined();
      expect(frame.lights.directionalCsmConfig).toBeUndefined();
      expect(frame.lights.lightViewProj).toBeUndefined();
    });
  });

  describe('N=1 (single cascade degeneracy)', () => {
    it('lightViewProj[0] valid, [1..3] zero matrices', () => {
      const world = new World();
      world.spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          cascadeCount: 1,
          shadowDistance: 100,
        },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );

      const frame = extractFrame(world, prepareExtractContext(world));
      const { lightViewProj, cascadeCount } = frame.lights;
      expect(cascadeCount).toBe(1);
      expect(lightViewProj).toBeDefined();
      if (lightViewProj === undefined) return;
      expect(lightViewProj.length).toBe(4);

      const m0 = lightViewProj[0];
      expect(m0).toBeInstanceOf(Float32Array);
      expect(m0).toHaveLength(16);
      if (m0 !== undefined) {
        const m0NonZero = Array.from(m0).some((v) => v !== 0);
        expect(m0NonZero).toBe(true);
      }

      for (let i = 1; i < 4; i++) {
        const m = lightViewProj[i];
        if (m !== undefined) {
          expect(m).toBeInstanceOf(Float32Array);
          expect(m).toHaveLength(16);
          const allZero = Array.from(m).every((v) => v === 0);
          expect(allZero).toBe(true);
        }
      }
    });
  });

  describe('lightSpaceMatrix deleted', () => {
    it('ExtractedLights does not have lightSpaceMatrix property', () => {
      const world = makeWorld(true);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect('lightSpaceMatrix' in frame.lights).toBe(false);
    });
  });

  describe('CSM fit derives world-scale metrics and accepts one quality projection', () => {
    function setupWorldWithQuality(shadowFilter: number): World {
      const world = new World();
      world.spawn({
        component: DirectionalLight,
        data: {
          direction: [0, -1, 0],
          cascadeCount: 1,
          shadowDistance: 100,
          shadowFilter,
          shadowAngularRadius: 0.01,
          maxPenumbraTexels: 32,
        },
      });
      world.spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      );
      return world;
    }

    it('projects PCSS quality from the same Directional query', () => {
      const world = setupWorldWithQuality(4);
      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.lights.directionalShadowQuality).toEqual({
        kind: 'pcss',
        preset: 'medium',
        angularRadiusRadians: expect.closeTo(0.01, 0.000001),
        maxPenumbraTexels: 32,
      });
    });

    it('exposes four finite vec4 cascade metric lanes from the CSM fit', () => {
      const camera: CsmCameraData = {
        world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        projection: 'perspective',
        orthoLeft: -1,
        orthoRight: 1,
        orthoBottom: -1,
        orthoTop: 1,
      };
      for (const cascadeCount of [1, 2, 3, 4]) {
        const result = computeDirectionalCsm(
          vec3.create(0, -1, 0),
          {
            cascadeCount,
            splitLambda: 0.75,
            cascadeBlend: 0.2,
            mapSize: 1024,
            shadowDistance: 100,
            shadowFilter: 3,
            shadowAngularRadius: 0.01,
            maxPenumbraTexels: 32,
          },
          camera,
        );
        expect(result).not.toBeNull();
        const lanes = result?.splitPlanes ?? new Float32Array();
        expect(lanes).toHaveLength(16);
        for (let index = 0; index < cascadeCount; index += 1) {
          expect(Number.isFinite(lanes[index * 4 + 1])).toBe(true);
          expect(lanes[index * 4 + 1]).toBeGreaterThan(0);
          expect(Number.isFinite(lanes[index * 4 + 2])).toBe(true);
          expect(lanes[index * 4 + 2]).toBeGreaterThan(0);
        }
      }
    });

    it('recomputes worldUnitsPerTexel when mapSize changes and rejects non-finite config', () => {
      const camera: CsmCameraData = {
        world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        projection: 'perspective',
        orthoLeft: -1,
        orthoRight: 1,
        orthoBottom: -1,
        orthoTop: 1,
      };
      const coarse = computeDirectionalCsm(
        vec3.create(0, -1, 0),
        {
          cascadeCount: 1,
          splitLambda: 0.75,
          cascadeBlend: 0.2,
          mapSize: 512,
          shadowDistance: 100,
          shadowFilter: 3,
          shadowAngularRadius: 0.01,
          maxPenumbraTexels: 32,
        },
        camera,
      );
      const fine = computeDirectionalCsm(
        vec3.create(0, -1, 0),
        {
          cascadeCount: 1,
          splitLambda: 0.75,
          cascadeBlend: 0.2,
          mapSize: 2048,
          shadowDistance: 100,
          shadowFilter: 3,
          shadowAngularRadius: 0.01,
          maxPenumbraTexels: 32,
        },
        camera,
      );
      // The page guard is a fixed fraction of the map, so the texel footprint
      // is exactly inverse-resolution.
      expect(fine?.splitPlanes[1]).toBeCloseTo((coarse?.splitPlanes[1] ?? 0) / 4, 5);
      expect(
        computeDirectionalCsm(
          vec3.create(0, -1, 0),
          {
            cascadeCount: 1,
            splitLambda: 0.75,
            cascadeBlend: 0.2,
            mapSize: Number.NaN,
            shadowDistance: 100,
            shadowFilter: 3,
            shadowAngularRadius: 0.01,
            maxPenumbraTexels: 32,
          },
          camera,
        ),
      ).toBeNull();
    });

    it('keeps the projection fixed within a page while responding to larger movement', () => {
      const config = {
        cascadeCount: 1,
        splitLambda: 0.75,
        cascadeBlend: 0.2,
        mapSize: 1024,
        shadowDistance: 100,
        shadowFilter: 3,
        shadowAngularRadius: 0.01,
        maxPenumbraTexels: 32,
      };
      const camera: CsmCameraData = {
        world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        projection: 'perspective',
        orthoLeft: -1,
        orthoRight: 1,
        orthoBottom: -1,
        orthoTop: 1,
      };
      const reference = computeDirectionalCsm(vec3.create(0, -1, 0), config, camera);
      expect(reference).not.toBeNull();
      const subTexelWorld = camera.world.slice();
      subTexelWorld[12] = 0.001;
      const subTexel = computeDirectionalCsm(vec3.create(0, -1, 0), config, {
        ...camera,
        world: subTexelWorld,
      });
      expect(subTexel).not.toBeNull();
      if (reference === null || subTexel === null) {
        throw new Error('CSM fit unexpectedly returned null');
      }
      const referenceMatrix = reference.lightViewProj[0];
      const subTexelMatrix = subTexel.lightViewProj[0];
      if (referenceMatrix === undefined || subTexelMatrix === undefined) {
        throw new Error('CSM fit unexpectedly omitted cascade zero');
      }
      const subTexelDelta = Math.max(
        ...referenceMatrix.map((value, index) =>
          Math.abs(value - (subTexelMatrix[index] ?? Number.NaN)),
        ),
      );
      expect(subTexelDelta).toBeLessThan(1e-5);

      // The cascade center snaps to whole pages, so movement shifts the
      // projection only after it crosses a page (1/16 of the cascade extent).
      const movedWorld = camera.world.slice();
      movedWorld[12] = 20;
      const moved = computeDirectionalCsm(vec3.create(0, -1, 0), config, {
        ...camera,
        world: movedWorld,
      });
      expect(moved).not.toBeNull();
      if (moved === null) {
        throw new Error('CSM fit unexpectedly returned null after camera movement');
      }
      const movedMatrix = moved.lightViewProj[0];
      if (movedMatrix === undefined) {
        throw new Error('CSM fit unexpectedly omitted moved cascade zero');
      }
      const movedDelta = Math.max(
        ...referenceMatrix.map((value, index) =>
          Math.abs(value - (movedMatrix[index] ?? Number.NaN)),
        ),
      );
      expect(movedDelta).toBeGreaterThan(1e-4);
    });

    it('keeps every cascade extent independent of camera rotation', () => {
      const config = {
        cascadeCount: 4,
        splitLambda: 0.75,
        cascadeBlend: 0.2,
        mapSize: 2048,
        shadowDistance: 80,
        shadowFilter: 3,
        shadowAngularRadius: 0.01,
        maxPenumbraTexels: 32,
      };
      const cameraAt = (yaw: number, pitch: number): CsmCameraData => {
        const world = mat4.create();
        mat4.invert(
          world,
          mat4.lookAt(
            mat4.create(),
            vec3.create(3, 2, 5),
            vec3.create(
              3 + Math.sin(yaw) * Math.cos(pitch),
              2 + Math.sin(pitch),
              5 - Math.cos(yaw) * Math.cos(pitch),
            ),
            vec3.create(0, 1, 0),
          ),
        );
        return {
          world,
          fov: Math.PI / 3,
          aspect: 16 / 9,
          near: 0.1,
          far: 500,
          projection: 'perspective',
          orthoLeft: -1,
          orthoRight: 1,
          orthoBottom: -1,
          orthoTop: 1,
        };
      };
      const direction = vec3.create(0.3, -1, 0.4);
      const reference = computeDirectionalCsm(direction, config, cameraAt(0, 0));
      const rotated = computeDirectionalCsm(direction, config, cameraAt(1.7, -0.6));
      if (reference === null || rotated === null) throw new Error('CSM fit returned null');
      for (let cascade = 0; cascade < 4; cascade++) {
        // Texel footprint and depth span are the only rotation-sensitive
        // quantities of a tight fit; the sphere fit keeps both bit-identical.
        expect(rotated.splitPlanes[cascade * 4 + 1]).toBe(reference.splitPlanes[cascade * 4 + 1]);
        expect(rotated.splitPlanes[cascade * 4 + 2]).toBe(reference.splitPlanes[cascade * 4 + 2]);
      }
    });
  });
});
