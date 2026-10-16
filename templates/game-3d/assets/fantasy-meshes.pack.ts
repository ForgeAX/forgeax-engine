import { vec3 } from '@forgeax/engine/math';
import { meshFromInterleaved } from '@forgeax/engine/geometry';
import type { Vec3 } from '@forgeax/engine/math';
import { definePack } from '@forgeax/engine/pack/source';
import type { MeshAsset, Submesh } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { assetGuid, PACKAGE_IDS } from './shared/asset-refs.ts';

const TAU = Math.PI * 2;
const NORMAL_EPSILON = 0.0001;
const NORMAL_LENGTH_EPSILON = 0.000001;
const DEFAULT_NORMAL = vec3.create(0, 1, 0);
const DEFAULT_TANGENT = vec3.create(0, 0, 1);
const WORLD_UP = vec3.create(0, 1, 0);
const WORLD_X = vec3.create(1, 0, 0);

const palette = [
  {
    slotName: 'Azure Flux',
    sourceKey: 'game-3d:fantasy:azure',
    defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/fantasy-azure'),
  },
  {
    slotName: 'Violet Rift',
    sourceKey: 'game-3d:fantasy:violet',
    defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/fantasy-violet'),
  },
  {
    slotName: 'Solar Gold',
    sourceKey: 'game-3d:fantasy:gold',
    defaultMaterial: assetGuid(PACKAGE_IDS.materials, 'material/fantasy-gold'),
  },
] as const;

interface ParametricSurface {
  readonly uSegments: number;
  readonly vSegments: number;
  readonly position: (out: Vec3, u: number, v: number) => Vec3;
  /** Non-orientable surfaces need an explicit reversed face with flipped normals. */
  readonly doubleSided?: boolean;
}

interface NormalScratch {
  readonly uForward: Vec3;
  readonly uBackward: Vec3;
  readonly vForward: Vec3;
  readonly vBackward: Vec3;
}

function normalizeOrFallback(out: Vec3, value: Vec3, fallback: Vec3): Vec3 {
  vec3.normalize(out, value);
  if (vec3.lengthSq(out) < NORMAL_LENGTH_EPSILON * NORMAL_LENGTH_EPSILON) {
    vec3.copy(out, fallback);
  }
  return out;
}

function normalAt(
  surface: ParametricSurface,
  u: number,
  v: number,
  out: Vec3,
  scratch: NormalScratch,
): Vec3 {
  surface.position(scratch.uForward, u + NORMAL_EPSILON, v);
  surface.position(scratch.uBackward, u - NORMAL_EPSILON, v);
  surface.position(scratch.vForward, u, v + NORMAL_EPSILON);
  surface.position(scratch.vBackward, u, v - NORMAL_EPSILON);
  vec3.sub(scratch.uForward, scratch.uForward, scratch.uBackward);
  vec3.sub(scratch.vForward, scratch.vForward, scratch.vBackward);
  vec3.cross(out, scratch.vForward, scratch.uForward);
  return normalizeOrFallback(out, out, DEFAULT_NORMAL);
}

/**
 * Builds one indexed MeshAsset. Its single vertex/index buffer is partitioned
 * into three explicit submesh draw ranges, and each range selects one stable
 * material slot. Changing a slot does not duplicate or rebuild the geometry.
 */
function buildSurface(surface: ParametricSurface) {
  const rowLength = surface.vSegments + 1;
  const surfaceVertexCount = (surface.uSegments + 1) * rowLength;
  const vertexCount = surfaceVertexCount * (surface.doubleSided === true ? 2 : 1);
  const vertices = new Float32Array(vertexCount * 8);
  const position = vec3.create();
  const normal = vec3.create();
  const normalScratch: NormalScratch = {
    uForward: vec3.create(),
    uBackward: vec3.create(),
    vForward: vec3.create(),
    vBackward: vec3.create(),
  };
  for (let uIndex = 0; uIndex <= surface.uSegments; uIndex += 1) {
    const uRatio = uIndex / surface.uSegments;
    const u = uRatio * TAU;
    for (let vIndex = 0; vIndex <= surface.vSegments; vIndex += 1) {
      const vRatio = vIndex / surface.vSegments;
      const v = vRatio * TAU;
      surface.position(position, u, v);
      normalAt(surface, u, v, normal, normalScratch);
      const offset = (uIndex * rowLength + vIndex) * 8;
      vertices[offset] = position[0] ?? 0;
      vertices[offset + 1] = position[1] ?? 0;
      vertices[offset + 2] = position[2] ?? 0;
      vertices[offset + 3] = normal[0] ?? 0;
      vertices[offset + 4] = normal[1] ?? 0;
      vertices[offset + 5] = normal[2] ?? 0;
      vertices[offset + 6] = uRatio;
      vertices[offset + 7] = vRatio;
      if (surface.doubleSided === true) {
        const backOffset = offset + surfaceVertexCount * 8;
        vertices[backOffset] = position[0] ?? 0;
        vertices[backOffset + 1] = position[1] ?? 0;
        vertices[backOffset + 2] = position[2] ?? 0;
        vertices[backOffset + 3] = -(normal[0] ?? 0);
        vertices[backOffset + 4] = -(normal[1] ?? 0);
        vertices[backOffset + 5] = -(normal[2] ?? 0);
        vertices[backOffset + 6] = uRatio;
        vertices[backOffset + 7] = vRatio;
      }
    }
  }

  const groupedIndices = palette.map(() => [] as number[]);
  for (let uIndex = 0; uIndex < surface.uSegments; uIndex += 1) {
    const materialSlot = Math.min(
      palette.length - 1,
      Math.floor((uIndex * palette.length) / surface.uSegments),
    );
    const group = groupedIndices[materialSlot];
    if (group === undefined) throw new Error('fantasy mesh material partition is unavailable');
    for (let vIndex = 0; vIndex < surface.vSegments; vIndex += 1) {
      const current = uIndex * rowLength + vIndex;
      const nextU = (uIndex + 1) * rowLength + vIndex;
      group.push(current, nextU + 1, nextU, current, current + 1, nextU + 1);
      if (surface.doubleSided === true) {
        const back = surfaceVertexCount;
        group.push(
          current + back,
          nextU + back,
          nextU + 1 + back,
          current + back,
          nextU + 1 + back,
          current + 1 + back,
        );
      }
    }
  }

  const indexValues: number[] = [];
  const submeshes: Submesh[] = [];
  for (let materialSlot = 0; materialSlot < groupedIndices.length; materialSlot += 1) {
    const group = groupedIndices[materialSlot];
    if (group === undefined) throw new Error('fantasy mesh submesh group is unavailable');
    const indexOffset = indexValues.length;
    indexValues.push(...group);
    submeshes.push({
      indexOffset,
      indexCount: group.length,
      vertexCount,
      topology: 'triangle-list',
      materialSlot,
    });
  }

  const indices =
    vertexCount <= 0xffff ? new Uint16Array(indexValues) : new Uint32Array(indexValues);
  const mesh = meshFromInterleaved(vertices, indices);
  if (!mesh.ok) return mesh;
  return ok<MeshAsset>({
    ...mesh.value,
    submeshes,
    materialSlots: palette,
  });
}

