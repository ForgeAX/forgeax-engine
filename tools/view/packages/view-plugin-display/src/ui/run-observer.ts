/** DOM presentation only; the frontend Fiber owns this mount and its disposal. */
import { observeElementVisibility } from '@forgeax/view-components/visibility';
import type { ViewDisplayStatus, DisplayStatusInput } from '../status.ts';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { createWorkspaceStateReader, type WorkspaceStateClient } from '@forgeax/view-workspace-core/workspace-state';

type ObserverClient = Pick<ViewWorkspaceClient, 'call'> & Partial<Pick<ViewWorkspaceClient, 'capture'>> & Partial<WorkspaceStateClient>;
type PlayFrame = { targetId: string; png?: string; frameId?: number; error: string };

function failureText(error: unknown): string {
  if (error && typeof error === 'object' && 'hint' in error && typeof error.hint === 'string') return error.hint;
  return error instanceof Error ? error.message : String(error);
}

export function mountRunObserver({ document, surface, status, client }: { document: Document; surface: HTMLElement; status: ViewDisplayStatus; client: ObserverClient }) {
  let live = true;
  let visible = false;
  const summary = document.createElement('p');
  summary.setAttribute('role', 'status');
  const picture = document.createElement('img');
  picture.alt = 'Latest Engine run capture';
  const logs = document.createElement('pre');
  logs.setAttribute('aria-label', 'Run log');
  const form = document.createElement('form');
  const project = document.createElement('input');
  project.className = 'fx-input';
  project.placeholder = 'Engine project path';
  project.setAttribute('aria-label', 'Observed project path');
  const run = document.createElement('input');
  run.className = 'fx-input';
  run.placeholder = 'Run ID';
  run.setAttribute('aria-label', 'Observed run ID');
  const connect = document.createElement('button');
  connect.className = 'fx-button fx-button--primary fx-button--compact';
  connect.type = 'submit'; connect.textContent = 'Observe run';
  const disconnect = document.createElement('button');
  disconnect.className = 'fx-button fx-button--secondary fx-button--compact';
  disconnect.type = 'button'; disconnect.textContent = 'Disconnect';
  form.append(project, run, connect, disconnect);
  const bind = async (args: { root: string | null; runId?: string }) => {
    connect.disabled = disconnect.disabled = true;
    try { const next = await client.call<DisplayStatusInput>('display.bind', args); if (live) status.update(next); }
    catch (error) { if (live) summary.textContent = failureText(error); }
    finally { if (live) connect.disabled = disconnect.disabled = false; }
  };
  let workspace: WorkspaceState | null = null;
  let playFrame: PlayFrame | undefined;
  let playKey = '';
  let playGeneration = 0;
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  let playAbort: AbortController | undefined;
  const activePlay = () => {
    const play = workspace?.play;
    const target = play?.target;
    if (typeof target?.targetId !== 'string' || !target.targetId || typeof target.generation !== 'number') return null;
    return play;
  };
  const capturePlay = (target: { targetId: string; generation: number }, signal?: AbortSignal) => {
    const args = { targetId: target.targetId, targetGeneration: target.generation };
    const options = { ...(signal === undefined ? {} : { signal }), reportError: false };
    if (typeof client.capture === 'function') return client.capture({ ...args, ...options });
    return client.call('preview.capture', args, options);
  };
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
      try {
        const captured = await capturePlay(target, abort.signal) as { png?: string; frameId?: number } | null;
        if (!live || token !== playGeneration) return;
        const current = activePlay();
        if (current?.target.targetId !== target.targetId || current.phase !== 'running') return;
        playFrame = { targetId: target.targetId, png: captured?.png, frameId: captured?.frameId, error: '' };
      } catch (error) {
        if (!live || token !== playGeneration || abort.signal.aborted) return;
        const previous = playFrame?.targetId === target.targetId ? playFrame : undefined;
        const busy = failureText(error).includes('preview capture is busy')
          || (error && typeof error === 'object' && 'code' in error && (error.code === 'view-workspace-target-busy' || error.code === 'engine-workspace-target-busy'));
        playFrame = {
          targetId: target.targetId,
          png: previous?.png,
          frameId: previous?.frameId,
          error: busy ? '' : failureText(error),
        };
      }
      render();
      if (!live || token !== playGeneration || activePlay()?.phase !== 'running') return;
      playTimer = setTimeout(step, 1000);
    };
    void step();
  };
  const syncPlay = () => {
    const play = activePlay();
    const key = visible && play?.phase === 'running' && typeof play.target.generation === 'number'
      ? `${play.target.targetId}:${play.target.generation}`
      : '';
    if (key === playKey) return;
    playKey = key;
    playFrame = undefined;
    stopPlayCapture();
    if (key) watchPlay();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (activePlay()) return;
    const root = String(project.value ?? '').trim();
    const runId = String(run.value ?? '').trim();
    if (!root || !runId) {
      summary.textContent = 'Provide root and exact runId, or null root to disconnect.';
      return;
    }
    void bind({ root, runId });
  };
  const detach = () => { if (!activePlay()) void bind({ root: null }); };
  form.addEventListener('submit', submit);
  disconnect.addEventListener('click', detach);
  surface.append(form, summary, picture, logs);
  let bindingKey: string | undefined;
  const showImage = (png: string | undefined) => {
    if (png?.startsWith('data:image/png;base64,')) {
      if (picture.getAttribute('src') !== png) picture.setAttribute('src', png);
      if (picture.hidden !== false) picture.hidden = false;
      return;
    }
    if (picture.getAttribute('src') != null) picture.removeAttribute('src');
    if (picture.hidden !== true) picture.hidden = true;
  };
  const renderPlay = (play: NonNullable<WorkspaceState['play']>) => {
    if (form.hidden !== true) form.hidden = true;
    const frame = playFrame?.targetId === play.target.targetId ? playFrame : undefined;
    const nextSummary = frame?.error
      ? frame.error
      : play.phase === 'running'
        ? `Play · running${frame?.frameId === undefined ? '' : ` · Frame ${frame.frameId}`}${frame?.png ? '' : ' · Capturing…'}`
        : `Play · ${play.phase}`;
    if (summary.textContent !== nextSummary) summary.textContent = nextSummary;
    showImage(frame?.png);
    if (logs.textContent !== '') logs.textContent = '';
  };
  const render = () => {
    const play = activePlay();
    if (play) {
      renderPlay(play);
      return;
    }
    if (form.hidden) form.hidden = false;
    const value = status.snapshot();
    const nextKey = JSON.stringify(value.binding);
    if (bindingKey !== nextKey) {
      bindingKey = nextKey;
      project.value = value.binding?.root ?? '';
      run.value = value.binding?.runId ?? '';
    }
    const observation = value.observation;
    const image = observation?.image;
    const stamp = image?.capturedAt;
    const stale = stamp && (Date.now() - Date.parse(stamp) > 15000 || image.revision !== observation?.status?.revision || observation?.status?.phase !== 'ready');
    const nextSummary = value.error ?? (observation
      ? `${observation?.status?.phase ?? value.status}${observation?.status?.runId ? ` · Run ${observation.status.runId.slice(0, 8)}` : ''}${observation?.status?.inputVersion ? ` · Input ${observation.status.inputVersion.slice(7, 19)}` : ''} · ${stamp ? `Captured ${stamp}${image.frameId === undefined ? '' : ` · Frame ${image.frameId}`}${stale ? ' · Stale image' : ''}` : 'No captured image yet'}`
      : 'No Engine run is connected.');
    if (summary.textContent !== nextSummary) summary.textContent = nextSummary;
    showImage(image?.png);
    const nextLogs = (observation?.droppedLogs ? `${observation.droppedLogs} earlier log entries omitted.\n` : '') + (observation?.logs?.map(entry => `[${entry.sequence}] ${entry.level}: ${entry.text}`).join('\n') ?? '');
    if (logs.textContent !== nextLogs) logs.textContent = nextLogs;
  };
  const unsubscribeObservation = status.subscribe(render);
  const reader = createWorkspaceStateReader(client && typeof client.subscribe === 'function' ? client as WorkspaceStateClient : undefined);
  const unsubscribeWorkspace = reader.subscribe(() => {
    workspace = reader.getSnapshot();
    syncPlay();
    if (live) render();
  });
  const stopVisibility = observeElementVisibility(surface, next => { visible = next; syncPlay(); });
  render();
  const dispose = () => {
    live = false;
    stopVisibility();
    stopPlayCapture();
    unsubscribeObservation();
    unsubscribeWorkspace();
    reader.dispose();
    form.removeEventListener('submit', submit);
    disconnect.removeEventListener('click', detach);
  };
  return dispose;
}
