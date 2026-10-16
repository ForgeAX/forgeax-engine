import type { EcsError, World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { BUILTIN_BASE, err, ok, type Result, type SceneAsset } from '@forgeax/engine-types';

/** The instance source remains readable when a live component is overridden. */
export function retainSceneSourceReferences(
  world: World,
  asset: SceneAsset,
): Result<() => void, EcsError> {
  const handles = new Set<number>();
  const collect = (components: SceneAsset['entities'][string]['components']) => {
    for (const [name, values] of Object.entries(components)) {
      const token = world.components.resolve(name);
      if (!token || !values) continue;
      const schema = componentSchema(token);
      for (const [field, value] of Object.entries(values)) {
        const shape = schema[field];
        const refs = shape?.startsWith('shared<')
          ? [value]
          : shape?.startsWith('array<shared<') &&
              (Array.isArray(value) || ArrayBuffer.isView(value))
            ? Array.from(value as ArrayLike<unknown>)
            : [];
        for (const ref of refs)
          if (typeof ref === 'number' && ref >= BUILTIN_BASE) handles.add(ref);
      }
    }
  };
  for (const node of Object.values(asset.entities)) {
    collect(node.components);
    for (const override of node.instance?.overrides ?? []) collect(override.components);
  }
  const retained: number[] = [];
  const release = () => {
    for (const handle of retained.splice(0)) world.sharedRefs.release(handle as never);
  };
  for (const handle of handles) {
    const result = world.sharedRefs.retain(handle as never);
    if (!result.ok) {
      release();
      return err(result.error as unknown as EcsError);
    }
    retained.push(handle);
  }
  return ok(release);
}
