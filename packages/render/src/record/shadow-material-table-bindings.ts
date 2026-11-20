import {
  type BindGroup,
  type BindGroupDescriptor,
  type Buffer,
  err,
  ok,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { GpuSceneTableBindingTarget } from '../gpu-scene';
import type { MaterialTableBindingPreparation } from './material-bg-assembly-cache';
import { findFromChain, publishToChain } from './mesh-ssbo';

const variant = 'shadow-material-singleton';
interface Recipe {
  readonly cache: WeakMap<object, unknown>;
  readonly handles: readonly object[];
  readonly descriptor: BindGroupDescriptor;
  readonly sceneBuffer: Buffer;
}
// Issued-handle metadata only: native ownership and lookup remain with the original cache.
const recipes = new WeakMap<BindGroup, Recipe>();
export function captureShadowMaterialBinding(group: BindGroup, recipe: Recipe): void {
  recipes.set(group, recipe);
}
function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'the exact original shadow material cache and Scene table successor',
    hint: 'retry the actual owner after its bindings settle',
  });
}

/** Compose the existing authored material owner with the actual opaque shadow singleton producer. */
export function prepareShadowMaterialTableBindings(
  base: MaterialTableBindingPreparation,
  device: RhiDevice,
  cache: WeakMap<object, unknown>,
  target: GpuSceneTableBindingTarget,
  current: () => boolean,
): MaterialTableBindingPreparation {
  let closed = false;
  const rows = new Map<
    BindGroup,
    {
      readonly before: Recipe;
      readonly next: Recipe;
      readonly group: BindGroup;
      readonly expected: BindGroup | undefined;
    }
  >();
  const live = () =>
    !closed &&
    current() &&
    base.isCurrent() &&
    [...rows].every(
      ([group, row]) =>
        findFromChain(cache, row.before.handles, variant) === group &&
        findFromChain(cache, row.next.handles, variant) === row.expected,
    );
  const release = () => {
    closed = true;
    base.release();
    rows.clear();
  };
  return Object.freeze({
    isCurrent: live,
    replacement(group: BindGroup): BindGroup | undefined {
      const material = base.replacement(group);
      if (material !== undefined) return material;
      const known = rows.get(group);
      if (known !== undefined) return known.group;
      const before = recipes.get(group);
      if (
        !live() ||
        before?.cache !== cache ||
        findFromChain(cache, before.handles, variant) !== group
      )
        return undefined;
      const handles = before.handles.map((handle) =>
        handle === target.owner.materialBuffer ? target.materialBuffer : handle,
      );
      if (before.sceneBuffer !== target.owner.materialBuffer) {
        rows.set(group, { before, next: before, group, expected: group });
        return group;
      }
      const expected = findFromChain(cache, handles, variant);
      const descriptor: BindGroupDescriptor = {
        ...before.descriptor,
        entries: Array.from(before.descriptor.entries, (entry) =>
          entry.binding === 46 &&
          entry.resource.kind === 'buffer' &&
          entry.resource.value.buffer === before.sceneBuffer
            ? {
                ...entry,
                resource: {
                  kind: 'buffer' as const,
                  value: { ...entry.resource.value, buffer: target.materialBuffer },
                },
              }
            : entry,
        ),
      };
      const replacement = expected ?? device.createBindGroup(descriptor).unwrap();
      if (!live()) throw stale();
      const next: Recipe = { cache, handles, descriptor, sceneBuffer: target.materialBuffer };
      rows.set(group, { before, next, group: replacement, expected });
      return replacement;
    },
    publish() {
      if (!live()) return err(stale());
      const published = base.publish();
      if (!published.ok) return published;
      for (const row of rows.values()) {
        publishToChain(cache, row.next.handles, variant, row.group);
        captureShadowMaterialBinding(row.group, row.next);
      }
      release();
      return ok(undefined);
    },
    release,
  });
}
