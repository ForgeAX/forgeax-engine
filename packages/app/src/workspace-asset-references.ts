import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { componentDefinition, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { parseManagedArraySchema } from '@forgeax/engine-ecs/internal';
import { AssetGuid } from '@forgeax/engine-pack/source';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { workspaceAssetKind } from './workspace-asset-facts';

export interface EngineWorkspaceAssetReference {
  readonly key: string;
  readonly component: string;
  readonly field: string;
  readonly index?: number;
  readonly slotName?: string;
  readonly origin: 'component' | 'mesh-default' | 'engine-default';
  readonly status: 'resolved' | 'unbound' | 'builtin' | 'unregistered' | 'stale';
  readonly guid?: string;
  readonly kind?: string;
  readonly handle?: number;
}

export interface EngineWorkspaceAssetReferences {
  readonly references: readonly EngineWorkspaceAssetReference[];
  readonly truncated: boolean;
}

/** Read held Registry identities before component introspection serializes handles. */
export function inspectWorkspaceAssetReferences(
  world: World,
  assets: AssetRegistry,
  entity: EntityHandle,
): EngineWorkspaceAssetReferences {
  const references: EngineWorkspaceAssetReference[] = [];
  let truncated = false;
  const resolve = (
    base: Omit<EngineWorkspaceAssetReference, 'status'>,
    value: unknown,
  ): { reference: EngineWorkspaceAssetReference; payload?: MeshAsset } => {
    if (value === 0 || value === null || value === undefined || value === '')
      return { reference: { ...base, status: 'unbound' } };
    if (typeof value === 'number') {
      const held = { ...base, handle: value };
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        return { reference: { ...held, status: 'stale' } };
      if (!assets.validate(value, base.kind).ok) return { reference: { ...held, status: 'stale' } };
      const source = assets.source(value as AssetHandle).unwrap();
      const payload =
        base.component === 'MeshFilter' && base.field === 'assetHandle' && base.kind === 'mesh'
          ? assets.read(value as AssetHandle<'mesh'>).unwrap()
          : undefined;
      const guid = source?.guid;
      return {
        reference: {
          ...held,
          status: guid ? 'resolved' : 'unregistered',
          ...(guid ? { guid } : {}),
        },
        ...(payload === undefined ? {} : { payload }),
      };
    }
    let guid: string | undefined;
    if (typeof value === 'string') guid = value;
    else if (typeof value === 'object' && 'guid' in value && typeof value.guid === 'string')
      guid = value.guid;
    else if (ArrayBuffer.isView(value) && value.byteLength === 16) {
      try {
        guid = AssetGuid.format(value as Parameters<typeof AssetGuid.format>[0]);
      } catch {
        /* Invalid GUID bytes remain unregistered. */
      }
    }
    return {
      reference: {
        ...base,
        status: guid ? 'resolved' : 'unregistered',
        ...(guid ? { guid: guid.toLowerCase() } : {}),
      },
    };
  };
  let mesh: MeshAsset | undefined;
  let overrides: ArrayLike<unknown> = [];
  for (const component of world.componentsOf(entity).unwrap()) {
    const values = world.get(entity, component).unwrap() as Record<string, unknown>;
    if (
      component.name === 'MeshRenderer' &&
      (Array.isArray(values.materials) || ArrayBuffer.isView(values.materials))
    )
      overrides = values.materials as ArrayLike<unknown>;
    for (const [field, schema] of Object.entries(componentDefinition(component).fields)) {
      const arraySchema = parseManagedArraySchema(schema.type);
      const array = arraySchema !== null;
      const kind = /^asset<([\w-]+)>$/.exec(arraySchema?.elementType ?? schema.type)?.[1];
      if (!kind) continue;
      const value = values[field];
      const collection =
        array && (Array.isArray(value) || ArrayBuffer.isView(value))
          ? (value as ArrayLike<unknown>)
          : undefined;
      if (collection && collection.length > 128) truncated = true;
      const entries = collection
        ? Array.from({ length: Math.min(collection.length, 128) }, (_, index) => collection[index])
        : [value];
      for (const [index, entry] of entries.entries()) {
        if (references.length >= 256) {
          truncated = true;
          break;
        }
        const result = resolve(
          {
            key: `${component.name}.${field}${array ? `[${index}]` : ''}`,
            component: component.name,
            field,
            origin: 'component',
            ...(array ? { index } : {}),
            kind,
          },
          entry,
        );
        references.push(result.reference);
        if (component.name === 'MeshFilter' && result.payload?.kind === 'mesh')
          mesh = result.payload;
      }
    }
  }
  // Defaults describe the held mesh publication, even after Catalog replacement.
  if (mesh && mesh.materialSlots.length > 128) truncated = true;
  if (mesh)
    for (const [index, slot] of mesh.materialSlots.slice(0, 128).entries()) {
      const key = `MeshRenderer.materials[${index}]`;
      const existing = references.findIndex((reference) => reference.key === key);
      const override = overrides[index];
      if (override !== undefined && override !== 0 && override !== null) {
        const reference = references[existing];
        if (reference) references[existing] = { ...reference, slotName: slot.slotName };
        continue;
      }
      const base = {
        key,
        component: 'MeshRenderer',
        field: 'materials',
        index,
        slotName: slot.slotName,
        kind: 'material',
      };
      const reference = slot.defaultMaterial
        ? resolve({ ...base, origin: 'mesh-default' }, slot.defaultMaterial).reference
        : { ...base, origin: 'engine-default' as const, status: 'builtin' as const };
      if (existing >= 0) references[existing] = reference;
      else if (references.length < 256) references.push(reference);
      else truncated = true;
    }
  return {
    references: references.map((reference) =>
      reference.kind ? { ...reference, kind: workspaceAssetKind(reference.kind) } : reference,
    ),
    truncated,
  };
}
