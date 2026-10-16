// @forgeax/engine-assets-runtime -- keyed scene payload parse + ref resolution

import type { SceneAsset, SceneEntity, SceneInstanceOverride } from '@forgeax/engine-types';
import { HANDLE_ARRAY_FIELD_NAMES, HANDLE_FIELD_NAMES } from './handles';

interface ParseSceneError {
  readonly entityKey: string;
  readonly component: string;
  readonly field: string;
  readonly index: number;
  readonly refsLength: number;
}

function isParseSceneError(value: unknown): value is ParseSceneError {
  return typeof value === 'object' && value !== null && 'entityKey' in value && 'index' in value;
}

function resolveFields(
  entityKey: string,
  componentName: string,
  rawFields: Record<string, unknown>,
  refs: readonly string[] | undefined,
): Record<string, unknown> | ParseSceneError | undefined {
  const resolved: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(rawFields)) {
    const handleField =
      HANDLE_FIELD_NAMES.has(fieldName) || HANDLE_FIELD_NAMES.has(`${componentName}.${fieldName}`);
    if (handleField && value === null) {
      resolved[fieldName] = 0;
      continue;
    }
    if (refs !== undefined && handleField && typeof value === 'number' && Number.isInteger(value)) {
      if (value < 0 || value >= refs.length) {
        return {
          entityKey,
          component: componentName,
          field: fieldName,
          index: value,
          refsLength: refs.length,
        };
      }
      resolved[fieldName] = refs[value];
      continue;
    }
    if (HANDLE_ARRAY_FIELD_NAMES.has(fieldName) && Array.isArray(value)) {
      const values: unknown[] = [];
      for (const [arrayIndex, item] of value.entries()) {
        if (item === null) {
          values.push(0);
          continue;
        }
        if (refs === undefined || typeof item !== 'number' || !Number.isInteger(item)) {
          values.push(item);
          continue;
        }
        if (item < 0 || item >= refs.length) {
          return {
            entityKey,
            component: componentName,
            field: `${fieldName}[${arrayIndex}]`,
            index: item,
            refsLength: refs.length,
          };
        }
        values.push(refs[item]);
      }
      resolved[fieldName] = values;
      continue;
    }
    resolved[fieldName] = value;
  }
  return resolved;
}

function resolveComponents(
  entityKey: string,
  rawComponents: unknown,
  refs: readonly string[] | undefined,
): Record<string, Record<string, unknown>> | ParseSceneError | undefined {
  if (rawComponents === null || typeof rawComponents !== 'object' || Array.isArray(rawComponents))
    return undefined;
  const components: Record<string, Record<string, unknown>> = {};
  for (const [componentName, rawFields] of Object.entries(
    rawComponents as Record<string, unknown>,
  )) {
    if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields))
      return undefined;
    const resolved = resolveFields(
      entityKey,
      componentName,
      rawFields as Record<string, unknown>,
      refs,
    );
    if (resolved === undefined) return undefined;
    if (isParseSceneError(resolved)) return resolved;
    components[componentName] = resolved as Record<string, unknown>;
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

/** Reconstruct and resolve a keyed SceneAsset from one pack payload. */
export function parseScenePayload(
  payload: Record<string, unknown>,
  refs?: string[],
): SceneAsset | ParseSceneError | undefined {
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
    const components = resolveComponents(entityKey, entity.components ?? {}, refs);
    if (components === undefined || isParseSceneError(components)) return components;
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
        const overrideComponents = resolveComponents(entityKey, override.components ?? {}, refs);
        if (overrideComponents === undefined || isParseSceneError(overrideComponents))
          return overrideComponents;
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
