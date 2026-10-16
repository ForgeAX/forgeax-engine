import { type Component, componentDefinition, type FieldReflection } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ComponentIntrospectionField {
  readonly type: string;
  readonly default?: JsonValue;
  readonly shape?: string;
  readonly transient?: boolean;
  readonly arrayMeta?: {
    readonly elementType: string;
    readonly length?: number;
  };
  readonly labels?: Readonly<Record<string, number>>;
}

export interface ComponentIntrospectionDescriptor {
  readonly name: string;
  readonly schema: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, ComponentIntrospectionField>>;
  readonly meta: Readonly<Record<string, JsonValue>>;
}

function projectJson(value: unknown, seen: Set<object>): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (ArrayBuffer.isView(value)) {
    const values = Array.from(value as unknown as ArrayLike<unknown>);
    const projected = values.map((entry) => projectJson(entry, seen));
    seen.delete(value);
    return projected.every((entry) => entry !== undefined) ? (projected as JsonValue[]) : undefined;
  }
  if (Array.isArray(value)) {
    const projected = value.map((entry) => projectJson(entry, seen));
    seen.delete(value);
    return projected.every((entry) => entry !== undefined) ? (projected as JsonValue[]) : undefined;
  }

  const object: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const projected = projectJson(entry, seen);
    if (projected !== undefined) object[key] = projected;
  }
  seen.delete(value);
  return object;
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return (
    value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

function projectMeta(meta: Readonly<Record<string, unknown>>): Readonly<Record<string, JsonValue>> {
  const projected = projectJson(meta, new Set<object>());
  return isJsonRecord(projected) ? projected : {};
}

function projectField(reflection: FieldReflection): ComponentIntrospectionField {
  const field: ComponentIntrospectionField = { type: reflection.type };
  const defaultValue = projectJson(reflection.default, new Set<object>());
  if (defaultValue !== undefined) Object.assign(field, { default: defaultValue });
  if (reflection.shape !== undefined) Object.assign(field, { shape: reflection.shape });
  if (reflection.transient !== undefined) Object.assign(field, { transient: reflection.transient });
  if (reflection.arrayMeta !== undefined) {
    Object.assign(field, {
      arrayMeta: {
        elementType: reflection.arrayMeta.elementType,
        ...(reflection.arrayMeta.length !== undefined
          ? { length: reflection.arrayMeta.length }
          : {}),
      },
    });
  }
  if (reflection.labels !== undefined) Object.assign(field, { labels: { ...reflection.labels } });
  return Object.freeze(field);
}

function projectComponent(component: Component): ComponentIntrospectionDescriptor {
  const definition = componentDefinition(component);
  const fields: Record<string, ComponentIntrospectionField> = {};
  for (const [name, reflection] of Object.entries(definition.fields)) {
    fields[name] = projectField(reflection);
  }
  return Object.freeze({
    name: component.name,
    schema: Object.freeze({ ...componentSchema(component) }),
    fields: Object.freeze(fields),
    meta: Object.freeze(projectMeta(definition.policy.meta)),
  });
}

/** Project one World-local component catalog into transport-safe data. */
export function projectComponentIntrospection(
  components: ReadonlyMap<string, Component>,
): readonly ComponentIntrospectionDescriptor[] {
  return Object.freeze(
    [...components.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(projectComponent),
  );
}
