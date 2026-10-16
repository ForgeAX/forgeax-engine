import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
export type RuntimeParameter = { name: string; type: string; default: unknown; minimum?: number; maximum?: number; values?: (string | number | boolean)[] };
/** UI drafts only; Engine validates parameters and owns all execution state. */
export function parameterDrafts(parameters: readonly RuntimeParameter[], values: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(parameters.map(parameter => {
    const value = values[parameter.name] ?? parameter.default;
    return [parameter.name, typeof value === 'string' ? value : JSON.stringify(value) ?? ''];
  }));
}

export function parameterValues(parameters: readonly RuntimeParameter[], drafts: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(parameters.map(parameter => {
    const text = drafts[parameter.name];
    if (['string', 'asset-guid'].includes(parameter.type)) return [parameter.name, text];
    if (parameter.type === 'enum') {
      const value = parameter.values?.find(value => String(value) === text);
      if (value === undefined) throw new TypeError(`Choose a value for ${parameter.name}`);
      return [parameter.name, value];
    }
    if (typeof text !== 'string' || !text.trim()) throw new TypeError(`Enter ${parameter.name}`);
    return [parameter.name, JSON.parse(text)];
  }));
}

/** Bind to the project App, never the selected preview or independent AI run. */
export function runtimePackTarget(workspace: WorkspaceState | null | undefined) {
  const target = workspace?.projectTarget;
  if (!workspace?.project?.id || !target?.targetId || !target?.worldId || target.worldId.startsWith('pending:')) return undefined;
  return { projectId: workspace.project.id, targetId: target.targetId, worldId: target.worldId };
}