function kleinBottlePosition(out: Vec3, u: number, v: number): Vec3 {
  const halfU = u * 0.5;
  const radial =
    2 + Math.cos(halfU) * Math.sin(v) - Math.sin(halfU) * Math.sin(v * 2);
  vec3.set(
    out,
    radial * Math.cos(u) * 0.72,
    (Math.sin(halfU) * Math.sin(v) + Math.cos(halfU) * Math.sin(v * 2)) * 0.72,
    radial * Math.sin(u) * 0.72,
  );
  return out;
}

function trefoilCenter(out: Vec3, u: number): Vec3 {
  vec3.set(
    out,
    (Math.sin(u) + 2 * Math.sin(u * 2)) * 0.58,
    -Math.sin(u * 3) * 0.58,
    (Math.cos(u) - 2 * Math.cos(u * 2)) * 0.58,
  );
  return out;
}

function createTrefoilPosition(): ParametricSurface['position'] {
  const center = vec3.create();
  const previous = vec3.create();
  const next = vec3.create();
  const tangent = vec3.create();
  const acceleration = vec3.create();
  const twiceCenter = vec3.create();
  const projectedTangent = vec3.create();
  const normal = vec3.create();
  const fallbackNormal = vec3.create();
  const binormal = vec3.create();
  const normalOffset = vec3.create();
  const binormalOffset = vec3.create();
  return (out, u, v) => {
    trefoilCenter(center, u);
    trefoilCenter(previous, u - NORMAL_EPSILON);
    trefoilCenter(next, u + NORMAL_EPSILON);
    vec3.sub(tangent, next, previous);
    normalizeOrFallback(tangent, tangent, DEFAULT_TANGENT);
    vec3.add(acceleration, next, previous);
    vec3.scale(twiceCenter, center, 2);
    vec3.sub(acceleration, acceleration, twiceCenter);
    const projected = vec3.dot(acceleration, tangent);
    vec3.scale(projectedTangent, tangent, projected);
    vec3.sub(normal, acceleration, projectedTangent);
    vec3.cross(fallbackNormal, WORLD_UP, tangent);
    normalizeOrFallback(fallbackNormal, fallbackNormal, WORLD_X);
    normalizeOrFallback(normal, normal, fallbackNormal);
    vec3.cross(binormal, tangent, normal);
    normalizeOrFallback(binormal, binormal, DEFAULT_TANGENT);
    const radius = 0.24;
    const cosV = Math.cos(v) * radius;
    const sinV = Math.sin(v) * radius;
    vec3.scale(normalOffset, normal, cosV);
    vec3.scale(binormalOffset, binormal, sinV);
    vec3.add(out, center, normalOffset);
    vec3.add(out, out, binormalOffset);
    return out;
  };
}

function astralBloomPosition(out: Vec3, u: number, v: number): Vec3 {
  const majorRadius = 1.2 + Math.cos(u * 5) * 0.2;
  const minorRadius = 0.38 + Math.sin(u * 3) * 0.08;
  const ring = majorRadius + Math.cos(v) * minorRadius;
  vec3.set(
    out,
    ring * Math.cos(u),
    Math.sin(v) * minorRadius + Math.sin(u * 5) * 0.16,
    ring * Math.sin(u),
  );
  return out;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_IDS.fantasyMeshes,
  name: 'Game 3D / Fantasy Procedural Meshes',
  build: () => {
    const kleinBottle = buildSurface({
      uSegments: 72,
      vSegments: 28,
      position: kleinBottlePosition,
      doubleSided: true,
    });
    if (!kleinBottle.ok) return kleinBottle;
    const trefoilKnot = buildSurface({
      uSegments: 96,
      vSegments: 18,
      position: createTrefoilPosition(),
    });
    if (!trefoilKnot.ok) return trefoilKnot;
    const astralBloom = buildSurface({
      uSegments: 80,
      vSegments: 20,
      position: astralBloomPosition,
    });
    if (!astralBloom.ok) return astralBloom;
    return ok({
      'mesh/klein-bottle': kleinBottle.value,
      'mesh/trefoil-knot': trefoilKnot.value,
      'mesh/astral-bloom': astralBloom.value,
    });
  },
});
