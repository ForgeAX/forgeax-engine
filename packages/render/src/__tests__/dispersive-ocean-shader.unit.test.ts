import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import {
  ADVANCED_COLLISION_FLOATS,
  type AdvancedCollisionSnapshot,
} from '../water/advanced-collisions';
import {
  dispersiveExternalSources,
  dispersiveQueryPrefix,
  dispersiveSourceIdentity,
  dispersiveSourceRequiresReseed,
} from '../water/dispersive-ocean';
import { DISPERSIVE_QUERY_SHADER, dispersiveOceanShader } from '../water/dispersive-ocean-shader';

it.each([
  'rgba16float',
  'rgba32float',
] as const)('reuses the immutable dispersive source for %s', (format) => {
  expect(dispersiveOceanShader(format)).toBe(dispersiveOceanShader(format));
});

it('does not cache an unsupported runtime format into a fixed slot', () => {
  const unsupported = 'rgba64float' as Parameters<typeof dispersiveOceanShader>[0];
  expect(dispersiveOceanShader(unsupported)).toContain('texture_storage_2d<rgba64float,write>');
  expect(dispersiveOceanShader('rgba32float')).toContain('texture_storage_2d<rgba32float,write>');
});

it('bounds receiver graph names for the complete accepted native identity range', () => {
  const ocean = `water-ocean-${'a'.repeat(64)}`;
  const receiver = { entity: Number.MAX_SAFE_INTEGER, generation: Number.MAX_SAFE_INTEGER };
  const prefix = dispersiveQueryPrefix(ocean, receiver);
  expect(`${prefix}-source-0-fft-1-512-bindings`).toMatch(/^[a-z][a-z0-9.-]{0,127}$/);
  expect(
    dispersiveQueryPrefix(ocean, { ...receiver, generation: receiver.generation - 1 }),
  ).not.toBe(prefix);
  expect(dispersiveQueryPrefix(`${ocean}b`, receiver)).not.toBe(prefix);
});

it('excludes every compound element of the receiver while retaining external and replacement generations', () => {
  const roster = [
    { entity: 4, bodyGeneration: 2 },
    { entity: 4, bodyGeneration: 2 },
    { entity: 5, bodyGeneration: 2 },
    { entity: 4, bodyGeneration: 3 },
  ].map((row, index) => ({
    ...row,
    completedStep: 1,
    motionDiscontinuity: 0,
    identity: {
      kind: 'native-collider' as const,
      colliderId: `c${index}`,
      generation: 1,
      elementIndex: index,
    },
    representation: 'sphere' as const,
  }));
  const snapshot: AdvancedCollisionSnapshot = {
    originM: [0, 0, 0],
    roster,
    sdfInstances: new Uint8Array(),
    sdfFields: new Uint8Array(),
    primitives: new Float32Array(
      roster.flatMap((_, index) => Array(ADVANCED_COLLISION_FLOATS).fill(index)),
    ),
  };
  const external = dispersiveExternalSources(snapshot, { entity: 4, generation: 2 });
  expect(external.roster).toEqual(roster.slice(2));
  expect(Array.from(external.primitives)).toEqual(
    Array(ADVANCED_COLLISION_FLOATS).fill(2).concat(Array(ADVANCED_COLLISION_FLOATS).fill(3)),
  );
  expect(external.sdfInstances).toBe(snapshot.sdfInstances);
  expect(snapshot.roster).toHaveLength(4);
  const added = dispersiveSourceIdentity(snapshot),
    old = dispersiveSourceIdentity(external);
  expect(dispersiveSourceRequiresReseed(old, added)).toBe(false);
  expect(dispersiveSourceRequiresReseed(added, old)).toBe(true);
});

it('compiles the exact bounded residual readback producer', async () => {
  const compiled = await compileShader(DISPERSIVE_QUERY_SHADER, { computeEntry: 'sampleQuery' });
  if (!compiled.ok) throw compiled.error;
  expect(compiled.value.reflection.entryPoints?.some((point) => point.name === 'sampleQuery')).toBe(
    true,
  );
});

it.each([
  'columns',
  'transportcolumns',
  'transportdivergence',
  'butterfly',
  'project',
  'prepare',
  'advance',
  'publish',
  'publishquery',
  'mapping',
  'clear',
])('compiles the opt-in dispersive %s stage', async (entry) => {
  const compiled = await compileShader(dispersiveOceanShader('rgba32float'), {
    computeEntry: entry,
  });
  if (!compiled.ok) throw compiled.error;
  expect(compiled.value.reflection.entryPoints?.some((point) => point.name === entry)).toBe(true);
});
