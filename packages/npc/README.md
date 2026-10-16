# @forgeax/engine-npc

ECS-owned NPC soul binding plus a host-injected adapter plugin.

```ts
import { NpcBrain, npcPlugin } from '@forgeax/engine-npc';

world.spawn({
  component: NpcBrain,
  data: {
    soulId: 'my-game.guide',
    affordanceRef: 'guide',
    enabled: true,
    lod: 0,
  },
});
```

`npcPlugin({ adapter })` scans `NpcBrain` entities and delegates lifecycle/ticks to the adapter. The engine does not know action names, prompts, transport, or model policy. A game or host adapter should resolve `affordanceRef` to `@forgeax/npc-client` affordances and project world state into perception snapshots.
