import type { EcsError, World } from '@forgeax/engine-ecs';
import { componentSchema, parseManagedArraySchema } from '@forgeax/engine-ecs/internal';
import { AssetError, err, ok, type Result, type SceneAsset } from '@forgeax/engine-types';

/** Hold the instance's captured source values independently of later template edits. */
export function retainSceneSourceReferences(
  world: World,
  asset: SceneAsset,
): Result<() => void, EcsError> {
  const assets = new Set<number>();
  const shared = new Set<number>();
  const collect = (components: SceneAsset['entities'][string]['components']) => {
    for (const [name, values] of Object.entries(components)) {
      const token = world.components.resolve(name);
      if (!token || !values) continue;
      const schema = componentSchema(token);
      for (const [field, value] of Object.entries(values)) {
        const shape = schema[field];
        if (shape === undefined) continue;
        const array = parseManagedArraySchema(shape);
        const element = array?.elementType ?? shape;
        const handles = element.startsWith('asset<')
          ? assets
          : element.startsWith('shared<')
            ? shared
            : undefined;
        if (handles === undefined) continue;
        const refs =
          array !== null && (Array.isArray(value) || ArrayBuffer.isView(value))
            ? Array.from(value as ArrayLike<unknown>)
            : [value];
        for (const ref of refs) if (typeof ref === 'number' && ref !== 0) handles.add(ref);
      }
    }
  };
  for (const node of Object.values(asset.entities)) {
    collect(node.components);
    for (const override of node.instance?.overrides ?? []) collect(override.components);
  }
  const retainedAssets: number[] = [];
  const retainedShared: number[] = [];
  const release = () => {
    for (const handle of retainedAssets.splice(0)) world.assets?.release(handle);
    for (const handle of retainedShared.splice(0)) world.sharedRefs.release(handle as never);
  };
  for (const handle of assets) {
    const result = world.assets?.retain(handle);
    if (result === undefined || !result.ok) {
      release();
      return err(
        (result?.error ??
          new AssetError({
            code: 'asset-reference-invalid',
            expected: 'an attached runtime asset owner',
            hint: 'bind the asset owner before instantiating a scene',
          })) as unknown as EcsError,
      );
    }
    retainedAssets.push(handle);
  }
  for (const handle of shared) {
    const result = world.sharedRefs.retain(handle as never);
    if (!result.ok) {
      release();
      return err(result.error as unknown as EcsError);
    }
    retainedShared.push(handle);
  }
  return ok(release);
}
