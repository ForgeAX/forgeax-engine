import type { PackDraftField } from '@forgeax/view-workspace-core/pack-authoring';
import type { WorkspaceAsset } from '@forgeax/view-workspace-core/contract';

export function partitionPackFields(fields: readonly PackDraftField[], assetSourceKey?: string) {
  return {
    generation: fields.filter(field => typeof field.apply !== 'object'),
    runtime: fields.filter(field => typeof field.apply === 'object' && typeof field.apply.asset === 'string' && assetSourceKey !== undefined && field.apply.asset === assetSourceKey),
  };
}

export function generationPreviewTargetId(previews: readonly { asset?: { kind: string } | null; target?: { targetId: string } }[]): string | undefined {
  return (previews.find(preview => preview.asset?.kind === 'scene' && preview.target?.targetId)
    ?? previews.find(preview => preview.target?.targetId))?.target?.targetId;
}

export function resolveAssetPageBinding(resource: { asset: { guid: string; kind: string } } | { file: unknown } | undefined, assets: readonly WorkspaceAsset[] | null | undefined) {
  if (!resource || !('asset' in resource)) return undefined;
  const asset = assets?.find(candidate => candidate.guid === resource.asset.guid && candidate.kind === resource.asset.kind);
  const sourcePath = asset?.sourcePath ?? asset?.path;
  if (!asset || typeof asset.sourceKey !== 'string' || !asset.sourceKey || typeof sourcePath !== 'string' || !/\.pack\.(?:ts|json)$/i.test(sourcePath)) return undefined;
  return { asset, sourceKey: asset.sourceKey, sourcePath };
}
