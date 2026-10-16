import {
  type AssetDecoder,
  type AssetDecoderContribution,
  type AssetKind,
  type AssetLoadError,
  err,
  ok,
  type Result,
  type SceneAsset,
  type SceneEntity,
  type SceneInstanceOverride,
} from '@forgeax/engine-types';
import { normalizeLegacySceneAsset } from '../instances/legacy.js';

export const sceneAssetKind: AssetKind<SceneAsset, 'scene'> = {
  kind: 'scene',
} as AssetKind<SceneAsset, 'scene'>;

function invalidScene(guid: string, reason: string): Result<SceneAsset, AssetLoadError> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a scene payload with keyed entities',
    hint: 'recook the SceneAsset and publish its complete envelope',
    detail: { guid, reason },
  });
}

type SceneWireRefResult =
  | { readonly ok: true; readonly value: SceneAsset }
  | { readonly ok: false; readonly reason: string };

function resolveWireRef(
  refs: readonly string[],
  value: number,
  location: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const guid = refs[value];
  if (!Number.isInteger(value) || value < 0 || guid === undefined) {
    return {
      ok: false,
      reason: `${location} references refs[${value}], but refs contains ${refs.length} entries`,
    };
  }
  return { ok: true, value: guid };
}

function resolveInstanceSource(
  source: unknown,
  refs: readonly string[],
  location: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  if (typeof source === 'string' && source.length > 0) return { ok: true, value: source };
  if (typeof source !== 'number' || !Number.isInteger(source)) {
    return { ok: false, reason: `${location} must be a GUID or refs index` };
  }
  return resolveWireRef(refs, source, location);
}

function resolveSkinGuids(
  skinGuids: readonly (number | string)[] | undefined,
  refs: readonly string[],
):
  | { readonly ok: true; readonly value: readonly string[] | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (skinGuids === undefined) return { ok: true, value: undefined };
  const resolved: string[] = [];
  for (let index = 0; index < skinGuids.length; index += 1) {
    const value = skinGuids[index];
    if (typeof value === 'string') {
      resolved.push(value);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, reason: `skinGuids[${index}] is not a GUID or refs index` };
    }
    const ref = resolveWireRef(refs, value, `skinGuids[${index}]`);
    if (!ref.ok) return ref;
    resolved.push(ref.value);
  }
  return { ok: true, value: resolved };
}

