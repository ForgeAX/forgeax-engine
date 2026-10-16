import { createWorldContext, World } from '@forgeax/engine/ecs';
import type { NpcClientPort } from '@forgeax/engine/npc';
import {
  createNpcClientAdapter,
  NPC_COGNITIVE_LOD_OFFSTAGE,
  NpcBrain,
  npcPlugin,
} from '@forgeax/engine/npc';
import { defineFeature } from '../../lab/feature';

interface LabAffordance {
  readonly action: string;
}

export default defineFeature({
  title: 'Host-injected NPC adapter',
  catalog: 'Host-injected NPC adapter',
  kind: 'headless',
  summary:
    'createNpcClientAdapter bridges NpcBrain bindings to any client port (declareAffordances / setLod / tick). The game supplies affordance resolution and perception sampling; the engine never interprets action names.',
  expect:
    'All checks pass: enabled brains declare the game-resolved affordances, numeric lod maps to spotlight/ambient/offstage, disabled or empty-soul brains are skipped, and tick samples only active souls.',
  async run(checks) {
    const declared: Array<[string, string[]]> = [];
    const lods: Array<[string, string, string | undefined]> = [];
    const sampled: Array<string | undefined> = [];
    const client: NpcClientPort<LabAffordance, string> = {
      declareAffordances: (id, affordances) =>
        void declared.push([id, affordances.map((item) => item.action)]),
      setLod: (id, level, snapshot) => void lods.push([id, level, snapshot]),
      tick: (_dt, sampler) => {
        sampled.push(sampler('lab.merchant'), sampler('lab.sleeper'));
      },
    };
    const adapter = createNpcClientAdapter<LabAffordance, string>(client, {
      affordances: (reference) => reference.split(',').map((action) => ({ action })),
      sample: (binding) => `seen:${binding.soulId}`,
    });
    const world = new World();
    const ctx = await createWorldContext(world, [npcPlugin({ adapter })]);
    world.spawn({
      component: NpcBrain,
      data: { soulId: 'lab.merchant', affordanceRef: 'trade,greet', lod: 1 },
    });
    world.spawn({
      component: NpcBrain,
      data: { soulId: 'lab.sleeper', affordanceRef: 'snore', enabled: false },
    });
    world.spawn({
      component: NpcBrain,
      data: { soulId: 'lab.far', affordanceRef: 'wave', lod: NPC_COGNITIVE_LOD_OFFSTAGE },
    });
    world.spawn({ component: NpcBrain, data: { soulId: '', affordanceRef: 'ghost' } });
    checks.ok('update', world.update(1 / 60).ok);
    checks.equal(
      'only enabled souls declare game-resolved affordances',
      declared.sort((a, b) => a[0].localeCompare(b[0])),
      [
        ['lab.far', ['wave']],
        ['lab.merchant', ['trade', 'greet']],
      ],
    );
    checks.equal(
      'numeric lod maps to client level names with a snapshot',
      lods.sort((a, b) => a[0].localeCompare(b[0])),
      [
        ['lab.far', 'offstage', 'seen:lab.far'],
        ['lab.merchant', 'ambient', 'seen:lab.merchant'],
      ],
    );
    checks.equal('tick samples active souls and skips disabled ones', sampled, [
      'seen:lab.merchant',
      undefined,
    ]);
    await ctx.fiber.dispose();
  },
});
