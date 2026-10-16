// @forgeax/engine-assets-runtime -- resolveAssetHandle + material-walk coverage
// (fix issue #709). Exercises the two-tier slot dispatch (builtin vs user-tier),
// the stale/released/not-found error arms, and the material parent-chain walk
// (single, inherited, override-by-name, missing-parent, cycle).

import { World } from '@forgeax/engine-ecs';
import type { Asset, Handle, MaterialAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE, handleGeneration, handleSlot, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { HANDLE_CUBE } from '../handles';
import { resolveAssetHandle, walkMaterialPassesOverSharedRefs } from '../resolve-asset-handle';

describe('resolveAssetHandle two-tier dispatch', () => {
  it('resolves a builtin mesh handle (slot < BUILTIN_BASE)', () => {
    const res = resolveAssetHandle(new World(), HANDLE_CUBE as Handle<string, 'shared'>);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as { kind: string }).kind).toBe('mesh');
  });

  it('errors with asset-not-found for an unoccupied builtin slot', () => {
    const bogus = toShared<'MeshAsset'>(999); // in [1, BUILTIN_BASE) but not a real builtin
    const res = resolveAssetHandle(new World(), bogus as Handle<string, 'shared'>);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('asset-not-found');
  });

  it('resolves a user-tier handle minted via allocSharedRef', () => {
    const world = new World();
    const payload = { kind: 'material', passes: [] } as unknown as Asset;
    const handle = world.allocSharedRef('MaterialAsset', payload);
    const res = resolveAssetHandle(world, handle as Handle<string, 'shared'>);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(payload);
  });

  it('forwards the stale error after the handle slot is released + re-allocated', () => {
    const world = new World();
    const handle = world.allocSharedRef('MaterialAsset', { kind: 'material' } as unknown as Asset);
    world.sharedRefs.release(handle as Handle<string, 'shared'>);
    // Releasing bumps the slot generation, so the stale handle now resolves to
    // the transparently-forwarded shared-ref-stale error (D-3 / AC-10), not a
    // flattened asset-not-found.
    const res = resolveAssetHandle(world, handle as Handle<string, 'shared'>);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('shared-ref-stale');
  });

  it('forwards exact stale detail without exposing the replacement payload', () => {
    const world = new World();
    const oldPayload = { kind: 'material', values: { baseColor: [1, 0, 0] } } as unknown as Asset;
    const oldHandle = world.allocSharedRef('MaterialAsset', oldPayload);
    const oldSlot = handleSlot(oldHandle);
    const oldGeneration = handleGeneration(oldHandle);

    expect(world.sharedRefs.release(oldHandle).ok).toBe(true);
    const replacementPayload = {
      kind: 'material',
      values: { baseColor: [0, 0, 1] },
    } as unknown as Asset;
    const replacementHandle = world.allocSharedRef('MaterialAsset', replacementPayload);

    expect(handleSlot(replacementHandle)).toBe(oldSlot);
    expect(handleGeneration(replacementHandle)).toBe(oldGeneration + 1);

    const res = resolveAssetHandle(world, oldHandle as Handle<string, 'shared'>);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('shared-ref-stale');
    expect(res.error.detail).toEqual({
      slot: oldSlot,
      expectedGeneration: oldGeneration,
      actualGeneration: handleGeneration(replacementHandle),
    });
    expect('value' in res.error).toBe(false);

    const foreignModuleWorld = {
      sharedRefs: {
        resolve: () => ({
          ok: false,
          error: {
            code: 'shared-ref-stale' as const,
            detail: {
              slot: oldSlot,
              expectedGeneration: oldGeneration,
              actualGeneration: handleGeneration(replacementHandle),
            },
          },
        }),
      },
    } as unknown as World;
    const bridged = resolveAssetHandle(foreignModuleWorld, oldHandle as Handle<string, 'shared'>);
    expect(bridged).toEqual({
      ok: false,
      error: {
        code: 'shared-ref-stale',
        detail: {
          slot: oldSlot,
          expectedGeneration: oldGeneration,
          actualGeneration: handleGeneration(replacementHandle),
        },
      },
    });

    const replacement = resolveAssetHandle(world, replacementHandle as Handle<string, 'shared'>);
    expect(replacement).toMatchObject({ ok: true, value: replacementPayload });
    expect(replacement.ok && replacement.value).not.toBe(oldPayload);
  });

  it('errors with asset-not-found for an unallocated user-tier slot', () => {
    const res = resolveAssetHandle(
      new World(),
      toShared<'MeshAsset'>(BUILTIN_BASE + 5) as Handle<string, 'shared'>,
    );
    expect(res.ok).toBe(false);
  });
});

function mat(over: Partial<MaterialAsset>): MaterialAsset {
  return { kind: 'material', ...over } as MaterialAsset;
}

