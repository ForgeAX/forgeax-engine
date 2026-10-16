import { createWorldContext, World } from '@forgeax/engine/ecs';
import type { NpcBrainBinding } from '@forgeax/engine/npc';
import {
  NPC_COGNITIVE_LOD_AMBIENT,
  NPC_COGNITIVE_LOD_SPOTLIGHT,
  NpcBrain,
  npcPlugin,
} from '@forgeax/engine/npc';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'NpcBrain ECS binding',
  catalog: 'NpcBrain ECS binding',
  kind: 'headless',
  summary:
    'NpcBrain is a plain ECS component (soulId, affordanceRef, enabled, lod). npcPlugin scans it every Update and hands bindings to an adapter; sync only fires when the binding set changes, tick fires every frame.',
  expect:
    'All checks pass: defaults apply, the first update syncs once, an unchanged frame only ticks, editing lod re-syncs, and disposing the context removes the system and calls adapter.dispose.',
  async run(checks) {
    const world = new World();
    const syncs: NpcBrainBinding[][] = [];
    const ticks: number[] = [];
    let disposed = 0;
    const ctx = await createWorldContext(world, [
      npcPlugin({
        adapter: {
          sync: (bindings) => void syncs.push([...bindings]),
          tick: (dt) => void ticks.push(dt),
          dispose: () => {
            disposed += 1;
          },
        },
      }),
    ]);
    const guide = world.spawn({ component: NpcBrain, data: { soulId: 'lab.guide' } });
    checks.ok('spawn NpcBrain', guide.ok);
    if (!guide.ok) return;
    const stored = world.get(guide.value, NpcBrain);
    checks.equal(
      'schema defaults',
      stored.ok ? [stored.value.affordanceRef, stored.value.enabled, stored.value.lod] : null,
      ['', true, NPC_COGNITIVE_LOD_SPOTLIGHT],
    );
    checks.ok('update 1', world.update(1 / 60).ok);
    checks.equal(
      'first frame syncs one binding',
      syncs.map((set) => set.map((item) => item.soulId)),
      [['lab.guide']],
    );
    checks.ok('update 2', world.update(1 / 60).ok);
    checks.equal('unchanged frame does not re-sync', syncs.length, 1);
    checks.equal('tick every frame', ticks.length, 2);
    checks.near('tick receives Time.delta', ticks[1] ?? 0, 1 / 60, 1e-4);
    checks.ok(
      'set lod',
      world.set(guide.value, NpcBrain, {
        soulId: 'lab.guide',
        affordanceRef: 'guide',
        enabled: true,
        lod: NPC_COGNITIVE_LOD_AMBIENT,
      }).ok,
    );
    world.update(1 / 60);
    checks.equal(
      'lod edit re-syncs',
      syncs.at(-1)?.map((item) => [item.affordanceRef, item.lod]),
      [['guide', NPC_COGNITIVE_LOD_AMBIENT]],
    );
    await ctx.fiber.dispose();
    checks.equal('dispose calls adapter.dispose once', disposed, 1);
    const before = ticks.length;
    world.update(1 / 60);
    checks.equal('system removed after dispose', ticks.length, before);
  },
});
