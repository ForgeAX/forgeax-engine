import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { discoverPluginAssets, pluginAssetClosure } from '../build/plugin-assets.js';
import type { ProjectFacts } from '../types.js';

export type ProjectLintRuleId =
  | 'project-legacy-field'
  | 'project-schema-invalid'
  | 'project-reader-error'
  | 'project-realm-invalid'
  | 'project-ownership-orphan';
export interface ProjectLintDiagnostic {
  readonly ruleId: ProjectLintRuleId;
  readonly ownerPath: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}
export interface ProjectOwnershipNode {
  readonly module: string;
  readonly ownerPath: string;
  readonly realm: import('@forgeax/engine-types').PluginBuildTarget;
  readonly source: 'plugin-asset';
}
export interface ProjectOwnershipGraph {
  readonly ownership: readonly ProjectOwnershipNode[];
  readonly diagnostics: readonly ProjectLintDiagnostic[];
}
/** Asset/module ownership is static; native inject/provide readiness belongs to Cordis. */
export async function buildProjectOwnershipGraph(
  facts: ProjectFacts,
): Promise<ProjectOwnershipGraph> {
  const ownership: ProjectOwnershipNode[] = [];
  const diagnostics: ProjectLintDiagnostic[] = [];
  try {
    const inventory = await discoverPluginAssets(facts);
    for (const realm of ['host', 'engine', 'build', 'frontend'] as const) {
      for (const record of pluginAssetClosure(inventory, facts.roots[realm])) {
        const ownerPath = `forge.json#roots.${realm} > ${record.definition.guid}`;
        ownership.push({ module: record.module, ownerPath, realm, source: 'plugin-asset' });
        if (isAbsolute(record.module)) {
          try {
            await access(record.module);
          } catch {
            diagnostics.push({
              ruleId: 'project-ownership-orphan',
              ownerPath,
              expected: 'the declared runtime module to exist',
              hint: 'repair the plugin asset module reference',
              detail: { module: record.module },
            });
          }
        }
      }
    }
  } catch (cause) {
    diagnostics.push({
      ruleId: 'project-schema-invalid',
      ownerPath: 'forge.json#roots',
      expected: 'discoverable plugin definitions for project roots',
      hint: 'inspect the owning Pack and its source-only bootstrap inputs',
      detail: { cause },
    });
  }
  return { ownership, diagnostics };
}
