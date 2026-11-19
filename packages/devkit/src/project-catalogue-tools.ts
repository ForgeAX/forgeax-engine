import { defineTool, type ToolContribution, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import {
  browseProjectDirectories,
  listKnownProjects,
  registerKnownProject,
} from './known-projects.js';

/** Metadata belongs to DevKit, independent of workspace/World admission. */
export function createProjectCatalogueTools(): readonly ToolContribution[] {
  return (['list', 'register', 'browse'] as const).map((operation) =>
    defineTool(
      {
        id: `engine.project.${operation}`,
        path: ['engine', 'project', operation],
        title: `Project catalogue ${operation}`,
        summary: 'Read or register known Node-visible projects without preparing gameplay.',
        realm: 'host',
        argsSchema: toolJsonSchema<unknown>({
          type: 'object',
          properties: { path: { type: 'string', minLength: 1 } },
          ...(operation === 'register' ? { required: ['path'] } : {}),
        }),
        resultSchema: toolJsonSchema({}),
        inputSchema: {},
        outputSchema: {},
        evidence: [],
      },
      (value) => {
        const args = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        if (operation === 'list') return listKnownProjects();
        if (operation === 'register') return registerKnownProject(String(args.path));
        return browseProjectDirectories(typeof args.path === 'string' ? args.path : undefined);
      },
    ),
  );
}
