import { componentDefinition } from '@forgeax/engine/ecs';
import type { EntityHandle } from '@forgeax/engine/ecs';
import type {} from '@forgeax/engine/app';
import type {} from '@forgeax/engine/assets-runtime';
import { AssetGuid } from '@forgeax/engine/pack/source';
import { registerTools } from '@forgeax/engine/plugin';
import type { Context, Plugin } from '@forgeax/engine/plugin';
import { defineTool, toolJsonSchema } from '@forgeax/engine/tool-runtime';
import type { ToolContribution } from '@forgeax/engine/tool-runtime';
import { BUILTIN_BASE, handleSlot } from '@forgeax/engine/types';
import type { Asset, Handle, MeshAsset } from '@forgeax/engine/types';
import {
  ASSET_REFERENCE_QUERY, ASSET_REFERENCE_SOURCE, PRIMARY_ASSET_REFERENCE_FIELDS, sameAssetReferenceScope,
} from '@forgeax/view-workspace-core/asset-references';
import type { AssetReference, AssetReferenceScope, EntityAssetReferences } from '@forgeax/view-workspace-core/asset-references';

export type AssetReferencePluginConfig = AssetReferenceScope & { providerId: string };
const primaryFields = new Set(PRIMARY_ASSET_REFERENCE_FIELDS);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function queryEntityAssetReferences(ctx: Context, scope: AssetReferenceScope, input: AssetReferenceScope & { entityId: string }): Promise<EntityAssetReferences> {
  if (!sameAssetReferenceScope(scope, input) || ctx.world.identity !== scope.worldId)
    throw new Error('asset-reference-target-stale');
  const tools = ctx.get('engineWorkspaceTargetTools');
  const assets = ctx.get('assets');
  if (!tools || !assets || typeof assets.guidOf !== 'function') throw new Error('asset-reference-capability-unavailable');
  const inspection = await tools.inspect({ entityId: input.entityId });
  if (inspection.targetId !== scope.targetId || inspection.worldId !== scope.worldId) throw new Error('asset-reference-target-stale');
  const entity = inspection.entity as EntityHandle;
  const components = ctx.world.componentsOf(entity).unwrap();
  const references: AssetReference[] = [];
  let truncated = false;
  const resolve = (base: Omit<AssetReference, 'status'>, value: unknown): { reference: AssetReference; payload?: Asset } => {
    if (value === 0 || value === null || value === undefined || value === '') return { reference: { ...base, status: 'unbound' } };
    if (typeof value === 'number') {
      const held = { ...base, handle: value };
      if (handleSlot(value as Handle<string, 'shared'>) < BUILTIN_BASE) return { reference: { ...held, status: 'builtin' } };
      const result = ctx.world.sharedRefs.resolve<string, Asset>(value as Handle<string, 'shared'>);
      if (!result.ok) return { reference: { ...held, status: 'stale' } };
      if (!record(result.value) || typeof result.value.kind !== 'string') return { reference: { ...held, status: 'unregistered' } };
      const guid = assets.guidOf(result.value);
      return { reference: { ...held, status: guid ? 'resolved' : 'unregistered', ...(guid ? { guid } : {}), kind: result.value.kind }, payload: result.value };
    }
    let guid: string | undefined;
    if (typeof value === 'string') guid = value;
    else if (record(value)?.guid && typeof record(value)?.guid === 'string') guid = String(record(value)?.guid);
    else if (ArrayBuffer.isView(value) && value.byteLength === 16) {
      try { guid = AssetGuid.format(value as Parameters<typeof AssetGuid.format>[0]); } catch { /* Invalid GUID bytes stay unavailable. */ }
    }
    return { reference: { ...base, status: guid ? 'resolved' : 'unregistered', ...(guid ? { guid: guid.toLowerCase() } : {}) } };
  };
  let mesh: MeshAsset | undefined;
  let overrides: ArrayLike<unknown> = [];
  for (const component of components) {
    const values = ctx.world.get(entity, component).unwrap() as Record<string, unknown>;
    const fields = componentDefinition(component).fields;
    if (component.name === 'MeshRenderer' && ArrayBuffer.isView(values.materials)) overrides = values.materials as unknown as ArrayLike<unknown>;
    else if (component.name === 'MeshRenderer' && Array.isArray(values.materials)) overrides = values.materials;
    for (const [field, schema] of Object.entries(fields)) {
      const array = /^array<shared<[^>]+>>$/.test(schema.type);
      const sharedType = /shared<([^>]+)>/.exec(schema.type)?.[1];
      if (!array && !/^shared<[^>]+>$/.test(schema.type) && !/assetref/i.test(schema.type)) continue;
      const value = values[field];
      const collection = array && (Array.isArray(value) || ArrayBuffer.isView(value)) ? value as ArrayLike<unknown> : undefined;
      if (collection && collection.length > 128) truncated = true;
      const entries = collection ? Array.from({ length: Math.min(collection.length, 128) }, (_, index) => collection[index]) : [value];
      for (const [index, entry] of entries.entries()) {
        if (references.length >= 256) { truncated = true; break; }
        const key = `${component.name}.${field}${array ? `[${index}]` : ''}`;
        const result = resolve({ key, component: component.name, field, origin: 'component',
          ...(array ? { index } : {}), primary: primaryFields.has(`${component.name}.${field}`) }, entry);
        if (!result.reference.guid && sharedType && !sharedType.endsWith('Asset') && sharedType !== 'AnimationClip') continue;
        references.push(result.reference);
        if (component.name === 'MeshFilter' && result.payload?.kind === 'mesh') mesh = result.payload as MeshAsset;
      }
    }
  }
  // Defaults belong to the held mesh, not the latest Catalog publication.
  if (mesh && mesh.materialSlots.length > 128) truncated = true;
  if (mesh) for (const [index, slot] of mesh.materialSlots.slice(0, 128).entries()) {
    const override = overrides[index];
    const key = `MeshRenderer.materials[${index}]`;
    const existing = references.find(reference => reference.key === key);
    if (override !== undefined && override !== 0 && override !== null) {
      if (existing) existing.slotName = slot.slotName;
      continue;
    }
    const result = resolve({ key, component: 'MeshRenderer', field: 'materials', index,
      slotName: slot.slotName, origin: 'mesh-default' }, slot.defaultMaterial);
    if (!slot.defaultMaterial) result.reference = { ...result.reference, origin: 'engine-default', status: 'builtin', kind: 'material' };
    if (existing) references.splice(references.indexOf(existing), 1, result.reference);
    else if (references.length < 256) references.push(result.reference);
    else truncated = true;
  }
  const primary = references.filter(reference => reference.primary && reference.status === 'resolved');
  return { projectId: scope.projectId, targetId: scope.targetId, targetGeneration: scope.targetGeneration,
    worldId: scope.worldId, browserGeneration: scope.browserGeneration,
    entityId: input.entityId, references, truncated, ...(primary.length === 1 ? { primaryKey: primary[0]!.key } : {}) };
}

