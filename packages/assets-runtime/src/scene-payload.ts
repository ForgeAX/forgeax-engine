// @forgeax/engine-assets-runtime -- keyed scene payload parse + ref resolution

import { parseManagedArraySchema } from '@forgeax/engine-ecs/internal';
import type {
  ParseErrorDetail,
  SceneAsset,
  SceneEntity,
  SceneInstanceOverride,
} from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

/** Decode only schema-declared shared references; every other storage family stays native. */
export function resolveSceneComponentFields(
  entityKey: string,
  componentName: string,
  rawFields: Record<string, unknown>,
  refs: readonly string[] | undefined,
  schema: Readonly<Record<string, string>> | undefined,
): Result<Record<string, unknown>, ParseErrorDetail> {
  const resolved: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(rawFields)) {
    const type = schema?.[fieldName];
    const handleField = type?.startsWith('asset<') === true;
    if (handleField && value === null) {
      resolved[fieldName] = 0;
      continue;
    }
    if (refs !== undefined && handleField && typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value >= refs.length) {
        return err({
          entityKey,
          component: componentName,
          field: fieldName,
          index: value,
          refsLength: refs.length,
        });
      }
      resolved[fieldName] = refs[value];
      continue;
    }
    const array = type === undefined ? null : parseManagedArraySchema(type);
    if (
      array?.elementType.startsWith('asset<') &&
      (Array.isArray(value) || (ArrayBuffer.isView(value) && 'length' in value))
    ) {
      const values: unknown[] = [];
      for (const [arrayIndex, item] of Array.from(value as ArrayLike<unknown>).entries()) {
        if (item === null) {
          values.push(0);
          continue;
        }
        if (refs === undefined || typeof item !== 'number') {
          values.push(item);
          continue;
        }
        if (!Number.isInteger(item) || item < 0 || item >= refs.length) {
          return err({
            entityKey,
            component: componentName,
            field: `${fieldName}[${arrayIndex}]`,
            index: item,
            refsLength: refs.length,
          });
        }
        values.push(refs[item]);
      }
      resolved[fieldName] = values;
      continue;
    }
    resolved[fieldName] = value;
  }
  return ok(resolved);
}

function resolveComponents(
  rawComponents: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (rawComponents === null || typeof rawComponents !== 'object' || Array.isArray(rawComponents))
    return undefined;
  const components: Record<string, Record<string, unknown>> = {};
  for (const [componentName, rawFields] of Object.entries(
    rawComponents as Record<string, unknown>,
  )) {
    if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields))
      return undefined;
    components[componentName] = { ...(rawFields as Record<string, unknown>) };
  }
  return components;
}

function resolveSkinGuids(
  raw: unknown,
  refs: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string') {
      out.push(value);
    } else if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      refs !== undefined &&
      refs[value] !== undefined
    ) {
      out.push(refs[value] as string);
    } else {
      return undefined;
    }
  }
  return out;
}

/** Reconstruct a keyed SceneAsset. Component refs wait for their owning schema. */
export function parseScenePayload(
  payload: Record<string, unknown>,
  refs?: string[],
): SceneAsset | undefined {
  const rawEntities = payload.entities;
  if (rawEntities === null || typeof rawEntities !== 'object' || Array.isArray(rawEntities))
    return undefined;
  const entities: Record<string, SceneEntity> = {};
  for (const [entityKey, rawEntity] of Object.entries(rawEntities as Record<string, unknown>)) {
    if (
      entityKey.length === 0 ||
      rawEntity === null ||
      typeof rawEntity !== 'object' ||
      Array.isArray(rawEntity)
    ) {
      return undefined;
    }
    const entity = rawEntity as { components?: unknown; instance?: unknown };
    const components = resolveComponents(entity.components ?? {});
    if (components === undefined) return undefined;
    let instance: SceneEntity['instance'];
    if (entity.instance !== undefined) {
      if (
        entity.instance === null ||
        typeof entity.instance !== 'object' ||
        Array.isArray(entity.instance)
      )
        return undefined;
      const rawInstance = entity.instance as { source?: unknown; overrides?: unknown };
      let source: string;
      if (typeof rawInstance.source === 'string') {
        source = rawInstance.source;
      } else if (
        typeof rawInstance.source === 'number' &&
        Number.isInteger(rawInstance.source) &&
        refs !== undefined &&
        refs[rawInstance.source] !== undefined
      ) {
        source = refs[rawInstance.source] as string;
      } else {
        return undefined;
      }
      if (rawInstance.overrides !== undefined && !Array.isArray(rawInstance.overrides))
        return undefined;
      const overrides: SceneInstanceOverride[] = [];
      for (const rawOverride of (rawInstance.overrides ?? []) as readonly unknown[]) {
        if (rawOverride === null || typeof rawOverride !== 'object' || Array.isArray(rawOverride))
          return undefined;
        const override = rawOverride as { target?: unknown; components?: unknown };
        if (
          !Array.isArray(override.target) ||
          override.target.length === 0 ||
          override.target.some((part) => typeof part !== 'string' || part.length === 0)
        ) {
          return undefined;
        }
        const overrideComponents = resolveComponents(override.components ?? {});
        if (overrideComponents === undefined) return undefined;
        overrides.push({
          target: [...override.target] as [string, ...string[]],
          components: overrideComponents,
        });
      }
      instance = {
        source,
        ...(overrides.length === 0 && rawInstance.overrides === undefined ? {} : { overrides }),
      };
    }
    entities[entityKey] = {
      components,
      ...(instance === undefined ? {} : { instance }),
    };
  }
  const skinGuids = resolveSkinGuids(payload.skinGuids, refs);
  if (Array.isArray(payload.skinGuids) && skinGuids === undefined) return undefined;
  return {
    kind: 'scene',
    entities,
    ...(skinGuids === undefined ? {} : { skinGuids }),
  };
}
