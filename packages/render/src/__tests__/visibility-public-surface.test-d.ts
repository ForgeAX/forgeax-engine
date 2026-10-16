import { World } from '@forgeax/engine-ecs';
import { Visibility, type VisibilityState, VisibilityStateValue } from '@forgeax/engine-render';
import { expectTypeOf } from 'vitest';

const world = new World();
const entity = world.spawn({ component: Visibility, data: {} }).unwrap();

expectTypeOf(VisibilityStateValue.inherited).toEqualTypeOf<0>();
expectTypeOf(VisibilityStateValue.hidden).toEqualTypeOf<1>();
expectTypeOf(VisibilityStateValue.visible).toEqualTypeOf<2>();
expectTypeOf<VisibilityState>().toEqualTypeOf<'inherited' | 'hidden' | 'visible'>();

world.set(entity, Visibility, { state: VisibilityStateValue.visible });

const query = world.query({ read: [Visibility] }).unwrap();
for (const row of query) {
  const rawState = row.get(Visibility).state;
  const decodedState: VisibilityState | undefined =
    rawState === VisibilityStateValue.hidden
      ? 'hidden'
      : rawState === VisibilityStateValue.visible
        ? 'visible'
        : rawState === VisibilityStateValue.inherited
          ? 'inherited'
          : undefined;
  expectTypeOf(decodedState).toEqualTypeOf<VisibilityState | undefined>();
}
