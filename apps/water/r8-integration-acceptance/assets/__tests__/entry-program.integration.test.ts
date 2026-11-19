import { AssetGuid } from '@forgeax/engine/pack/source';
import { createVfxEffectContract, prepareVfxGpuEffect } from '@forgeax/engine/vfx';
import { cookParticleCodeEffect } from '@forgeax/engine/vfx-compiler';
import { expect, it } from 'vitest';
import { WATER_R8_PACKAGE } from '../../src/identity';
import { ironBallEntry } from '../coast.pack';
import { waterEntryModules } from '../entry-program';
import { waterEntrySplashDefaults, waterEntrySplashParameters } from '../entry-splash';
import { waterEntrySurface } from '../entry-surfaces';
import { WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS } from '../vfx/water-entry-splash-material-inputs';

it('couples the airborne energy and scale to the native sphere and normal entry speed', () => {
  const entry = {
    entryPosition: [1, 2, 3],
    entryVelocity: [0, -12, 0],
    surfaceNormal: [0, 1, 0],
    entryRadiusM: 0.6,
  };
  const base = waterEntrySplashParameters(entry);
  const half = waterEntrySplashParameters({ ...entry, entryRadiusM: 0.3 });
  const fast = waterEntrySplashParameters({ ...entry, entryVelocity: [0, -24, 0] });
  const height = (speed: number) => speed ** 2 / (2 * 9.81);
  expect(height(base.jetSpeed)).toBeGreaterThan(entry.entryRadiusM);
  expect(height(base.jetSpeed)).toBeLessThan(3 * entry.entryRadiusM);
  expect(height(half.jetSpeed)).toBeLessThan(height(base.jetSpeed));
  expect(height(half.jetSpeed)).toBeGreaterThan(height(base.jetSpeed) * 0.5);
  expect(fast.jetSpeed).toBeGreaterThan(base.jetSpeed);
  expect(fast.jetSpeed).toBeLessThan(base.jetSpeed * 2);
  expect(half.dropletSize).toBeCloseTo(base.dropletSize * 0.5);
  for (const velocity of [
    [12, 0, 0],
    [0, 12, 0],
  ]) {
    const tangentOrLeaving = waterEntrySplashParameters({ ...entry, entryVelocity: velocity });
    expect(tangentOrLeaving.jetSpeed).toBe(0);
    expect(tangentOrLeaving.radialSpeed).toBe(0);
    expect(tangentOrLeaving.opacity).toBe(0);
  }
  const oblique = waterEntrySplashParameters({ ...entry, entryVelocity: [9, -12, 0] });
  expect(oblique.jetSpeed).toBe(base.jetSpeed);
  expect(oblique.entryVelocity).toEqual([9, -12, 0]);
  expect(base.lifetime).toBeGreaterThan((2 * base.jetSpeed) / 9.81);
});

it('keeps the crown root against the native sphere and gives the rim distinct ligaments', () => {
  const mesh = waterEntrySurface('crown');
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('Expected entry geometry');
  const roots: number[] = [],
    rim: number[] = [];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    const y = positions[vertex + 1] ?? 0;
    if (y === 0) roots.push(Math.hypot(positions[vertex] ?? 0, positions[vertex + 2] ?? 0));
    if (y > 0.6) rim.push(y);
  }
  expect(Math.min(...roots)).toBeCloseTo(1, 5);
  expect(Math.max(...roots)).toBeCloseTo(1, 5);
  expect(Math.max(...rim)).toBeGreaterThan(1.25);
});

function triangleArea(positions: Float32Array, a: number, b: number, c: number) {
  const edge = (vertex: number) =>
    [0, 1, 2].map((axis) => (positions[vertex * 3 + axis] ?? 0) - (positions[a * 3 + axis] ?? 0));
  const u = edge(b),
    v = edge(c);
  const area = Math.hypot(
    (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
    (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
    (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
  );
  return area;
}

it('publishes a sealed tongue tip without degenerate triangles or an annular top opening', () => {
  const mesh = waterEntrySurface('tongue');
  const positions = mesh.attributes.position;
  const indices = mesh.indices;
  if (!(positions instanceof Float32Array) || indices === undefined)
    throw new Error('Expected indexed entry geometry');
  let maxY = -Infinity;
  for (let index = 1; index < positions.length; index += 3)
    maxY = Math.max(maxY, positions[index] ?? -Infinity);
  const tips: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++)
    if (positions[vertex * 3 + 1] === maxY) tips.push(vertex);
  expect(tips).toHaveLength(1);
  const tip = tips[0];
  if (tip === undefined) throw new Error('Missing sealed tip');
  expect(Math.hypot(positions[tip * 3] ?? 0, positions[tip * 3 + 2] ?? 0)).toBeLessThan(0.1);
  let tipTriangles = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index],
      b = indices[index + 1],
      c = indices[index + 2];
    if (a === undefined || b === undefined || c === undefined)
      throw new Error('Incomplete triangle');
    if (a === tip || b === tip || c === tip) tipTriangles++;
    const area = triangleArea(positions, a, b, c);
    expect(area).toBeGreaterThan(1e-8);
  }
  expect(tipTriangles).toBeGreaterThanOrEqual(48);
});

it('cooks coherent crown/tongue meshes and droplets with one native entry parameter contract', async () => {
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, key));
  const cooked = await cookParticleCodeEffect(ironBallEntry, waterEntryModules, {
    [guid('material/water-entry-splash')]: WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS,
  });
  if (!cooked.ok) throw new Error(JSON.stringify(cooked.error));
  expect(cooked.value.artifact.program.emitters).toHaveLength(3);
  const admitted = await prepareVfxGpuEffect({
    guid: guid('effect/iron-ball-entry'),
    kind: 'particle-effect',
    payload: { ...cooked.value.asset },
    artifacts: {
      [cooked.value.artifact.artifactKey]: {
        descriptor: { path: 'program.json', mediaType: cooked.value.artifact.mimeType },
        bytes: cooked.value.artifact.bytes,
      },
    },
  });
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
  expect(admitted.value.program.emitters).toHaveLength(3);
  const values = waterEntrySplashParameters({
    entryPosition: [1, 2, 3],
    entryVelocity: [0, -12, 0],
    surfaceNormal: [0, 1, 0],
    entryRadiusM: 0.85,
  });
  for (const emitter of cooked.value.artifact.program.emitters) {
    expect(emitter.reflection.layout.parameters.size).toBe(112);
    expect(emitter.reflection.layout.customLayout?.stride).toBe(64);
    expect(emitter.reflection.layout).toEqual(
      cooked.value.artifact.program.emitters[0]?.reflection.layout,
    );
    for (const [key, value] of Object.entries(waterEntrySplashDefaults))
      expect(
        emitter.reflection.layout.parameters.fields.find((field) => field.name === key)
          ?.defaultValue,
      ).toBe(value);
    const contract = createVfxEffectContract(emitter.reflection.layout);
    const accepted = contract.createValues(values);
    expect(accepted.ok, emitter.id).toBe(true);
    if (!accepted.ok) throw accepted.error;
    expect(contract.packParameters(accepted.value).ok).toBe(true);
  }
  for (const surface of ['crown', 'tongue'] as const) {
    expect(cooked.value.refs).toContain(guid(`mesh/entry-${surface}`));
    const mesh = waterEntrySurface(surface);
    expect(mesh.submeshes[0]?.indexCount).toBeGreaterThan(100);
    expect(mesh.attributes.position).toBeInstanceOf(Float32Array);
  }
});
