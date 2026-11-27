import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { discoverPluginAssets, pluginAssetClosure } from '../build/plugin-assets.js';
import { readProjectFacts } from '../project.js';
import type { ProjectCommandOptions, ProjectFacts } from '../types.js';
import { rejectCommand } from '../types.js';

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

export interface ProjectLintReport extends ProjectOwnershipGraph {
  readonly root: string;
}

export interface ProjectLintError {
  readonly code: 'project-lint-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly root: string;
    readonly diagnostics: readonly ProjectLintDiagnostic[];
  };
}

export type ProjectLintResult =
  | { readonly ok: true; readonly value: ProjectLintReport }
  | { readonly ok: false; readonly error: ProjectLintError };

function readerDiagnostic(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}): ProjectLintDiagnostic {
  const legacyIssue = Array.isArray(error.detail.issues)
    ? error.detail.issues.find(
        (issue): issue is { readonly code?: unknown; readonly keys?: unknown } =>
          issue !== null && typeof issue === 'object' && 'code' in issue && 'keys' in issue,
      )
    : undefined;
  const legacyField =
    legacyIssue?.code === 'unrecognized_keys' && Array.isArray(legacyIssue.keys)
      ? legacyIssue.keys.find(
          (key): key is string =>
            typeof key === 'string' &&
            [
              'plugins',
              'defaultScene',
              'entry',
              'executionEntry',
              'physics',
              'pointerLock',
              'input',
              'preview',
              'npc',
            ].includes(key),
        )
      : undefined;
  if (legacyField !== undefined) {
    return {
      ruleId: 'project-legacy-field',
      ownerPath: `forge.json#${legacyField}`,
      expected: error.expected,
      hint: error.hint,
      detail: { field: legacyField, source: 'forge.json' },
    };
  }
  if (error.code === 'project-manifest-invalid') {
    return {
      ruleId: 'project-schema-invalid',
      ownerPath: 'forge.json',
      expected: error.expected,
      hint: error.hint,
      detail: {
        code: error.code,
        ...(Array.isArray(error.detail.issues) ? { issues: error.detail.issues } : {}),
      },
    };
  }
  const readerReason = typeof error.detail.reason === 'string' ? error.detail.reason : undefined;
  const readerOwner = readerReason?.includes('package.json') ? 'package.json' : 'forge.json';
  return {
    ruleId: 'project-reader-error',
    ownerPath: readerOwner,
    expected: error.expected,
    hint: error.hint,
    detail: {
      code: error.code,
      ...(typeof error.detail.root === 'string' ? { root: error.detail.root } : {}),
      ...(readerReason === undefined ? {} : { reason: readerReason }),
    },
  };
}

function packageDiagnostics(
  packageJson: Readonly<Record<string, unknown>>,
): readonly ProjectLintDiagnostic[] {
  const forgeax = packageJson.forgeax;
  if (forgeax === null || typeof forgeax !== 'object' || Array.isArray(forgeax)) return [];
  const assets = Reflect.get(forgeax, 'assets');
  if (assets === undefined) return [];
  return [
    {
      ruleId: 'project-legacy-field',
      ownerPath: 'package.json#forgeax.assets',
      expected: 'package.json to omit the legacy forgeax.assets project authority',
      hint: 'move project content under assets/ and let the manifest Entry/Plugin graph own it.',
      detail: { field: 'forgeax.assets' },
    },
  ];
}

export async function projectLintCommand(
  options: ProjectCommandOptions = {},
): Promise<ProjectLintResult> {
  const root = options.root ?? process.cwd();
  const facts = await readProjectFacts(root);
  if (!facts.ok) {
    const diagnostic = readerDiagnostic(facts.error);
    return rejectCommand({
      code: 'project-lint-failed',
      expected: 'the project to satisfy the strict project and ownership contracts',
      hint: 'Repair the owning manifest or Plugin path before activation; lint executes no project module.',
      detail: { root, diagnostics: [diagnostic] },
    });
  }
  const graph = await buildProjectOwnershipGraph(facts.value);
  const diagnostics = [...packageDiagnostics(facts.value.packageJson), ...graph.diagnostics];
  if (diagnostics.length > 0) {
    return rejectCommand({
      code: 'project-lint-failed',
      expected: 'the project to have one explicit ownership path per executable capability',
      hint: 'Repair the reported owning Plugin path, realm, provider, or legacy field and rerun forgeax project lint.',
      detail: { root: facts.value.root, diagnostics },
    });
  }
  return { ok: true, value: { root: facts.value.root, ...graph, diagnostics } };
}
