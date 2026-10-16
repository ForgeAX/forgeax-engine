import type { AssetRef, SceneAsset, SceneInstanceOverride } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { migrateLegacySceneComponentFields, normalizeLegacySceneAsset } from './legacy.js';

export type SceneComponentSchemaResolver = (
  componentName: string,
) => Readonly<Record<string, string>> | undefined;

export interface SceneExternalizationError {
  readonly field: string;
  readonly value: unknown;
}

export interface ExternalizedSceneAsset {
  readonly payload: Record<string, unknown>;
  readonly refs: readonly AssetRef[];
}

function sharedKind(type: string | undefined): 'one' | 'many' | undefined {
  if (type?.startsWith('shared<')) return 'one';
  if (type?.startsWith('array<shared<')) return 'many';
  return undefined;
}

interface RefContext {
  readonly refs: AssetRef[];
  readonly indexByGuid: Map<string, number>;
}

function addRef(
  context: RefContext,
  guid: string,
  sourceField: NonNullable<AssetRef['sourceField']>,
  sceneEntityKey?: string,
): number {
  const prior = context.indexByGuid.get(guid);
  if (prior !== undefined) return prior;
  const index = context.refs.length;
  context.refs.push({
    guid,
    sourceField,
    ...(sceneEntityKey === undefined ? {} : { sceneEntityKey }),
  } as AssetRef);
  context.indexByGuid.set(guid, index);
  return index;
}

function externalizeFields(
  componentName: string,
  source: Record<string, unknown>,
  resolveSchema: SceneComponentSchemaResolver,
  context: RefContext,
  sceneEntityKey: string | undefined,
): Record<string, unknown> {
  const schema = resolveSchema(componentName);
  const fields: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(
    migrateLegacySceneComponentFields(componentName, source),
  )) {
    if (value === undefined) continue;
    const kind = sharedKind(schema?.[fieldName]);
    if (kind === 'one' && value === 0) {
      // Null distinguishes an empty shared handle from refs[0] on the wire.
      fields[fieldName] = null;
    } else if (kind === 'one' && typeof value === 'string') {
      fields[fieldName] = addRef(context, value, { componentName, fieldName }, sceneEntityKey);
    } else if (kind === 'many' && Array.isArray(value)) {
      fields[fieldName] = value.map((item, arrayIndex) =>
        typeof item === 'string'
          ? addRef(context, item, { componentName, fieldName, arrayIndex }, sceneEntityKey)
          : item === 0
            ? null
            : item,
      );
    } else {
      fields[fieldName] = value;
    }
  }
  return fields;
}

function externalizeOverride(
  override: SceneInstanceOverride,
  resolveSchema: SceneComponentSchemaResolver,
  context: RefContext,
  sceneEntityKey: string,
): SceneInstanceOverride {
  const components: Record<string, Record<string, unknown>> = {};
  for (const [componentName, rawFields] of Object.entries(override.components)) {
    components[componentName] = externalizeFields(
      componentName,
      { ...(rawFields as Record<string, unknown>) },
      resolveSchema,
      context,
      sceneEntityKey,
    );
  }
  return {
    target: [...override.target],
    components,
  };
}

/** Project a keyed SceneAsset's shared asset fields into a payload plus refs. */
export function externalizeSceneAsset(
  scene: SceneAsset,
  resolveSchema: SceneComponentSchemaResolver,
): Result<ExternalizedSceneAsset, SceneExternalizationError> {
  const normalized = normalizeLegacySceneAsset(scene);
  const context: RefContext = { refs: [], indexByGuid: new Map() };
  const entities: Record<string, Record<string, unknown>> = {};
  for (const [key, entity] of Object.entries(normalized.entities)) {
    const components: Record<string, Record<string, unknown>> = {};
    for (const [componentName, raw] of Object.entries(entity.components)) {
      const source = raw as Record<string, unknown> | undefined;
      if (source === undefined) continue;
      components[componentName] = externalizeFields(
        componentName,
        source,
        resolveSchema,
        context,
        key,
      );
    }
    const instance = entity.instance;
    entities[key] = {
      components,
      ...(instance === undefined
        ? {}
        : {
            instance: {
              source: addRef(
                context,
                instance.source,
                { componentName: 'SceneInstance', fieldName: 'source' },
                key,
              ),
              ...(instance.overrides === undefined
                ? {}
                : {
                    overrides: instance.overrides.map((override) =>
                      externalizeOverride(override, resolveSchema, context, key),
                    ),
                  }),
            },
          }),
    };
  }

  for (const [arrayIndex, guid] of (normalized.skinGuids ?? []).entries()) {
    if (typeof guid !== 'string') return err({ field: 'skinGuids', value: guid });
    addRef(context, guid, { componentName: '<scene>', fieldName: 'skinGuids', arrayIndex });
  }
  return ok({
    payload: {
      kind: 'scene',
      entities,
      ...(normalized.skinGuids === undefined
        ? {}
        : {
            skinGuids: normalized.skinGuids.map((guid) => context.indexByGuid.get(guid) as number),
          }),
    },
    refs: context.refs,
  });
}