describe('walkMaterialPassesOverSharedRefs', () => {
  it('removes disabled defaults and values from the runtime extraction contract', () => {
    const world = new World();
    const handle = world.allocSharedRef(
      'MaterialAsset',
      mat({
        passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
        parameters: [
          { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
          { name: 'subsurfaceWeight', type: 'f32', default: 1 },
          { name: 'baseColorTexture', type: 'texture' },
        ],
        values: { baseColorTexture: 'inactive' },
        staticSwitches: { subsurfaceDiffusion: false, textures: false },
      }),
    );
    const selected = walkMaterialPassesOverSharedRefs(world, handle, {
      lookup: () => undefined,
    }).unwrap();
    expect(selected.parameters?.map((parameter) => parameter.name)).toEqual(['baseColor']);
    expect(selected.values).toEqual({ baseColor: [1, 1, 1, 1] });
  });

  it('returns the passes of a single childless material', () => {
    const world = new World();
    const handle = world.allocSharedRef(
      'MaterialAsset',
      mat({
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: { a: 1 },
      }),
    );
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.passes.map((p) => p.name)).toEqual(['main']);
    expect(res.value.values).toEqual({ a: 1 });
  });

  it('applies root defaults before rendering while preserving child zero overrides', () => {
    const world = new World();
    const parent = mat({
      passes: [{ name: 'Forward', program: { module: 'game::toon' } }],
      parameters: [
        { name: 'amount', type: 'f32', default: 0.7 },
        { name: 'tint', type: 'color', default: [0.5, 0.5, 0.5, 1] },
      ],
      values: {},
    });
    const child = mat({ parent: 'p-guid' as never, values: { amount: 0 } });
    const rootHandle = world.allocSharedRef('MaterialAsset', parent);
    const childHandle = world.allocSharedRef('MaterialAsset', child);
    expect(
      walkMaterialPassesOverSharedRefs(world, rootHandle, { lookup: () => parent }).unwrap().values,
    ).toEqual({ amount: 0.7, tint: [0.5, 0.5, 0.5, 1] });
    expect(
      walkMaterialPassesOverSharedRefs(world, childHandle, { lookup: () => parent }).unwrap()
        .values,
    ).toEqual({ amount: 0, tint: [0.5, 0.5, 0.5, 1] });
    expect(parent.values).toEqual({});
    expect(child.values).toEqual({ amount: 0 });
  });

  it('inherits parent passes when the child declares none, merging values', () => {
    const world = new World();
    const parent = mat({
      passes: [{ name: 'base', program: { module: 'forgeax::standard' } }],
      values: { a: 1, b: 2 },
    });
    const child = mat({ parent: 'p-guid' as never, values: { b: 20 } });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => parent });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.passes.map((p) => p.name)).toEqual(['base']);
    expect(res.value.values).toEqual({ a: 1, b: 20 }); // child overrides
  });

  it('rejects child declarations that add parameter bindings', () => {
    const world = new World();
    const parent = mat({
      passes: [{ name: 'base', program: { module: 'forgeax::standard' } }],
      parameters: [
        { name: 'baseColor', type: 'color' },
        { name: 'roughness', type: 'f32' },
      ],
    });
    const child = mat({
      parent: 'p-guid' as never,
      parameters: [
        { name: 'roughness', type: 'f32' },
        { name: 'normalTexture', type: 'texture' },
      ],
    });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => parent });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'material-child-contract-invalid' },
    });
  });

  it('rejects child pass overrides so the root owns the effective pass contract', () => {
    const world = new World();
    const parent = mat({
      passes: [
        { name: 'shadow', program: { module: 'forgeax::shadow' } },
        { name: 'main', program: { module: 'forgeax::parent-main' } },
      ],
    });
    const child = mat({
      parent: 'p-guid' as never,
      passes: [
        { name: 'main', program: { module: 'forgeax::child-main' } },
        { name: 'extra', program: { module: 'forgeax::extra' } },
      ],
    });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => parent });
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: 'material-child-contract-invalid',
        detail: { forbidden: ['passes'], action: 'remove-forbidden-fields' },
      },
    });
  });

  it('errors when the parent is not catalogued', () => {
    const world = new World();
    const child = mat({ parent: 'missing-guid' as never });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => undefined });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('material-parent-not-found');
  });

  it('detects a parent cycle', () => {
    const world = new World();
    // A -> B -> A: lookup returns a material whose parent points back.
    const a = mat({ parent: 'guid-b' as never });
    const b = mat({ parent: 'guid-a' as never });
    const handle = world.allocSharedRef('MaterialAsset', a);
    const registry = {
      lookup: (guid: string | { toString(): string }) => {
        const g = String(guid).toLowerCase();
        if (g.includes('guid-b')) return b;
        if (g.includes('guid-a')) return a;
        return undefined;
      },
    };
    const res = walkMaterialPassesOverSharedRefs(world, handle, registry as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('material-circular-inheritance');
  });
});
