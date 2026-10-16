/** DOM presentation only; the frontend Fiber owns this mount and its disposal. */
import { observeElementVisibility } from '@forgeax/view-components/visibility';
import type { ViewDisplayStatus, DisplayStatusInput } from '../status.ts';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { createWorkspaceStateReader, type WorkspaceStateClient } from '@forgeax/view-workspace-core/workspace-state';
import { t, getLocale, subscribeLocale } from '../i18n/index.ts';

type ObserverClient = Pick<ViewWorkspaceClient, 'call'> & Partial<Pick<ViewWorkspaceClient, 'capture'>> & Partial<WorkspaceStateClient>;
type PlayFrame = { targetId: string; generation: number; png?: string; frameId?: number; capturedAt?: string; error: string };

function failureText(error: unknown): string {
  if (error && typeof error === 'object' && 'hint' in error && typeof error.hint === 'string') return error.hint;
  return error instanceof Error ? error.message : String(error);
}

export function mountRunObserver({ document, surface, status, client }: { document: Document; surface: HTMLElement; status: ViewDisplayStatus; client: ObserverClient }) {
  let live = true;
  let visible = false;
  let busy = false;
  let attemptedRoot: string | undefined;
  let actionError = '';
  let sourceChoice: 'play' | 'run' | undefined;
  let workspace: WorkspaceState | null = null;
  const toolbar = document.createElement('div');
  toolbar.className = 'fx-capture-toolbar';
  const sourceLabel = document.createElement('label');
  const sourceText = document.createElement('span');
  const source = document.createElement('select');
  source.className = 'fx-input';
  const playOption = document.createElement('option');
  playOption.value = 'play';
  const runOption = document.createElement('option');
  runOption.value = 'run';
  source.append(playOption, runOption);
  sourceLabel.append(sourceText, source);
  const project = document.createElement('span');
  project.className = 'fx-capture-project';
  const connect = document.createElement('button');
  connect.className = 'fx-button fx-button--primary fx-button--compact';
  connect.type = 'button';
  const disconnect = document.createElement('button');
  disconnect.className = 'fx-button fx-button--secondary fx-button--compact';
  disconnect.type = 'button';
  toolbar.append(sourceLabel, project, connect, disconnect);
  const summary = document.createElement('p');
  summary.setAttribute('role', 'status');
  const metadata = document.createElement('p');
  metadata.className = 'fx-capture-metadata';
  const picture = document.createElement('img');
  const hint = document.createElement('p');
  hint.className = 'fx-capture-hint';
  const logDetails = document.createElement('details');
  const logTitle = document.createElement('summary');
  const logs = document.createElement('pre');
  logDetails.append(logTitle, logs);
  const identityDetails = document.createElement('details');
  const identityTitle = document.createElement('summary');
  const identity = document.createElement('pre');
  identityDetails.append(identityTitle, identity);
  surface.append(toolbar, summary, metadata, picture, hint, logDetails, identityDetails);

  const bind = async (args: { root: string | null }) => {
    if (busy) return;
    busy = true;
    actionError = '';
    attemptedRoot = args.root ?? undefined;
    render();
    try {
      const next = await client.call<DisplayStatusInput>('display.bind', args, { reportError: false });
      if (live) status.update(next);
    } catch (error) { if (live) actionError = failureText(error); }
    finally { busy = false; if (live) render(); }
  };
  let playFrame: PlayFrame | undefined;
  let playKey = '';
  let playGeneration = 0;
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  let playAbort: AbortController | undefined;
  const activePlay = () => {
    const play = workspace?.play;
    const target = play?.target;
    return typeof target?.targetId === 'string' && target.targetId && typeof target.generation === 'number' ? play : null;
  };
  const selectedSource = () => sourceChoice ?? (activePlay() ? 'play' : status.snapshot().binding ? 'run' : 'play');
  const stopPlayCapture = () => {
    playGeneration += 1;
    clearTimeout(playTimer);
    playTimer = undefined;
    playAbort?.abort();
    playAbort = undefined;
  };
  const watchPlay = () => {
    const token = playGeneration;
    const abort = new AbortController();
    playAbort = abort;
    const step = async () => {
      if (!live || token !== playGeneration) return;
      const play = activePlay();
      if (!play || play.phase !== 'running' || typeof play.target.generation !== 'number') return;
      const target = { targetId: play.target.targetId, generation: play.target.generation };
      const args = { targetId: target.targetId, targetGeneration: target.generation };
      const options = { signal: abort.signal, reportError: false };
      try {
        const captured = await (typeof client.capture === 'function'
          ? client.capture({ ...args, ...options })
          : client.call('preview.capture', args, options)) as { png?: string; frameId?: number } | null;
        if (!live || token !== playGeneration) return;
        playFrame = { ...target, png: captured?.png, frameId: captured?.frameId, capturedAt: new Date().toISOString(), error: '' };
      } catch (error) {
        if (!live || token !== playGeneration || abort.signal.aborted) return;
        const busy = failureText(error).includes('preview capture is busy')
          || (error && typeof error === 'object' && 'code' in error && (error.code === 'view-workspace-target-busy' || error.code === 'engine-workspace-target-busy'));
        playFrame = { ...playFrame, ...target, error: busy ? '' : failureText(error) };
      }
      render();
      if (!live || token !== playGeneration || activePlay()?.phase !== 'running') return;
      playTimer = setTimeout(step, 1000);
    };
    void step();
  };
  const syncPlay = () => {
    const play = activePlay();
    if (play && (playFrame?.targetId !== play.target.targetId || playFrame.generation !== play.target.generation)) playFrame = undefined;
    const key = visible && selectedSource() === 'play' && play?.phase === 'running'
      ? `${play.target.targetId}:${play.target.generation}` : '';
    if (key === playKey) return;
    playKey = key;
    stopPlayCapture();
    if (key) watchPlay();
  };
  const attach = () => {
    if (selectedSource() === 'run' && workspace?.project?.root) void bind({ root: workspace.project.root });
  };
  const detach = () => { if (selectedSource() === 'run') void bind({ root: null }); };
  const chooseSource = () => { sourceChoice = source.value === 'run' ? 'run' : 'play'; actionError = ''; syncPlay(); render(); };
  connect.addEventListener('click', attach);
  disconnect.addEventListener('click', detach);
  source.addEventListener('change', chooseSource);
  const text = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };
  const showImage = (png: string | undefined) => {
    if (png?.startsWith('data:image/png;base64,')) {
      if (picture.getAttribute('src') !== png) picture.setAttribute('src', png);
      picture.hidden = false;
    } else {
      if (picture.getAttribute('src') !== null) picture.removeAttribute('src');
      picture.hidden = true;
    }
  };
  const render = () => {
    const value = status.snapshot();
    const playMode = selectedSource() === 'play';
    source.value = playMode ? 'play' : 'run';
    source.setAttribute('aria-label', t('display.source'));
    text(sourceText, t('display.source'));
    text(playOption, t('display.play'));
    text(runOption, t('display.independent'));
    const projectRoot = !playMode && value.binding ? value.binding.root : workspace?.project?.root;
    text(project, projectRoot === workspace?.project?.root ? workspace?.project?.name ?? t('display.noProject') : projectRoot?.split(/[\\/]/).pop() ?? t('display.noProject'));
    project.title = projectRoot ?? '';
    text(connect, t(value.binding ? 'display.reconnect' : 'display.connect'));
    text(disconnect, t('display.disconnect'));
    connect.hidden = playMode;
    disconnect.hidden = playMode || !value.binding;
    connect.disabled = busy || !workspace?.project?.root;
    disconnect.disabled = busy;
    const play = activePlay();
    const observation = playMode ? null : value.observation;
    const image = playMode ? playFrame : observation?.image;
    const error = playMode ? playFrame?.error : actionError || value.error;
    const phase = playMode ? play?.phase : observation?.status?.phase;
    const ended = playMode ? !play && !!playFrame : value.status === 'unavailable' && !!observation;
    const empty = playMode ? 'display.noPlay' : attemptedRoot === workspace?.project?.root ? 'display.noRun' : 'display.notConnected';
    text(summary, busy && !playMode ? t('display.connecting') : error || t(ended ? 'display.ended' : phase ? `display.phase.${phase}` : empty));
    const stamp = image?.capturedAt;
    const stale = ended || !!stamp && (Date.now() - Date.parse(stamp) > 15000 || (playMode ? play?.phase !== 'running' : phase !== 'ready' || 'revision' in image && image.revision !== observation?.status?.revision));
    text(metadata, stamp ? `${t('display.captured', { time: new Date(stamp).toLocaleTimeString(getLocale()) })}${image?.frameId === undefined ? '' : ` · ${t('display.frame', { frame: image.frameId })}`}${stale ? ` · ${t('display.lastImage')}` : ''}` : '');
    picture.alt = t('display.image');
    showImage(image?.png);
    text(hint, t(playMode ? 'display.playHint' : 'display.runHint'));
    text(logTitle, t('display.logs'));
    logs.setAttribute('aria-label', t('display.logs'));
    text(logs, (observation?.droppedLogs ? t('display.omitted', { count: observation.droppedLogs }) + '\n' : '') + (observation?.logs?.map(entry => `[${entry.sequence}] ${entry.level}: ${entry.text}`).join('\n') ?? ''));
    logDetails.hidden = !logs.textContent;
    text(identityTitle, t('display.details'));
    text(identity, playMode ? playFrame ? `Target: ${playFrame.targetId}\nGeneration: ${playFrame.generation}` : '' : value.binding ? `Project: ${value.binding.root}\nRun: ${value.binding.runId}\nInput: ${observation?.status?.inputVersion ?? ''}` : '');
    identityDetails.hidden = !identity.textContent;
  };
  const unsubscribeObservation = status.subscribe(() => {
    if (sourceChoice === undefined && status.snapshot().binding && !activePlay()) sourceChoice = 'run';
    syncPlay(); render();
  });
  const reader = createWorkspaceStateReader(typeof client?.subscribe === 'function' ? client as WorkspaceStateClient : undefined);
  const unsubscribeWorkspace = reader.subscribe(() => {
    const next = reader.getSnapshot();
    if (workspace?.project?.root !== next?.project?.root) { playFrame = undefined; attemptedRoot = undefined; actionError = ''; }
    workspace = next;
    if (sourceChoice === undefined && activePlay()) sourceChoice = 'play';
    syncPlay();
    if (live) render();
  });
  const stopVisibility = observeElementVisibility(surface, next => { visible = next; syncPlay(); });
  const unsubscribeLocale = subscribeLocale(render);
  render();
  return () => {
    live = false;
    stopVisibility();
    stopPlayCapture();
    unsubscribeObservation();
    unsubscribeWorkspace();
    unsubscribeLocale();
    reader.dispose();
    connect.removeEventListener('click', attach);
    disconnect.removeEventListener('click', detach);
    source.removeEventListener('change', chooseSource);
  };
}
