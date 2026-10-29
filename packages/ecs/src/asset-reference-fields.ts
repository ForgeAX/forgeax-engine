import {
  ASSET_ERROR_HINTS,
  AssetError,
  type AssetReferenceOwner,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { Component } from './component';
import { componentDefinition } from './component-schema';

const NO_ASSET_FIELDS: Result<undefined, AssetError> = Object.freeze(ok(undefined));

/** Visit references in the supplied binding only; never inspect existing holders. */
export function visitAssetFields(
  component: Component,
  data: Readonly<Record<string, unknown>>,
  visit: (handle: number, target: string) => Result<void, AssetError>,
): Result<void, AssetError> {
  // Guard outside the closure-capturing body (see holdAssetFields).
  if (!componentDefinition(component).plan.hasAssetField) return NO_ASSET_FIELDS;
  return visitDeclaredAssetFields(component, data, visit);
}

function visitDeclaredAssetFields(
  component: Component,
  data: Readonly<Record<string, unknown>>,
  visit: (handle: number, target: string) => Result<void, AssetError>,
): Result<void, AssetError> {
  const fields = componentDefinition(component).fields;
  for (const key of Object.keys(data)) {
    const field = fields[key];
    if (field === undefined) continue;
    const type = field.arrayMeta?.elementType ?? field.type;
    if (!type.startsWith('asset<')) continue;
    const target = type.slice(6, -1);
    const value = data[key];
    if (value === undefined || value === null || value === 0) continue;
    const validate = (handle: unknown): Result<void, AssetError> => {
      if (
        typeof handle !== 'number' ||
        !Number.isInteger(handle) ||
        handle < 0 ||
        handle > 0xffff_ffff
      )
        return err(invalidAssetBinding(`${component.name}.${key}: a runtime ${target} reference`));
      return handle === 0 ? ok(undefined) : visit(handle, target);
    };
    if (field.arrayMeta === undefined) {
      const result = validate(value);
      if (!result.ok) return result;
    } else {
      // Float/byte views cannot carry u32 reference encodings. Do not reinterpret them.
      if (!Array.isArray(value) && !(value instanceof Uint32Array))
        return err(invalidAssetBinding(`${component.name}.${key}: a reference array`));
      const count = Math.min(value.length, field.arrayMeta.length ?? value.length);
      for (let i = 0; i < count; i++) {
        const result = validate(value[i]);
        if (!result.ok) return result;
      }
    }
  }
  return ok(undefined);
}

export function invalidAssetBinding(expected: string): AssetError {
  return new AssetError({
    code: 'asset-reference-invalid',
    expected,
    hint: ASSET_ERROR_HINTS['asset-reference-invalid'],
  });
}

/** Owner disposal already retires its contents; later World teardown needs no release. */
export function releaseAssetReference(
  owner: AssetReferenceOwner | undefined,
  handle: number,
): void {
  if (handle === 0) return;
  if (owner === undefined) throw invalidAssetBinding('the attached asset owner during release');
  const released = owner.release(handle);
  if (!released.ok && released.error.code !== 'asset-owner-closed') throw released.error;
}

/** A temporary hold allows swaps across fields even when the World is the last holder. */
export function holdAssetFields(
  owner: AssetReferenceOwner | undefined,
  component: Component,
  data: Readonly<Record<string, unknown>>,
): Result<(() => void) | undefined, AssetError> {
  // The guard lives outside the closure-capturing body: V8 allocates that
  // body's context on entry, before any early return.
  if (!componentDefinition(component).plan.hasAssetField) return NO_ASSET_FIELDS;
  return holdDeclaredAssetFields(owner, component, data);
}

function holdDeclaredAssetFields(
  owner: AssetReferenceOwner | undefined,
  component: Component,
  data: Readonly<Record<string, unknown>>,
): Result<(() => void) | undefined, AssetError> {
  let held: number[] | undefined;
  const release = () => {
    if (held !== undefined) for (const handle of held) releaseAssetReference(owner, handle);
  };
  const result = visitAssetFields(component, data, (handle, target) => {
    if (owner === undefined)
      return err(invalidAssetBinding('an asset owner attached to the World'));
    const retained = owner.retain(handle, target);
    if (retained.ok) {
      held ??= [];
      held.push(handle);
    }
    return retained;
  });
  if (!result.ok) {
    release();
    return result;
  }
  return ok(held === undefined ? undefined : release);
}
