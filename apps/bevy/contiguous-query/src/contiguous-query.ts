import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Time,
  Update,
  World,
  defineComponent,
} from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

const HEALTH_COUNT = 32;
const Health = defineComponent('ContiguousQueryHealth', { value: 'f32' });
const HealthDecay = defineComponent('ContiguousQueryHealthDecay', { factor: 'f32' });

export interface ContiguousQueryState {
  elapsed: number;
  contiguousSupported: boolean;
  contiguousCalls: number;
  decayPasses: number;
  rows: number;
  lengthsEqual: boolean;
  initialHealth: number;
  currentHealth: number;
}

export interface ContiguousQuerySnapshot extends ContiguousQueryState {}

export function buildContiguousQueryWorld(world: World): ContiguousQueryState {
  const state: ContiguousQueryState = {
    elapsed: 0,
    contiguousSupported: false,
    contiguousCalls: 0,
    decayPasses: 0,
    rows: 0,
    lengthsEqual: true,
    initialHealth: 100,
    currentHealth: 100,
  };
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit([0.9, 0.35, 0.1, 1]));

  for (let index = 0; index < HEALTH_COUNT; index++) {
    const column = index % 8;
    const row = Math.floor(index / 8);
    world.spawn(
      { component: Transform, data: { pos: [column * 120 - 420, row * 120 - 180, 0], quat: [0, 0, 0, 1], scale: [48, 48, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: Health, data: { value: state.initialHealth } },
      { component: HealthDecay, data: { factor: 0.98 } },
    ).unwrap();
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  world.addSystem(Update, {
    name: 'contiguous-query-health-decay',
    queries: [],
    fn: (world) => {
      state.elapsed += world.getResource(Time).delta;
      state.rows = 0;
      const query = world.query({ read: [HealthDecay], write: [Health] }).unwrap();
      const spans = query.spans();
      state.contiguousSupported = spans.ok;
      if (spans.ok) for (const span of spans.value) {
        state.contiguousCalls += 1;
        state.rows += span.length;
        const health = span.mut(Health).value;
        const decay = span.get(HealthDecay).factor;
        state.lengthsEqual = state.lengthsEqual &&
          health.length === decay.length && health.length === span.length;
        for (let index = 0; index < span.length; index++) {
          health[index] = (health[index] ?? 0) * (decay[index] ?? 0);
          if (index === 0) state.currentHealth = health[index] ?? 0;
        }
      }
      state.decayPasses += 1;
    },
  }).unwrap();

  return state;
}

export function readContiguousQueryState(state: ContiguousQueryState): ContiguousQuerySnapshot {
  return { ...state };
}
