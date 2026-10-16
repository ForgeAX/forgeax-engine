export const ASSET_REFERENCE_QUERY = 'view.asset-references.get';
export const ASSET_REFERENCE_SOURCE = 'view-asset-references';
export const PRIMARY_ASSET_REFERENCE_FIELDS = Object.freeze(['MeshFilter.assetHandle', 'SceneInstance.source', 'AudioSource.clip', 'ParticleEffectPlayer.effect', 'Terrain.asset']);

export type AssetReferenceScope = {
  projectId: string; targetId: string; targetGeneration?: number; worldId: string; browserGeneration: number;
};
export type AssetReference = {
  key: string; component: string; field: string; index?: number; slotName?: string;
  origin: 'component' | 'mesh-default' | 'engine-default';
  status: 'resolved' | 'unbound' | 'builtin' | 'unregistered' | 'stale' | 'missing';
  guid?: string; kind?: string; handle?: number; primary?: boolean;
};
export type EntityAssetReferences = AssetReferenceScope & {
  entityId: string; references: readonly AssetReference[]; primaryKey?: string;
  truncated?: boolean;
};
export type AssetReferenceServiceState = {
  phase: 'idle' | 'installing' | 'ready' | 'unavailable' | 'failed';
  scope?: AssetReferenceScope; error?: string; packageId?: string; pluginUid?: number;
};
export type AssetReferenceService = {
  getState(): AssetReferenceServiceState;
  subscribe(listener: () => void): () => void;
  query(entityId: string, options?: { signal?: AbortSignal }): Promise<EntityAssetReferences>;
  open(guid: string): Promise<unknown>;
};

export function sameAssetReferenceScope(left: AssetReferenceScope | undefined, right: AssetReferenceScope | undefined) {
  return left !== undefined && right !== undefined && left.projectId === right.projectId
    && left.targetId === right.targetId && left.targetGeneration === right.targetGeneration
    && left.worldId === right.worldId && left.browserGeneration === right.browserGeneration;
}
import type { WorkspaceAsset, WorkspaceEntityInspection } from './contract.ts';

export function assetReferenceCandidates(references: readonly AssetReference[], assets: readonly WorkspaceAsset[]) {
  return references.flatMap(reference => {
    if (reference.status !== 'resolved' || !reference.guid) return [];
    const asset = assets.find(asset => asset.guid.toLowerCase() === reference.guid!.toLowerCase()
      && (!reference.kind || reference.kind === asset.kind));
    return asset ? [{ reference, asset }] : [];
  });
}

export function primaryEntityAsset(references: readonly AssetReference[], assets: readonly WorkspaceAsset[]) {
  const primary = references.filter(reference => reference.primary);
  return primary.length === 1 ? assetReferenceCandidates(primary, assets)[0]?.asset : undefined;
}

/** Explicit GUID fallback for targets that do not offer the resident native service. */
export function explicitEntityAssetReferences(inspection: WorkspaceEntityInspection): AssetReference[] {
  return inspection.components.flatMap(component => {
    const values = component.values && typeof component.values === 'object' && !Array.isArray(component.values)
      ? component.values as Record<string, unknown> : {};
    return Object.entries(component.fields ?? {}).flatMap(([field, schema]) => {
      const array = /^array<shared<[^>]+>>$/.test(schema.type);
      if (!array && !/^shared<[^>]+>$/.test(schema.type) && !/assetref/i.test(schema.type)) return [];
      const raw = values[field];
      const entries = array && Array.isArray(raw) ? raw : [raw];
      return entries.flatMap((value, index) => {
        const guid = typeof value === 'string' ? value : value && typeof value === 'object' && 'guid' in value && typeof value.guid === 'string' ? value.guid : undefined;
        return guid ? [{ key: `${component.name}.${field}${array ? `[${index}]` : ''}`, component: component.name,
          field, ...(array ? { index } : {}), origin: 'component' as const, status: 'resolved' as const, guid,
          primary: PRIMARY_ASSET_REFERENCE_FIELDS.includes(`${component.name}.${field}`) }] : [];
      });
    });
  });
}
