import { createWorldContext, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { createNpcClientAdapter, NpcBrain, type NpcBrainBinding, npcPlugin } from '../index';

describe('NpcBrain', () => {
  it('stores soul, affordance reference, enabled state, and cognitive LOD', () => {
    const world = new World();
    const entity = world
      .spawn({
        component: NpcBrain,
        data: { soulId: 'demo.guide', affordanceRef: 'guide-actions', enabled: false, lod: 1 },
      })
      .unwrap();

    const value = world.get(entity, NpcBrain).unwrap();
    expect(value.soulId).toBe('demo.guide');
    expect(value.affordanceRef).toBe('guide-actions');
    expect(value.enabled).toBe(false);
    expect(value.lod).toBe(1);
  });

  it('adapts a generic client without hardcoding action names', () => {
    const declarations: Array<{ id: string; actions: string[] }> = [];
    const levels: string[] = [];
    const samples: string[] = [];
    const adapter = createNpcClientAdapter<{ action: string }, string>(
      {
        declareAffordances(id, affordances) {
          declarations.push({ id, actions: affordances.map((item) => item.action) });
        },
        setLod(_id, level) {
          levels.push(level);
        },
        tick(_dt, sampler) {
          samples.push(sampler('demo.guide') ?? '');
        },
      },
      {
        affordances(reference) {
          return [{ action: reference }];
        },
        sample(binding) {
          return binding.soulId;
        },
      },
    );
    const binding: NpcBrainBinding = {
      entity: 1 as never,
      soulId: 'demo.guide',
      affordanceRef: 'trade',
      enabled: true,
      lod: 1,
    };
    adapter.sync([binding], new World());
    adapter.tick(0.25, new World());

    expect(declarations).toEqual([{ id: 'demo.guide', actions: ['trade'] }]);
    expect(levels).toEqual(['ambient']);
    expect(samples).toEqual(['demo.guide']);
  });

  it('scans component data and delegates without interpreting actions', async () => {
    const world = new World();
    const seen: NpcBrainBinding[][] = [];
    const ticks: number[] = [];
    const plugin = npcPlugin({
      adapter: {
        sync(bindings) {
          seen.push([...bindings]);
        },
        tick(dt) {
          ticks.push(dt);
        },
      },
    });
    await createWorldContext(world, [plugin]);
    world
      .spawn({
        component: NpcBrain,
        data: { soulId: 'demo.guide', affordanceRef: 'guide-actions', enabled: true, lod: 0 },
      })
      .unwrap();

    world.update(0.25).unwrap();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toMatchObject({ soulId: 'demo.guide', affordanceRef: 'guide-actions' });
    expect(ticks).toEqual([0.1]);

    world.update(0.5).unwrap();
    expect(seen).toHaveLength(1);
    expect(ticks).toEqual([0.1, 0.1]);
  });
});
