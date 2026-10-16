import { defineComponent } from '@forgeax/engine-ecs';
import { defineReplication } from '@forgeax/engine-net';

export const Networked = defineComponent('SnakeNetworked', { enabled: 'bool' });
export const Snake = defineComponent('Snake', {
  direction: 'u8',
  score: 'u32',
  playerNetworkId: 'u32',
});
export const SnakeBody = defineComponent('SnakeBody', { segments: 'array<entity>' });
export const SnakeSegment = defineComponent('SnakeSegment', {
  playerNetworkId: 'u32',
  order: 'u32',
});
export const GridPosition = defineComponent('GridPosition', { x: 'i32', y: 'i32' });
export const Food = defineComponent('Food', { enabled: 'bool' });
export const ControlledBy = defineComponent('ControlledBy', { sessionId: 'u32' });
export const PendingDirection = defineComponent('PendingDirection', { value: 'u8' });
export const SnakeSession = defineComponent('SnakeSession', {
  started: 'bool',
  gameplayTick: 'u32',
  startedAtGameplayTick: 'u32',
  lastDirectionCommandPlayerNetworkId: 'u32',
  lastDirectionCommandGameplayTick: 'u32',
});

const profile = defineReplication({
  name: 'multiplayer-snake',
  entities: { with: [Networked] },
  components: [Networked, Snake, SnakeBody, SnakeSegment, GridPosition, Food, SnakeSession],
});

if (!profile.ok) throw profile.error;
export const snakeProfile = profile.value;
