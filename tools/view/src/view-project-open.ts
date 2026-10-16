import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';

import { resolveProjectRoot } from './view-start.ts';

const BROWSER_FLAGS = ['--headless', '--software', '--serve'];

export function viewProjectOpenError(code: string, hint: string, detail?: unknown) {
  return Object.assign(new Error(hint), { name: 'ViewProjectOpenError', code, expected: hint, hint, ...(detail === undefined ? {} : { detail }) });
}

export function parseProjectArgument(argv: readonly string[] = []) {
  const index = argv.indexOf('--project');
  const value = argv[index + 1];
  if (index < 0 || typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
    throw viewProjectOpenError(
      'view-project-required',
      'Pass --project with the editor project directory.',
    );
  }
  return resolve(value.trim());
}

/** Same identity Engine stores from readProjectFacts: realpath when the directory exists. */
export async function projectIdentity(input: string) {
  const resolved = resolve(String(input ?? ''));
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function publishedProject(snapshot: WorkspaceState, viewerUrl: string | undefined, alreadyOpen: boolean) {
  const project = snapshot?.project;
  const target = snapshot?.projectTarget;
  if (typeof project?.root !== 'string' || project.root.trim() === '' || typeof target?.url !== 'string' || target.url.trim() === '') {
    throw viewProjectOpenError(
      'view-project-open-incomplete',
      'The opened project did not publish a headed target URL.',
      { project: project ?? null },
    );
  }
  return {
    alreadyOpen,
    ...(typeof viewerUrl === 'string' && viewerUrl !== '' ? { viewerUrl } : {}),
    project: {
      id: project.id,
      root: project.root,
      ...(project.name === undefined ? {} : { name: project.name }),
    },
    projectTarget: {
      url: target.url,
      ...(target.targetId === undefined ? {} : { targetId: target.targetId }),
    },
  };
}

/**
 * Open the editor project on the broker captured for this View.
 * Does not start View, launch a browser, or switch away from another project.
 */
export async function openViewProject(workspace: Pick<ViewWorkspaceBroker, 'snapshot' | 'openProject'>, projectPath: string, { signal, viewerUrl }: { signal?: AbortSignal; viewerUrl?: string } = {}) {
  if (!workspace || typeof workspace.snapshot !== 'function' || typeof workspace.openProject !== 'function') {
    throw viewProjectOpenError('view-not-started', 'Run forgeax backend start, then forgeax view start.');
  }
  if (signal?.aborted) {
    throw viewProjectOpenError('view-not-started', 'View has stopped. Run forgeax view start again when needed.');
  }
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw viewProjectOpenError('view-project-required', 'Pass --project with the editor project directory.');
  }
  const requested = await projectIdentity(projectPath);
  if (!requested.trim()) {
    throw viewProjectOpenError('view-project-required', 'Pass --project with the editor project directory.');
  }
  const current = workspace.snapshot();
  const currentRoot = current?.project?.root;
  if (typeof currentRoot === 'string' && currentRoot.trim() !== '') {
    const openRoot = await projectIdentity(currentRoot);
    if (openRoot !== requested) {
      throw viewProjectOpenError(
        'view-project-already-open',
        'The current project stays open. This command does not switch projects.',
        { root: currentRoot },
      );
    }
    if (current.workspaceTargetLost !== true && typeof current.projectTarget?.url === 'string' && current.projectTarget.url !== '') {
      return publishedProject(current, viewerUrl, true);
    }
  }
  let opened;
  try {
    opened = await workspace.openProject(
      { root: requested, tabId: VIEW_WORKSPACE_TAB_ID },
      { signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      throw viewProjectOpenError('view-not-started', 'View has stopped. Run forgeax view start again when needed.');
    }
    throw error;
  }
  if (signal?.aborted) {
    throw viewProjectOpenError('view-not-started', 'View has stopped. Run forgeax view start again when needed.');
  }
  return publishedProject(opened, viewerUrl, false);
}

export async function runViewProjectOpen(argv: readonly string[] = [], env = process.env) {
  if (argv.some(arg => BROWSER_FLAGS.includes(arg))) {
    throw new TypeError('View startup does not launch a browser. Open the returned URL in your browser; configure Engine runs separately.');
  }
  const project = parseProjectArgument(argv);
  const { callDevKitBackend } = await import('@forgeax/engine/devkit');
  if (!callDevKitBackend) throw new Error('Install the matching Engine SDK with the independent backend capability.');
  return callDevKitBackend(resolveProjectRoot(argv, env), 'view.project.open', { project });
}
