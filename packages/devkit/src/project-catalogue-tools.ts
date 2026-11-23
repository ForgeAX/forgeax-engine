import { defineTool, type ToolContribution, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import {
  browseProjectDirectories,
  listKnownProjects,
  registerKnownProject,
} from './known-projects.js';

export const projectCatalogueOperations = {
  list: () => listKnownProjects(),
  register: (path: unknown) => registerKnownProject(String(path)),
  browse: (path: unknown) => browseProjectDirectories(typeof path === 'string' ? path : undefined),
};

/** Metadata belongs to DevKit, independent of workspace/World admission. */
export function createProjectCatalogueTools(): readonly ToolContribution[] {
  return Object.entries(projectCatalogueOperations).map(([operation, run]) =>
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
        return run(args.path);
      },
    ),
  );
}