const assetReferenceQueryPlugin: Plugin.Object<AssetReferencePluginConfig> = {
  name: 'forgeax:view-asset-reference-query',
  inject: ['world', 'assets', 'toolApi', 'engineWorkspaceTargetTools'],
  apply(ctx, config) {
    if (ctx.world.identity !== config.worldId) throw new Error('asset-reference-world-mismatch');
    const schema = toolJsonSchema<AssetReferenceScope & { entityId: string }>({ type: 'object', required: ['projectId', 'targetId', 'worldId', 'browserGeneration', 'entityId'],
      properties: { projectId: { type: 'string', minLength: 1 }, targetId: { type: 'string', minLength: 1 },
        worldId: { type: 'string', minLength: 1 }, entityId: { type: 'string', minLength: 1 },
        browserGeneration: { type: 'integer', minimum: 0 }, targetGeneration: { type: 'integer', minimum: 0 } } });
    const tool = defineTool({ id: ASSET_REFERENCE_QUERY, path: ['view', 'asset-references', 'get'],
      title: 'Read entity asset references', summary: 'Resolve held resource identities without changing the World.', realm: 'engine',
      argsSchema: schema, resultSchema: toolJsonSchema<EntityAssetReferences>({ type: 'object' }),
      inputSchema: {}, outputSchema: {}, evidence: [] }, input => queryEntityAssetReferences(ctx, config, input));
    ctx.effect(() => registerTools(ctx, [tool as ToolContribution], { sourceId: ASSET_REFERENCE_SOURCE, providerId: config.providerId, realm: 'engine' }));
  },
};
export default assetReferenceQueryPlugin;
