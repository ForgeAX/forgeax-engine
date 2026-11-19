import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import type { EngineWorkspaceProjectExpectation } from '@forgeax/engine/app';
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
      'Pass --project with the project directory.',
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
  const status = snapshot?.projectStatus;
  if (status?.phase === 'failed') {
    const failure = status.failure;
    throw viewProjectOpenError(
      typeof failure.code === 'string' ? failure.code : 'view-project-startup-failed',
      typeof failure.hint === 'string' ? failure.hint : 'The Engine project session failed to start.',
      failure,
    );
  }
  const document = snapshot?.projectDocument ??
    (status && status.phase !== 'preparing' ? status.document : undefined);
  if (typeof project?.root !== 'string' || project.root.trim() === '' ||
      !document || typeof document.url !== 'string' || document.url.trim() === '') {
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
      url: document.url,
      targetId: document.targetId,
      sessionId: document.sessionId,
      browserGeneration: document.browserGeneration,
    },
  };
}

function waitForProjectDocument(
  workspace: Pick<ViewWorkspaceBroker, 'snapshot' | 'subscribe'>,
  projectRoot: string,
  viewerUrl: string | undefined,
  alreadyOpen: boolean,
  signal?: AbortSignal,
) {
  const inspect = () => {
    if (signal?.aborted) throw viewProjectOpenError('view-not-started', 'View has stopped. Run forgeax view start again when needed.');
    const snapshot = workspace.snapshot();
    if (snapshot.project?.root !== projectRoot) {
      throw viewProjectOpenError('view-project-session-stale', 'The selected project session changed while its document was being prepared.');
    }
    const status = snapshot.projectStatus;
    if (status?.phase === 'failed') return publishedProject(snapshot, viewerUrl, alreadyOpen);
    const document = snapshot.projectDocument ??
      (status && status.phase !== 'preparing' ? status.document : undefined);
    if (document) return publishedProject(snapshot, viewerUrl, alreadyOpen);
    if (status?.phase !== 'preparing') {
      throw viewProjectOpenError('view-project-open-incomplete',
        'The Engine did not publish its headed project document at startup.', { project: snapshot.project ?? null, phase: status?.phase ?? null });
    }
    return undefined;
  };
  try {
    const immediate = inspect();
    if (immediate) return Promise.resolve(immediate);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<ReturnType<typeof publishedProject>>((resolvePromise, rejectPromise) => {
    let disposed = false;
    let unsubscribe = () => {};
    const fail = (error: unknown) => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      rejectPromise(error);
    };
    const succeed = (value: ReturnType<typeof publishedProject>) => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      resolvePromise(value);
    };
    const check = () => {
      try {
        const value = inspect();
        if (value) succeed(value);
      } catch (error) { fail(error); }
    };
    const abort = () => fail(viewProjectOpenError('view-not-started', 'View has stopped. Run forgeax view start again when needed.'));
    unsubscribe = workspace.subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

/**
 * Open the project on the broker captured for this View.
 * Does not start View, launch a browser, or switch away from another project.
 */
export async function openViewProject(workspace: Pick<ViewWorkspaceBroker, 'snapshot' | 'openProject' | 'subscribe'>, projectPath: string, { signal, viewerUrl }: { signal?: AbortSignal; viewerUrl?: string } = {}) {
  if (!workspace || typeof workspace.snapshot !== 'function' || typeof workspace.openProject !== 'function') {
    throw viewProjectOpenError('view-not-started', 'Run forgeax backend start, then forgeax view start.');
  }
  if (typeof workspace.subscribe !== 'function') {
    throw viewProjectOpenError('view-workspace-status-unavailable', 'View requires the Engine owner status subscription to report project document readiness.');
  }
  if (signal?.aborted) {
    throw viewProjectOpenError('view-not-started', 'View has stopped. Run forgeax view start again when needed.');
  }
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    throw viewProjectOpenError('view-project-required', 'Pass --project with the project directory.');
  }
  const requested = await projectIdentity(projectPath);
  if (!requested.trim()) {
    throw viewProjectOpenError('view-project-required', 'Pass --project with the project directory.');
  }
  const current = workspace.snapshot();
  const currentRoot = current?.project?.root;
  let expectedProject: EngineWorkspaceProjectExpectation = { kind: 'empty' };
  if (typeof currentRoot === 'string' && currentRoot.trim() !== '') {
    const openRoot = await projectIdentity(currentRoot);
    if (openRoot !== requested) {
      throw viewProjectOpenError(
        'view-project-already-open',
        'The current project stays open. This command does not switch projects.',
        { root: currentRoot },
      );
    }
    if (current.workspaceTargetLost !== true && current.projectStatus?.phase !== 'failed') {
      return waitForProjectDocument(workspace, currentRoot, viewerUrl, true, signal);
    }
    const status = current.projectStatus;
    if (status?.phase === 'failed' && status.failure.code !== 'engine-workspace-page-lost') {
      return publishedProject(current, viewerUrl, true);
    }
    if (!status || !('sessionId' in status)) {
      throw viewProjectOpenError('view-project-session-identity-unavailable', 'The retired project must expose its Engine session identity before recovery.');
    }
    expectedProject = { kind: 'session', sessionId: status.sessionId, generation: status.generation, recovery: 'lost' };
  }
  let opened;
  try {
    opened = await workspace.openProject(
      { root: requested, tabId: VIEW_WORKSPACE_TAB_ID, expectedProject },
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
  if (opened.project?.root !== requested) {
    throw viewProjectOpenError('view-project-open-incomplete', 'The Engine did not admit the requested project facts.', { project: opened.project ?? null });
  }
  return waitForProjectDocument(workspace, requested, viewerUrl, false, signal);
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
