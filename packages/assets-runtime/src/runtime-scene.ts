import type { Component } from '@forgeax/engine-ecs';
import { componentSchema, parseManagedArraySchema } from '@forgeax/engine-ecs/internal';
import {
  AssetError,
  type AssetHandle,
  err,
  ok,
  type Result,
  type SceneAsset,
  type SceneEntity,
} from '@forgeax/engine-types';
import { resolveSceneComponentFields } from './scene-payload';

/** Source indices and GUIDs become runtime references once, before the asset is published. */
export function prepareRuntimeScene<E>(
  scene: SceneAsset,
  component: (name: string) => Component | undefined,
  reference: (value: string | number, target: string) => Result<number, E>,
  refs?: readonly string[],
): Result<{ value: SceneAsset; dependencies: readonly number[] }, AssetError | E> {
  const dependencies = new Set<number>();
  const resolve = (value: string | number, target: string): Result<number, E> => {
    const result = reference(value, target);
    if (result.ok && result.value !== 0) dependencies.add(result.value);
    return result;
  };
  const components = (
    entityKey: string,
    source: SceneEntity['components'],
  ): Result<SceneEntity['components'], AssetError | E> => {
    const output: Record<string, Record<string, unknown>> = {};
    for (const [name, fields] of Object.entries(source)) {
      if (fields === undefined) continue;
      const token = component(name);
      if (token === undefined)
        return err(
          new AssetError({
            code: 'asset-invalid-value',
            expected: `the component schema for ${name}`,
            hint: 'register the Scene component vocabulary before creating or loading runtime content',
          }),
        );
      const schema = componentSchema(token);
      const decoded = resolveSceneComponentFields(
        entityKey,
        name,
        fields as Record<string, unknown>,
        refs,
        schema,
      );
      if (!decoded.ok)
        return err(
          new AssetError({
            code: 'asset-parse-failed',
            expected: 'Scene references to index the owning source table',
            hint: 'recook the Scene with its complete references',
            detail: decoded.error,
          }),
        );
      for (const [field, value] of Object.entries(decoded.value)) {
        const type = schema[field];
        if (type === undefined) continue; // The Scene compiler owns the complete component schema check.
        const array = parseManagedArraySchema(type);
        const element = array?.elementType ?? type;
        if (!element.startsWith('asset<')) continue;
        const target = element.slice(6, -1);
        const values = array === null ? [value] : Array.isArray(value) ? value : undefined;
        if (values === undefined)
          return err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: `asset reference array ${name}.${field}`,
              hint: 'pass runtime references or source GUIDs matching the component schema',
            }),
          );
        const handles: number[] = [];
        for (const item of values) {
          if (typeof item !== 'number' && typeof item !== 'string')
            return err(
              new AssetError({
                code: 'asset-reference-invalid',
                expected: `a ${target} reference in ${name}.${field}`,
                hint: 'use a reference returned by this runtime asset owner',
              }),
            );
          const linked = resolve(item, target);
          if (!linked.ok) return linked;
          handles.push(linked.value);
        }
        decoded.value[field] = array === null ? handles[0] : handles;
      }
      output[name] = decoded.value;
    }
    return ok(output);
  };
  const entities: Record<string, SceneEntity> = {};
  for (const [key, node] of Object.entries(scene.entities)) {
    const fields = components(key, node.components);
    if (!fields.ok) return fields;
    const overrides = [];
    let source: AssetHandle<'scene'> | undefined;
    if (node.instance !== undefined) {
      const nested = resolve(node.instance.source, 'scene');
      if (!nested.ok) return nested;
      source = nested.value as AssetHandle<'scene'>;
      for (const override of node.instance.overrides ?? []) {
        const fields = components(`${key}.${override.target.join('.')}`, override.components);
        if (!fields.ok) return fields;
        overrides.push({ ...override, components: fields.value });
      }
    }
    entities[key] = {
      components: fields.value,
      ...(node.instance === undefined
        ? {}
        : {
            instance: {
              ...node.instance,
              source: source as AssetHandle<'scene'>,
              ...(node.instance.overrides === undefined ? {} : { overrides }),
            },
          }),
    };
  }
  for (const guid of scene.skinGuids ?? []) {
    const skin = resolve(guid, 'skin');
    if (!skin.ok) return skin;
  }
  return ok({ value: { ...scene, entities }, dependencies: [...dependencies] });
}
