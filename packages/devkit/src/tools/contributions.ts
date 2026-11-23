import { resolve } from 'node:path';
import {
  defineTool,
  type ToolContribution,
  type ToolDescriptor,
} from '@forgeax/engine-tool-runtime';
import type { PluginSourceInventory } from '../build/plugin-assets.js';
import type {
  BuildOptions,
  CommandResult,
  PluginCreateOptions,
  PluginInspectOptions,
  PluginRootOptions,
} from '../types.js';
import { toolCommandValue } from '../types.js';
import {
  authorPluginCreateDescriptor,
  authorPluginInspectDescriptor,
  authorPluginRootDescriptor,
  pluginMigrationDescriptor,
  previewOfflineAnalysisDescriptor,
  previewRunDescriptor,
  projectBuildDescriptor,
} from './catalog.js';
import {
  analyzePreviewArtifacts,
  type OfflineAnalysisRequest,
  type OfflineAnalysisResult,
} from './offline-analysis.js';
import { createPackAuthoringContributions } from './pack-contributions.js';
import { nativePreviewTools, retiredPreviewOperationFailure } from './preview-catalog.js';
import type { PreviewHostRequest, PreviewHostResult } from './preview-host.js';

export { createPackAuthoringContributions } from './pack-contributions.js';

function projectContribution<T extends { readonly root?: string }>(
  descriptor: ToolDescriptor<T>,
  projectRoot: string,
  run: (options: T & { readonly root: string }) => Promise<CommandResult<unknown>>,
): ToolContribution<T, unknown> {
  return defineTool(descriptor, async (options) => {
    return toolCommandValue(await run({ ...options, root: options.root ?? projectRoot }));
  });
}

export function createBuildContribution(
  projectRoot = process.cwd(),
  takeInitialSources?: () => PluginSourceInventory | undefined,
): ToolContribution<BuildOptions, unknown> {
  return projectContribution(projectBuildDescriptor, projectRoot, async (options) => {
    const { buildCommand } = await import('../commands.js');
    const initialSources =
      resolve(options.root) === resolve(projectRoot) ? takeInitialSources?.() : undefined;
    return buildCommand(options, initialSources);
  });
}

export function createAuthorContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginCreateOptions, unknown> {
  return projectContribution(authorPluginCreateDescriptor, projectRoot, async (options) =>
    (await import('../plugin-authoring.js')).pluginCreateCommand(options),
  );
}

export function createAuthorInspectContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginInspectOptions, unknown> {
  return projectContribution(authorPluginInspectDescriptor, projectRoot, async (options) =>
    (await import('../plugin-authoring.js')).pluginInspectCommand(options),
  );
}

export function createProjectRootContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginRootOptions, unknown> {
  return projectContribution(authorPluginRootDescriptor, projectRoot, async (options) =>
    (await import('../plugin-authoring.js')).pluginRootCommand(options),
  );
}

export function createDefaultContributions(
  projectRoot = process.cwd(),
  takeInitialSources?: () => PluginSourceInventory | undefined,
) {
  return [
    projectContribution(pluginMigrationDescriptor, projectRoot, async (options) =>
      (await import('../plugin/migration.js')).pluginMigrateCommand(options),
    ),
    createBuildContribution(projectRoot, takeInitialSources),
    createAuthorContribution(projectRoot),
    createProjectRootContribution(projectRoot),
    createAuthorInspectContribution(projectRoot),
    ...createPackAuthoringContributions(projectRoot),
    ...nativePreviewTools,
  ];
}

export function createPreviewContribution(): ToolContribution<
  PreviewHostRequest,
  PreviewHostResult
> {
  return defineTool(previewRunDescriptor, async () => ({
    ok: false as const,
    error: retiredPreviewOperationFailure,
  }));
}

export function createOfflineAnalysisContribution(): ToolContribution<
  OfflineAnalysisRequest,
  OfflineAnalysisResult
> {
  return defineTool({ ...previewOfflineAnalysisDescriptor }, analyzePreviewArtifacts);
}

export function createPreviewContributions(): readonly ToolContribution<unknown, unknown>[] {
  return [
    createPreviewContribution() as ToolContribution<unknown, unknown>,
    createOfflineAnalysisContribution() as ToolContribution<unknown, unknown>,
  ];
}
