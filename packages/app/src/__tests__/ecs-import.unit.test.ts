import { defineComponent, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  createCanonicalEcsImportModule,
  createEcsImportModule,
  projectEcsPublicModule,
} from '../internal/ecs-import';

describe('eval module projection', () => {
  it('keeps the ECS public surface closed', () => {
    expect(projectEcsPublicModule({ World: 1, Entity: 2, hidden: 3 })).toEqual({
      World: 1,
      Entity: 2,
    });
  });

  it('canonicalizes imported component tokens to the World catalog', async () => {
    const Position = defineComponent('EvalImportPosition', { x: 'f32' });
    const world = new World();
    world.components.register(Position).unwrap();
    const foreign = defineComponent('EvalImportPosition', { x: 'f32' });
    const importModule = createCanonicalEcsImportModule(world, async () => ({ Position: foreign }));

    await expect(importModule('@forgeax/engine/scene')).resolves.toEqual({ Position });
  });

  it('projects ECS imports after the realm resolver runs', async () => {
    const importModule = createEcsImportModule(async () => ({ World: 1, hidden: 2 }));

    await expect(importModule('@forgeax/engine-ecs')).resolves.toEqual({ World: 1 });
  });
});
