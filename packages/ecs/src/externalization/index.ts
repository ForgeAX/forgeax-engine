// @forgeax/engine-ecs — externalization module public barrel.
//
// Pure ECS kernel: projection, portable validation, and entity remap.
// No network, peer, wire, profile, or codec policy.

import {
  type Component,
  type ComponentSchema,
  componentDefinition,
  type FieldPlan,
} from '../component';
import { fillComponentDefaults } from '../component-input';

export type EntityFieldKind =
  | { readonly kind: 'entity'; readonly isArray: false }
  | { readonly kind: 'entity'; readonly isArray: true };

const SCALAR_ENTITY_FIELD = Object.freeze({ kind: 'entity', isArray: false } as const);
const ARRAY_ENTITY_FIELD = Object.freeze({ kind: 'entity', isArray: true } as const);

function entityFieldKind(plan: FieldPlan | undefined): EntityFieldKind | null {
  if (plan?.kind === 'entity') return SCALAR_ENTITY_FIELD;
  return plan?.array?.elementType === 'entity' ? ARRAY_ENTITY_FIELD : null;
}

export function classifyEntityField(token: Component, fieldName: string): EntityFieldKind | null {
  return entityFieldKind(componentDefinition(token).plan.fields[fieldName]);
}

export function remapEntityFieldValue(
  value: unknown,
  kind: EntityFieldKind | null,
  remapFn: (entity: number) => number,
): unknown {
  if (kind === null) return value;
  if (kind.isArray) return Array.isArray(value) ? value.map((entity) => remapFn(entity)) : value;
  return typeof value === 'number' ? remapFn(value) : value;
}

function deepCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = value as unknown as ArrayLike<number>;
    const ViewCtor = value.constructor as unknown as new (v: ArrayLike<number>) => unknown;
    return new ViewCtor(view);
  }
  return value;
}

export function projectComponentData<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entityRemap?: (entity: number) => number,
): Record<string, unknown> {
  const definition = componentDefinition(token);
  if (definition.policy.transient) return {};
  const fields = definition.fields;
  const rawObj = raw as Record<string, unknown> | undefined;
  const filtered: Record<string, unknown> = {};
  for (const fieldName of definition.fieldNames) {
    const reflection = fields[fieldName];
    if (reflection?.transient === true || rawObj === undefined || !(fieldName in rawObj)) continue;
    const value = rawObj[fieldName];
    if (value === undefined) continue;
    const kind = entityFieldKind(definition.plan.fields[fieldName]);
    if (kind?.isArray && (Array.isArray(value) || ArrayBuffer.isView(value))) {
      filtered[fieldName] = Array.from(value as ArrayLike<number>, (entity) =>
        entityRemap === undefined ? entity : entityRemap(entity),
      );
    } else if (kind !== null && typeof value === 'number') {
      filtered[fieldName] = entityRemap === undefined ? value : entityRemap(value);
    } else {
      filtered[fieldName] = deepCopyValue(value);
    }
  }
  const result = fillComponentDefaults(token, filtered as Partial<Record<string, unknown>>);
  for (const fieldName of definition.fieldNames) {
    if (fields[fieldName]?.transient === true) delete result[fieldName];
  }
  return result;
}

export interface ProfileComponentError {
  readonly component: string;
  readonly code: 'component-fully-transient' | 'field-not-portable';
  readonly field?: string;
  readonly fieldType?: string;
  readonly expected: string;
  readonly hint: string;
}

export function validateProfileComponents(components: readonly Component[]): {
  readonly valid: boolean;
  readonly errors: readonly ProfileComponentError[];
} {
  const errors: ProfileComponentError[] = [];
  for (const token of components) {
    const definition = componentDefinition(token);
    if (
      definition.policy.transient ||
      !definition.fieldNames.some((name) => definition.fields[name]?.transient !== true)
    ) {
      errors.push({
        component: token.name,
        code: 'component-fully-transient',
        expected: `Component '${token.name}' must have at least one non-transient, portable field`,
        hint: 'Remove the component-level transient flag or declare a non-transient field',
      });
      continue;
    }
    for (const fieldName of definition.fieldNames) {
      const field = definition.fields[fieldName];
      const plan = definition.plan.fields[fieldName];
      if (field === undefined || field.transient === true || plan === undefined) continue;
      if (plan.kind === 'unique' || plan.reference !== undefined) {
        const fieldType = field.type;
        errors.push({
          component: token.name,
          code: 'field-not-portable',
          field: fieldName,
          fieldType,
          expected: `Field '${fieldName}' of component '${token.name}' must be portable`,
          hint: `Field type '${fieldType}' is a process-local reference`,
        });
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