function resolveSceneWireRefs(
  payload: { readonly entities: unknown; readonly skinGuids?: unknown },
  refs: readonly string[],
): SceneWireRefResult {
  const normalized = normalizeLegacySceneAsset({ kind: 'scene', entities: payload.entities });
  const rawEntities = normalized.entities;
  if (rawEntities === null || typeof rawEntities !== 'object' || Array.isArray(rawEntities)) {
    return { ok: false, reason: 'entities must be a keyed object' };
  }
  const entities: Record<string, SceneEntity> = {};
  for (const [key, rawEntity] of Object.entries(rawEntities as Record<string, unknown>)) {
    const entity = rawEntity as
      | {
          readonly components?: unknown;
          readonly instance?: {
            readonly source?: unknown;
            readonly overrides?: unknown;
          };
        }
      | undefined;
    if (key.length === 0 || entity === undefined || typeof entity !== 'object') {
      return { ok: false, reason: `entities[${JSON.stringify(key)}] is malformed` };
    }
    if (
      entity.components === null ||
      typeof entity.components !== 'object' ||
      Array.isArray(entity.components)
    ) {
      return { ok: false, reason: `entities.${key}.components must be an object` };
    }
    const components: Record<string, Record<string, unknown>> = {};
    for (const [componentName, rawFields] of Object.entries(
      entity.components as Record<string, unknown>,
    )) {
      if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
        return {
          ok: false,
          reason: `entities.${key}.components.${componentName} must be an object`,
        };
      }
      // Component schema lookup is World-local after the ECS core reduction.
      // The runtime projection owns the World-local schema and converts
      // authored GUID fields into World.sharedRefs handles. Keep this loader
      // boundary POD-only instead of consulting a removed process-global ECS
      // component registry.
      components[componentName] = { ...(rawFields as Record<string, unknown>) };
    }
    const instance = entity.instance;
    let resolvedInstance: SceneEntity['instance'];
    if (instance !== undefined) {
      if (instance === null || typeof instance !== 'object') {
        return { ok: false, reason: `entities.${key}.instance must be an object` };
      }
      const source = resolveInstanceSource(
        instance.source,
        refs,
        `entities.${key}.instance.source`,
      );
      if (!source.ok) return source;
      if (instance.overrides !== undefined && !Array.isArray(instance.overrides)) {
        return { ok: false, reason: `entities.${key}.instance.overrides must be an array` };
      }
      let overrides: NonNullable<SceneEntity['instance']>['overrides'] | undefined;
      if (instance.overrides === undefined) {
        overrides = undefined;
      } else {
        const resolvedOverrides: SceneInstanceOverride[] = [];
        for (const [index, rawOverride] of (instance.overrides as readonly unknown[]).entries()) {
          if (
            rawOverride === null ||
            typeof rawOverride !== 'object' ||
            Array.isArray(rawOverride) ||
            !Array.isArray((rawOverride as { readonly target?: unknown }).target) ||
            (rawOverride as { readonly target?: unknown[] }).target?.some(
              (part) => typeof part !== 'string' || part.length === 0,
            )
          ) {
            return {
              ok: false,
              reason: `entities.${key}.instance.overrides[${index}] is malformed`,
            };
          }
          const target = (rawOverride as { readonly target: readonly string[] }).target;
          const rawComponents = (rawOverride as { readonly components?: unknown }).components;
          if (
            rawComponents === null ||
            typeof rawComponents !== 'object' ||
            Array.isArray(rawComponents)
          ) {
            return {
              ok: false,
              reason: `entities.${key}.instance.overrides[${index}].components is malformed`,
            };
          }
          resolvedOverrides.push({
            target: [...target] as [string, ...string[]],
            components: rawComponents as SceneEntity['components'],
          });
        }
        overrides = resolvedOverrides;
      }
      resolvedInstance = {
        source: source.value,
        ...(overrides === undefined ? {} : { overrides }),
      };
    }
    entities[key] = {
      components,
      ...(resolvedInstance === undefined ? {} : { instance: resolvedInstance }),
    };
  }

  const skinGuids = resolveSkinGuids(
    Array.isArray(payload.skinGuids)
      ? (payload.skinGuids as readonly (number | string)[])
      : payload.skinGuids === undefined
        ? undefined
        : ([] as readonly (number | string)[]),
    refs,
  );
  if (!skinGuids.ok) return skinGuids;

  return {
    ok: true,
    value: {
      kind: 'scene',
      entities,
      ...(skinGuids.value === undefined ? {} : { skinGuids: skinGuids.value }),
    },
  };
}

/** Scene owns structural validation; World-local projection resolves shared refs. */
export const sceneAssetDecoder: AssetDecoder<SceneAsset> = {
  async decode({ envelope }): Promise<Result<SceneAsset, AssetLoadError>> {
    const payload = envelope.payload;
    if (
      payload.kind !== 'scene' ||
      payload.entities === null ||
      typeof payload.entities !== 'object'
    ) {
      return invalidScene(envelope.guid, 'scene payload is missing keyed entities');
    }
    const resolved = resolveSceneWireRefs(payload, envelope.refs);
    if (!resolved.ok) return invalidScene(envelope.guid, resolved.reason);
    return ok(resolved.value);
  },
};

export const sceneAssetContribution: AssetDecoderContribution<SceneAsset, 'scene'> = {
  kind: sceneAssetKind,
  decoder: sceneAssetDecoder,
  consumer: 'Scene',
};
