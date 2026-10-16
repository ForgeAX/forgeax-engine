// @forgeax/engine-ecs — externalization module public barrel.
//
// Pure ECS kernel: projection, portable validation, and entity remap.
// No network, peer, wire, profile, or codec policy.

import type { Component, ComponentSchema } from '../component';
import { componentSchema } from '../component';
import { fillComponentDefaults } from '../component-default-fallback';
import { componentDefinition } from '../component-schema';

export type EntityFieldKind =
  | { readonly kind: 'entity'; readonly isArray: false }
  | { readonly kind: 'entity'; readonly isArray: true };

export interface EntityRemapOptions {
  readonly missing?: 'identity' | 'error';
}

export function classifyEntityField(token: Component, fieldName: string): EntityFieldKind | null {
  const field = componentDefinition(token).fields[fieldName];
  if (field === undefined) return null;
  if (field.arrayMeta !== undefined) {
    return field.arrayMeta.elementType === 'entity' ? { kind: 'entity', isArray: true } : null;
  }
  return componentSchema(token)[fieldName] === 'entity' ? { kind: 'entity', isArray: false } : null;
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

export function createEntityRemap(
  mapping: Uint32Array | readonly number[],
  options: EntityRemapOptions = {},
): (entity: number) => number {
  return (entity) => {
    const mapped = entity >= 0 && entity < mapping.length ? mapping[entity] : undefined;
    if (mapped !== undefined) return mapped;
    if (options.missing === 'error') {
      throw new Error(`Entity mapping is missing source entity ${entity}.`);
    }
    return entity;
  };
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

function projectComponentDataInMode<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entityRemap?: (entity: number) => number,
): Record<string, unknown> {
  const definition = componentDefinition(token);
  if (definition.policy.transient) return {};
  const fields = definition.fields;
  const rawObj = raw as Record<string, unknown> | undefined;
  const filtered: Record<string, unknown> = {};
  for (const fieldName of Object.keys(componentSchema(token))) {
    const reflection = fields?.[fieldName];
    if (reflection?.transient === true || rawObj === undefined || !(fieldName in rawObj)) continue;
    const value = rawObj[fieldName];
    if (value === undefined) continue;
    const kind = classifyEntityField(token, fieldName);
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
  for (const fieldName of Object.keys(componentSchema(token))) {
    if (fields?.[fieldName]?.transient === true) delete result[fieldName];
  }
  return result;
}

export function projectComponentData<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
  entityRemap?: (entity: number) => number,
): Record<string, unknown> {
  return projectComponentDataInMode(token, raw, entityRemap);
}

export function isComponentPortable(token: Component): boolean {
  const definition = componentDefinition(token);
  if (definition.policy.transient) return false;
  const fields = definition.fields;
  if (fields === undefined) return true;
  return Object.keys(componentSchema(token)).some((name) => fields[name]?.transient !== true);
}

export function isComponentFullyTransient(token: Component): boolean {
  return !isComponentPortable(token);
}

export function isFieldPortable(fieldType: string): boolean {
  if (fieldType === 'ref' || fieldType.startsWith('unique<') || fieldType.startsWith('shared<')) {
    return false;
  }
  if (fieldType.startsWith('array<') && fieldType.endsWith('>')) {
    const body = fieldType
      .slice(6, -1)
      .replace(/,\s*\d+$/u, '')
      .trim();
    return body.length > 0 && isFieldPortable(body);
  }
  return true;
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
    if (isComponentFullyTransient(token)) {
      errors.push({
        component: token.name,
        code: 'component-fully-transient',
        expected: `Component '${token.name}' must have at least one non-transient, portable field`,
        hint: 'Remove the component-level transient flag or declare a non-transient field',
      });
      continue;
    }
    const fields = componentDefinition(token).fields;
    for (const fieldName of Object.keys(componentSchema(token))) {
      const fieldType = componentSchema(token)[fieldName];
      if (fieldType === undefined || fields?.[fieldName]?.transient === true) continue;
      if (!isFieldPortable(fieldType)) {
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
