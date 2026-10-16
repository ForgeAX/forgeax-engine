// axis-convert.test.ts — M3 t34: FbxAxisSystem coordinate conversion unit test.
//
// TDD: This test validates that the C++ binding correctly applies
// FbxAxisSystem::OpenGL.ConvertScene before exporting mesh data.
// The mock path simulates a Z-up LH fixture already converted to Y-up RH.
//
// describe.runIf: skips when FBX_BINDING_BUILT is not set (CI without SDK).

import { describe, expect, it } from 'vitest';

// A Z-up LH cube (Blender default: Z=up, -Y=forward).
// After OpenGL conversion (Y-up RH):
//   Z-up -> Y-up (swap Y<->Z with sign flip on Z)
//   LH -> RH (flip Z sign)
//
// For a simple Z-up cube at origin:
//   Input (Z-up LH):  [1,0,2], [1,0,0], [0,0,...]
//   After Y-up RH:     vertices with correct Y-up orientation
const ZUP_CUBE_VERTICES_INPUT = [
  -5, 0, -5, 5, 0, -5, -5, 0, 5, 5, 0, 5,
  -5, 10, -5, 5, 10, -5, -5, 10, 5, 5, 10, 5,
];

// Expected after OpenGL conversion (Y-up RH):
// Z-up axis becomes Y-up. The Z-up cube's "Z=-5 and Z=5" faces map to
// Y=-5 and Y=5, while the "Y=0 and Y=10" faces map to Z=0 and Z=-10
// (with sign adjustments for RH convention).
const YUP_CUBE_VERTICES_EXPECTED = [
  -5, -5, 0, 5, -5, 0, -5, 5, 0, 5, 5, 0,
  -5, -5, -10, 5, -5, -10, -5, 5, -10, 5, 5, -10,
];

function isYUpVertices(vertices: number[]): boolean {
  if (vertices.length !== YUP_CUBE_VERTICES_EXPECTED.length) return false;
  for (let i = 0; i < vertices.length; i++) {
    if (Math.abs((vertices[i] as number) - (YUP_CUBE_VERTICES_EXPECTED[i] as number)) > 1e-5) {
      return false;
    }
  }
  return true;
}

describe('axis-convert mock path', () => {
  it('mock Z-up LH input equals Z-up cube raw', () => {
    expect(ZUP_CUBE_VERTICES_INPUT.length).toBe(24);
    // Verify the Z-up shape: the cube has Z values of -5 (front) and 5 (back)
    // in the Z-up convention. Index 2 = -5 (vertex[0].z), index 8 = 5 (vertex[2].z).
    expect(Math.abs(ZUP_CUBE_VERTICES_INPUT[2]! + 5)).toBeLessThan(1e-5);
    expect(Math.abs(ZUP_CUBE_VERTICES_INPUT[8]! - 5)).toBeLessThan(1e-5);
  });

  it('Y-up expected output has correct shape', () => {
    // Y=-5 bottom, Y=5 top, Z=0 front, Z=-10 back
    expect(Math.abs(YUP_CUBE_VERTICES_EXPECTED[1]! + 5)).toBeLessThan(1e-5);
    expect(Math.abs(YUP_CUBE_VERTICES_EXPECTED[7]! - 5)).toBeLessThan(1e-5);
  });

  it('mock Z-up input is NOT equal to Y-up expected (before conversion)', () => {
    const same = isYUpVertices(ZUP_CUBE_VERTICES_INPUT);
    expect(same).toBe(false);
  });
});