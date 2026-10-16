import { defineSystem, Update } from '@forgeax/engine-ecs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { InputSet } from '@forgeax/engine-input';
import { PhysicsSet } from '@forgeax/engine-physics';
import { TransformSet } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appIndex = resolve(here, '..', 'src', 'index.ts');

describe('SystemSet root-entry token chain', () => {
  it('configures tokens imported from every owner root entry', () => {
    const world = new World();
    const noop = (name: string) =>
      defineSystem({
        name,
        queries: [],
        fn: (_world) => {
          void _world;
        },
      });

    expect(world.addSystems(Update, TransformSet, [noop('transform-test')]).ok).toBe(true);
    expect(world.addSystems(Update, InputSet, [noop('input-test')]).ok).toBe(true);
    expect(world.addSystems(Update, PhysicsSet, [noop('physics-test')]).ok).toBe(true);
    const update = world.inspect().schedules.find((entry) => entry.schedule === Update);
    expect(update?.systems.map((system) => system.name)).toEqual([
      'transform-test',
      'input-test',
      'physics-test',
    ]);
  });

  it('does not make the app root a second InputSet entry point', () => {
    expect(readFileSync(appIndex, 'utf8')).not.toMatch(/\bInputSet\b/);
  });
});
