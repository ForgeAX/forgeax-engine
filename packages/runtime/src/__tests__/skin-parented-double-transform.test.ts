// @ts-nocheck -- node:fs / node:path / node:url imports outside @types/node
// bug-20260615-skin-mesh-node-double-transform M0 / m0-1 (AC-01).
//
// AC-01 red-then-green unit test: construct a minimal scene with
//   parent: Transform { posZ = 5 }
//   skinEntity: ChildOf { parent }, Skin { joints: [jointEntity] }
//   jointEntity: Transform { identity } (also child of parent)
//   IBM = identity (joint at origin in bind pose)
//   vertex position = (0,0,0), skinIndex = 0, skinWeight = 1
//
// After propagateTransforms, the joint's world mat4 = parent (z=5),
// the skin entity's world mat4 = parent (z=5). The palette is
// palette = jointWorld * IBM = parent * I = parent.
//
// Current shader math (line 182):
//   world = meshes[0].worldFromLocal * instanceLocal * (palette * pos)
//         = parent * I * (parent * (0,0,0,1)^T)
//       -> world.z = 10  (double transform, BUG).
//
// Spec-correct shader math (line 60 comment / glTF 2.0 sec.Skins):
//   world = palette * pos
//         = parent * (0,0,0,1)^T
//       -> world.z = 5  (rigid-follow).
//
// This test simulates both paths in pure TypeScript (no GPU).
// The BUG repro assertion PASSES today (current math -> z=10).
// The AC-01 contract assertion FAILS today (current math -> expects
// z=5 per spec, but produces z=10). M1's shader patch will update the
// AC-01 test to use correct math -> z=5 -> green.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import type { Mat4, Vec3 } from '@forgeax/engine-math';
import { mat4, vec3 } from '@forgeax/engine-math';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Build mat4 from a Float32Array (16 floats column-major).
 * Copies into a new mat4 by writing internal number[] directly.
 */
function mat4FromFloat32Array(arr: Float32Array): Mat4 {
  const nums = Array.from(arr) as number[];
  const m = mat4.create();
  // Column-major indexing:
  // col0: 0,1,2,3  col1: 4,5,6,7  col2: 8,9,10,11  col3: 12,13,14,15
  const mn = m as unknown as number[];
  for (let i = 0; i < 16; i++) {
    mn[i] = nums[i] ?? 0;
  }
  return m;
}

/**
 * Simulate the CURRENT shader vertex math (buggy, line 182).
 *
 *   world = meshes[0].worldFromLocal * instanceLocal * (palette * pos4)
 *   instanceLocal = identity
 */
function shaderCurrentWorld(
  meshWorldFromLocal: Mat4,
  palette: Mat4,
  localPos: readonly number[],
): Vec3 {
  const skinnedLocal = vec3.create(0, 0, 0);
  const pos4 = vec3.create(localPos[0] ?? 0, localPos[1] ?? 0, localPos[2] ?? 0);
  mat4.transformVec3(skinnedLocal, palette, pos4);
  const world = vec3.create(0, 0, 0);
  mat4.transformVec3(world, meshWorldFromLocal, skinnedLocal);
  return world;
}

/**
 * Simulate the SPEC-CORRECT shader vertex math (glTF 2.0 sec.Skins).
 *
 *   world = palette * pos4
 *
 * The palette already encodes full world-space joint transforms
 * (jointWorld_i * IBM_i, pre-computed host-side with propagateTransforms).
 * No additional meshes[0].worldFromLocal left-multiply is needed.
 *
 * @internal exported for AC-01 contract test (M1 green flip)
 */
export function shaderSpecCorrectWorld(palette: Mat4, localPos: readonly number[]): Vec3 {
  const pos4 = vec3.create(localPos[0] ?? 0, localPos[1] ?? 0, localPos[2] ?? 0);
  const world = vec3.create(0, 0, 0);
  mat4.transformVec3(world, palette, pos4);
  return world;
}

// ── tests ────────────────────────────────────────────────────────────────

