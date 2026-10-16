// shadow-csm-orthoz.test.ts - bug-20260619-csm-multi-cascade-directional-shadow-broken
// M1 / AC-05 (RED): the per-cascade orthographic Z range must reach toward the
// light so a caster sitting BETWEEN the light and the visible frustum slice is
// captured in that cascade's depth map (classic "missing caster" CSM bug).
//
// This test drives the REAL extract cascade-fit path (NOT a local copy): it
// builds a World, prepares its fresh context, calls extractFrame, and reads the actual per-cascade
// lightViewProj matrix the engine produced at render-system-extract.ts:1581.
// It then projects a world-space caster point offset toward the light source
// through that matrix and asserts the resulting clip-space z is inside the
// WebGPU depth clip volume [0,1].
//
// Why this is RED today: extract fits the ortho near/far to ONLY the visible
// slice corners (`-maxZ / -minZ`), with no extension toward the light. An
// occluder hovering between the sun and the shadow-receiving ground lands in
// front of the ortho near plane in the cascade that covers that ground -> its
// projected z < 0 -> clipped out -> never written to the cascade depth tile ->
// the ground fragment (which `_pickCascadeLayer` routes to that same cascade)
// reads "no occluder" -> no shadow. The N=4 case is worse than N=1 because the
// thinner near slice gives an even tighter Z range. RC-2 (M3) extends the Z
// toward the light and turns these green. Falsification for RC-2: comment out
// the z-extend and these reassert RED.

import { World } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

// Light travelling down and toward +x/+z, so the source is up and toward -x/-z.
const LIGHT_DIR: readonly [number, number, number] = [0.3, -1, 0.3];

// A ground point inside the near cascade's footprint (verified XY-covered by
// cascade 0 for both N=1 and N=4 with the camera/light below).
const GROUND_PT: readonly [number, number, number] = [0, 0, -5];

function setupWorld(cascadeCount: number): World {
  const world = new World();
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: [LIGHT_DIR[0], LIGHT_DIR[1], LIGHT_DIR[2]],
      cascadeCount,
      shadowDistance: 100,
    },
  });
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );

  return world;
}

// A world-space occluder above GROUND_PT, pushed toward the light source
// (opposite the light travel direction). Physically: a box hovering between the
// sun and the ground -- it MUST be in the cascade depth map for the ground
// beneath it to be shadowed.
function towardLightCaster(distanceTowardLight: number): vec3.Vec3 {
  const lightDirN = vec3.normalize(vec3.create(), vec3.create(...LIGHT_DIR));
  const groundPt = vec3.create(...GROUND_PT);
  const offset = vec3.scale(vec3.create(), lightDirN, -distanceTowardLight);
  return vec3.add(vec3.create(), groundPt, offset);
}

interface Projected {
  inXY: boolean;
  z: number;
}

function projectInto(lightViewProj: Float32Array, worldPt: vec3.Vec3): Projected {
  const ndc = vec3.create();
  mat4.transformVec3(ndc, lightViewProj, worldPt);
  const x = ndc[0] ?? Number.NaN;
  const y = ndc[1] ?? Number.NaN;
  const z = ndc[2] ?? Number.NaN;
  return { inXY: x >= -1 && x <= 1 && y >= -1 && y <= 1, z };
}

describe('CSM ortho-Z reaches toward the light (real extract fit, AC-05)', () => {
  // N=4 is the primary RED case: the thin near slice gives a tight ortho Z, so a
  // toward-light occluder over near-cascade ground is clipped (z < 0).
  it('N=4: the cascade covering the ground also captures a toward-light caster (z in [0,1])', () => {
    const world = setupWorld(4);
    const frame = extractFrame(world, prepareExtractContext(world));
    const lvp = frame.lights.lightViewProj;
    expect(lvp).toBeDefined();
    if (lvp === undefined) return;
    const count = frame.lights.cascadeCount ?? 0;
    expect(count).toBe(4);

    const caster = towardLightCaster(6);
    const ground = vec3.create(...GROUND_PT);

    // Find every cascade whose XY footprint covers the GROUND fragment -- that
    // is the cascade `_pickCascadeLayer` will route the ground to. The caster
    // sits directly above that ground, so the SAME cascade must also hold the
    // caster's depth, otherwise the ground reads "unoccluded".
    let coveredGroundCascades = 0;
    for (let c = 0; c < count; c++) {
      const m = lvp[c];
      if (!(m instanceof Float32Array)) continue;
      const g = projectInto(m, ground);
      if (!g.inXY) continue;
      coveredGroundCascades++;
      const { z } = projectInto(m, caster);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
    }
    // Guard against a vacuous assertion: at least one cascade must cover the
    // ground fragment.
    expect(coveredGroundCascades).toBeGreaterThan(0);
  });

  it('N=4: near cascade (0) covers the ground and must admit the toward-light caster', () => {
    const world = setupWorld(4);
    const frame = extractFrame(world, prepareExtractContext(world));
    const lvp = frame.lights.lightViewProj;
    expect(lvp).toBeDefined();
    if (lvp === undefined) return;

    const m0 = lvp[0];
    expect(m0).toBeInstanceOf(Float32Array);
    if (!(m0 instanceof Float32Array)) return;

    // Cascade 0 covers GROUND_PT in XY (precondition for this assertion to
    // matter).
    const ground = projectInto(m0, vec3.create(...GROUND_PT));
    expect(ground.inXY).toBe(true);

    const { z } = projectInto(m0, towardLightCaster(6));
    expect(z).toBeGreaterThanOrEqual(0);
    expect(z).toBeLessThanOrEqual(1);
  });
});
