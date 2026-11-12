import { createModelingTools } from '@forgeax/engine-modeling/tools';
import type {
  ToolContribution,
  ToolExecutionContext,
  ToolRealm,
} from '@forgeax/engine-tool-runtime';
import { createModelRenderTool } from './tools/model-render.js';

/**
 * Modeling operations a workspace frontend (the View modeling plugin) may run through
 * `engine.workspace.call`. All of them re-run a Pack build in a capture Worker and
 * write nothing back to source; `model.render` only publishes PNGs under
 * `.forgeax/tool-runs/`.
 */
export const WORKSPACE_MODELING_OPERATIONS = [
  'model.inspect',
  'model.history',
  'model.select',
  'model.overlay',
  'model.synthesize',
  'model.render',
] as const;

function contributions(projectRoot: string): readonly ToolContribution[] {
  return [...createModelingTools({ projectRoot }), createModelRenderTool(projectRoot)].filter(
    (tool) => (WORKSPACE_MODELING_OPERATIONS as readonly string[]).includes(tool.descriptor.id),
  );
}

/**
 * The same `model.*` contracts, executed against the project root of the caller's
 * admitted workspace session instead of a root fixed at construction. Grouped by
 * realm, because each ToolRuntime provider serves one realm.
 */
export function createWorkspaceModelingTools(
  rootOf: (context: ToolExecutionContext) => string | undefined,
): ReadonlyMap<ToolRealm, readonly ToolContribution[]> {
  const byRealm = new Map<ToolRealm, ToolContribution[]>();
  for (const template of contributions('/')) {
    const id = template.descriptor.id;
    const tool: ToolContribution = {
      descriptor: template.descriptor,
      async execute(args, context) {
        const root = rootOf(context);
        if (root === undefined) {
          return {
            ok: false as const,
            error: {
              code: 'engine-workspace-project-required',
              expected: 'an open workspace project',
              hint: 'Open the project before running modeling operations on its Packs.',
            },
          };
        }
        const owner = contributions(root).find((candidate) => candidate.descriptor.id === id);
        if (owner === undefined) throw new Error(`modeling operation ${id} is unavailable`);
        return owner.execute(args, context);
      },
    };
    const list = byRealm.get(template.descriptor.realm) ?? [];
    list.push(tool);
    byRealm.set(template.descriptor.realm, list);
  }
  return byRealm;
}
