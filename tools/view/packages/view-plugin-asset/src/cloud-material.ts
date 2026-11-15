import type { WorkspaceCloudMaterialInspection, WorkspaceInspection, WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { selectWorkspaceFallbackSubject } from '@forgeax/view-workspace-core/resource-open';

export function cloudMaterialDetails(inspection: WorkspaceInspection) {
  const meta = inspection.meta;
  if (!meta || !['cloud-material', 'cloud-material-instance'].includes(String(meta.kind)) || !Array.isArray(meta.parameters)) return null;
  return meta as WorkspaceCloudMaterialInspection['meta'];
}

export function cloudProgramDetails(details: WorkspaceCloudMaterialInspection['meta']) {
  return typeof details.cookIdentity === 'string' && Array.isArray(details.variants) && Array.isArray(details.declaredDependencies)
    ? details : null;
}

export function cloudDeclaredDependencyReference(dependency: WorkspaceCloudMaterialInspection['meta']['declaredDependencies'][number], assets: WorkspaceState['assets']) {
  const asset = assets?.find(asset => asset.guid === dependency.guid && asset.kind === dependency.kind);
  return { guid: dependency.guid, kind: dependency.kind, name: asset?.name || asset?.sourceKey || dependency.guid,
    missing: !asset || asset.lifecycle === 'missing' };
}

export function cloudParameterGroups(details: WorkspaceCloudMaterialInspection['meta'], query = '') {
  const groups = new Map<string, typeof details.parameters>();
  for (const row of details.parameters) {
    const group = row.definition.group ?? 'Parameters';
    if (query && !`${group} ${row.name} ${row.definition.label ?? ''} ${row.value}`.toLowerCase().includes(query.toLowerCase())) continue;
    const rows = groups.get(group) ?? [];
    rows.push(row);
    groups.set(group, rows);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, rows]) => [group,
    rows.sort((a, b) => Number(b.definition.kind === 'texture') - Number(a.definition.kind === 'texture'))] as const);
}

export function cloudThumbnailScope(state: WorkspaceState | null, guids: readonly string[]) {
  const subject = selectWorkspaceFallbackSubject(state) ?? state?.openRequest?.asset;
  if (!state?.project || !state.projectTarget || state.workspaceTargetLost || !subject) return null;
  return JSON.stringify([state.project.id, state.project.root, state.projectTarget, state.browserGeneration, state.catalogEpoch,
    subject.guid, guids.map(guid => { const asset = state.assets?.find(asset => asset.guid === guid); return [guid, asset?.publicationId, asset?.revision, asset?.lifecycle]; })]);
}
