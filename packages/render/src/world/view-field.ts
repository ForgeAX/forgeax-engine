import type { Component, EntityHandle, SchemaOf, ShapeOf, World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';

type ScalarSchema =
  | 'f32'
  | 'f64'
  | 'i8'
  | 'i16'
  | 'i32'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'bool'
  | `unique<${string}>`
  | `shared<${string}>`
  | `asset<${string}>`;
type ScalarField<C extends Component> = {
  [K in keyof SchemaOf<C>]: SchemaOf<C>[K] extends ScalarSchema ? K : never;
}[keyof SchemaOf<C>] &
  string;

/** Read a live scalar/reference identity without materializing a component row. */
export function readViewField<C extends Component, F extends ScalarField<C>>(
  world: World,
  entity: EntityHandle,
  component: C,
  field: F,
): ShapeOf<SchemaOf<C>>[F] | undefined {
  const value = world[worldRead].getFieldValue(entity, component, field);
  if (value === undefined) return undefined;
  return (component.fields[field]?.type === 'bool' ? value !== 0 : value) as ShapeOf<
    SchemaOf<C>
  >[F];
}

/** Resolve an optional view product with one component lookup. Invalid managed handles keep the ECS error. */
export function readViewState<T>(
  world: World,
  entity: EntityHandle | undefined,
  component: Component<string, { readonly state: `unique<${string}>` }>,
): T | undefined {
  if (entity === undefined) return undefined;
  const handle = readViewField(world, entity, component, 'state');
  return handle === undefined ? undefined : world.resolveUniqueRef<T>(handle).unwrap();
}

/** Required query fields preserve an owning ECS error when their component is absent. */
export function requireViewField<C extends Component, F extends ScalarField<C>>(
  world: World,
  entity: EntityHandle,
  component: C,
  field: F,
): ShapeOf<SchemaOf<C>>[F] {
  const value = readViewField(world, entity, component, field);
  // Let the existing World API report stale entities or missing components.
  // Successful scalar reads never enter this component-materialization path.
  if (value === undefined)
    return world.get(entity, component).unwrap()[field] as ShapeOf<SchemaOf<C>>[F];
  return value;
}