describe('skin parented double transform (AC-01)', () => {
  it('current shader math double-transforms ancestor (BUG repro)', () => {
    const world = new World();

    // Parent at z=5.
    const parent = world.spawn({ component: Transform, data: { pos: [0, 0, 5] } }).unwrap();

    // Joint entity: identity local, also child of parent.
    const jointEntity = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    // Skin entity: identity local, child of parent, Skin with one joint.
    const skinEntity = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        {
          component: Skin,
          data: {
            skeleton: 123 as unknown as never, // unused in math-only test
            joints: new Uint32Array([jointEntity as unknown as number]),
          },
        },
      )
      .unwrap();

    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);

    // Read derived GlobalTransform.world for skin entity and joint entity.
    const st = world.get(skinEntity, GlobalTransform);
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    const meshWorldMat = mat4FromFloat32Array(st.value.world as unknown as Float32Array);

    const jt = world.get(jointEntity, GlobalTransform);
    expect(jt.ok).toBe(true);
    if (!jt.ok) return;
    const jointWorldMat = mat4FromFloat32Array(jt.value.world as unknown as Float32Array);

    // Verify propagate produced correct worlds: both should be z=5.
    const mn = meshWorldMat as unknown as number[];
    const jn = jointWorldMat as unknown as number[];
    expect(mn[14]).toBeCloseTo(5, 5);
    expect(jn[14]).toBeCloseTo(5, 5);

    // IBM = identity (joint at origin in bind pose).
    const ibm = mat4.create();
    mat4.identity(ibm);

    // palette = jointWorld * IBM = parent.
    const palette = mat4.create();
    mat4.multiply(palette, jointWorldMat, ibm);

    // Vertex at origin.
    const vertexPos = [0, 0, 0] as const;

    // Current shader: world = meshWorld * instanceLocal * (palette * pos).
    const bugWorld = shaderCurrentWorld(meshWorldMat, palette, vertexPos);

    // With parent T(0,0,5): parent * parent * origin = (0,0,10).
    // BUG: world.z should be 10, not 5.
    expect(bugWorld[0]).toBeCloseTo(0, 5);
    expect(bugWorld[1]).toBeCloseTo(0, 5);
    expect(bugWorld[2]).toBeCloseTo(10, 5);
  });

  it('spec-correct shader math (post-M1) rigid-follows parent (AC-01)', () => {
    // This assertion codifies the AC-01 contract.
    //
    // AFTER M1's shader fix (line 182: world = skinnedLocal), the shader
    // no longer left-multiplies by meshes[0].worldFromLocal. We simulate
    // the CORRECTED math (shaderSpecCorrectWorld), which matches glTF 2.0
    // sec.Skins: world = palette * pos -- the palette already encodes
    // full world-space joint transforms, so a vertex at origin with parent
    // at z=5 lands at world.z=5 (rigid-follow via palette alone).

    const world = new World();

    // Parent at z=5.
    const parent = world.spawn({ component: Transform, data: { pos: [0, 0, 5] } }).unwrap();

    // Joint entity: identity local, child of parent.
    const jointEntity = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    // Skin entity: identity local, child of parent, Skin with one joint.
    // (unused in corrected-math path -- mesh node world not needed).
    void world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        {
          component: Skin,
          data: {
            skeleton: 123 as unknown as never,
            joints: new Uint32Array([jointEntity as unknown as number]),
          },
        },
      )
      .unwrap();

    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);

    const jt = world.get(jointEntity, GlobalTransform);
    expect(jt.ok).toBe(true);
    if (!jt.ok) return;
    const jointWorldMat = mat4FromFloat32Array(jt.value.world as unknown as Float32Array);

    // Verify propagate correctness.
    const jn = jointWorldMat as unknown as number[];
    expect(jn[14]).toBeCloseTo(5, 5);

    // IBM = identity.
    const ibm = mat4.create();
    mat4.identity(ibm);

    // palette = jointWorld * IBM = parent.
    const palette = mat4.create();
    mat4.multiply(palette, jointWorldMat, ibm);

    // Vertex at origin.
    const vertexPos = [0, 0, 0] as const;

    // Simulate the CORRECTED (M1) shader math: world = palette * pos.
    const worldPos = shaderSpecCorrectWorld(palette, vertexPos);

    // AC-01 contract: vertex at origin with parent at z=5 lands at z=5
    // (rigid-follows parent via palette alone).
    expect(worldPos[0]).toBeCloseTo(0, 5);
    expect(worldPos[1]).toBeCloseTo(0, 5);
    expect(worldPos[2]).toBeCloseTo(5, 5);
  });

  // F-1 (round 1 minor-edit): WGSL source-grep gate. The CPU simulation tests
  // above assert the math contract, but they are decoupled from the actual
  // WGSL shader. To catch a future revert of M1's shader patch, assert the
  // shader source contains the spec-correct form and does NOT contain the
  // pre-M1 buggy left-multiply chain. Same pattern as
  // skin-extract-getarrayview-count.unit.test.ts (M2's grep gate for AC-03).
  it('default-standard-pbr-skin.wgsl encodes spec-correct skin math (AC-01 source gate)', () => {
    const shaderPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../shader/src/default-standard-pbr-skin.wgsl',
    );
    const src = readFileSync(shaderPath, 'utf8');

    // Pre-M1 buggy form: world = meshes[0].worldFromLocal * instanceLocal * skinnedLocal.
    // If this regex matches anywhere in the file (outside comments), the shader
    // is double-transforming again.
    const buggyChain = /meshes\[0\]\.worldFromLocal\s*\*\s*instanceLocal\s*\*\s*skinnedLocal/;
    expect(src).not.toMatch(buggyChain);

    // Pre-M1 buggy normal form: mat3(instanceLocal) * meshes[0].normalMatrix * skinNormal3x3.
    const buggyNormal = /meshes\[0\]\.normalMatrix\s*\*\s*skinNormal3x3/;
    expect(src).not.toMatch(buggyNormal);

    // Post-M1 spec-correct form: world position is skinnedLocal directly.
    // Match `out.worldPos = skinnedLocal.xyz` (line 198 post-M1).
    const specCorrectWorldPos = /out\.worldPos\s*=\s*skinnedLocal\.xyz/;
    expect(src).toMatch(specCorrectWorldPos);

    // Post-M1 spec-correct normal: only skinNormal3x3 * in.normal (no instanceLocal /
    // normalMatrix factor).
    const specCorrectNormal = /out\.worldNormal\s*=\s*normalize\(skinNormal3x3\s*\*\s*in\.normal\)/;
    expect(src).toMatch(specCorrectNormal);
  });
});
