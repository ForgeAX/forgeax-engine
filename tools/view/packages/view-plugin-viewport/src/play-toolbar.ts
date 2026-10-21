import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceState } from '@forgeax/view-workspace-core/contract';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';

// Lucide 0.460.0 icon geometry, kept local because the Engine-pinned workspace lockfile cannot be changed by View.
const iconPaths = {
  gamepad2: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  'monitor-play': '<path d="M10 7.75a.75.75 0 0 1 1.142-.638l3.664 2.249a.75.75 0 0 1 0 1.278l-3.664 2.25a.75.75 0 0 1-1.142-.64z"/><path d="M12 17v4"/><path d="M8 21h8"/><rect x="2" y="3" width="20" height="14" rx="2"/>',
  'mouse-pointer2': '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
} as const;
type IconName = keyof typeof iconPaths;
const iconMarkup = (name: IconName) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name} fx-icon" aria-hidden="true">${iconPaths[name]}</svg>`;

/** Presentation commands use the same target API as the CLI and object panels. */
export function mountPlayToolbar({ document, element, client }: { document: Document; element: HTMLElement; client: ViewWorkspaceClient }) {
  const toolbar = document.createElement('div');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Scene execution');
  toolbar.className = 'fx-toolbar fx-toolbar--viewport';
  const surface = document.createElement('div');
  Object.assign(surface.style, { position: 'relative', flex: '1', minHeight: '0' });
  Object.assign(element.style, { display: 'flex', flexDirection: 'column', height: '100%' });
  element.append(toolbar, surface);
  let state: WorkspaceState | null = null;
  let errorText = '';
  let disposed = false;
  let playRequest: AbortController | undefined;
  let playStage = '';
  const pending = new Set<string>();
  const buttons: { button: HTMLButtonElement; label: () => string; icon: () => IconName; available: () => boolean; visible: () => boolean }[] = [];
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.style.color = 'var(--fx-color-text-secondary)';
  // Always-visible navigation hint in the viewport corner; pointer-events stay
  // off so it never intercepts camera input.
  const navHint = document.createElement('div');
  navHint.textContent = 'WASD/QE move · Shift boost · RMB look/fly · wheel speed · F focus';
  Object.assign(navHint.style, {
    position: 'absolute', right: '8px', bottom: '6px', zIndex: '1',
    fontSize: '11px', lineHeight: '1.4', pointerEvents: 'none', userSelect: 'none',
    color: 'var(--fx-color-text-secondary)', opacity: '0.75',
    textShadow: '0 1px 2px var(--fx-color-background, rgba(0,0,0,0.5))',
  });
  surface.append(navHint);
  const args = () => ({ targetId: state!.play!.target.targetId, targetGeneration: state!.play!.target.generation });
  const control = () => state?.targetBinding === 'play' ? (state?.preview?.camera as { control?: string } | undefined)?.control : undefined;
  const running = () => state?.play?.phase === 'running' && state?.targetBinding === 'play';
  const add = (name: string | (() => string), icon: () => IconName, run: (action: string) => unknown, available: () => boolean, visible = available) => {
    const label = typeof name === 'string' ? () => name : name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fx-button fx-button--compact fx-button--icon';
    button.setAttribute('data-action', `scene.${label().toLowerCase()}`);
    button.setAttribute('aria-label', label());
    button.title = label();
    button.innerHTML = iconMarkup(icon());
    button.addEventListener('click', async () => {
      const action = label();
      pending.add(action); errorText = ''; render();
      try { await run(action); if (!disposed) state = await client.getState(); }
      catch (error) { if (!disposed) errorText = error instanceof Error ? ('hint' in error && typeof error.hint === 'string' ? error.hint : error.message) : String(error); }
      finally { pending.delete(action); if (!disposed) render(); }
    });
    buttons.push({ button, label, icon, available, visible }); toolbar.append(button);
  };
  add(() => state?.play || pending.has('Play') ? 'Stop' : 'Play', () => state?.play || pending.has('Play') ? 'square' : 'play', async (action) => {
    if (action === 'Stop') {
      playRequest?.abort();
      if (state?.play) await client.call('play.stop', args());
      return;
    }
    const controller = new AbortController();
    const started = performance.now();
    const log = (stage: string) => console.info('[forgeax.play]', JSON.stringify({
      stage, elapsedMs: Math.round(performance.now() - started),
    }));
    playRequest = controller;
    try {
      log('click');
      const options = { signal: controller.signal };
      log('play.start');
      const opened = await client.call<WorkspaceState>('play.start', { projectId: state!.project!.id }, options);
      log('play.start-returned');
      controller.signal.throwIfAborted();
      state = opened;
      playStage = 'Waiting for the game page…';
      render();
      const target = { targetId: opened.play!.target.targetId, targetGeneration: opened.play!.target.generation };
      log('play.ready');
      await client.call('play.ready', target, options);
      log('play.ready-returned');
      controller.signal.throwIfAborted();
      playStage = 'Reading the game camera…';
      render();
      log('camera.get');
      await client.call('camera.get', target, options);
      log('camera.get-returned');
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      playStage = '';
      if (playRequest === controller) playRequest = undefined;
    }
  }, () => !!state?.project || !!state?.play || pending.has('Play'), () => true);
  add('Eject', () => 'log-out', () => client.call('target.control', { ...args(), mode: 'observer' }), () => running() && control() !== 'observer');
  add('Possess', () => 'gamepad2', () => client.call('target.control', { ...args(), mode: 'player' }), () => running() && control() === 'observer');
  add('Scene', () => 'mouse-pointer2', () => client.call('target.select', { targetId: state!.scenePreview!.target.targetId }), () => !!state?.scenePreview && state?.targetBinding === 'play');
  add('Game', () => 'monitor-play', async () => {
    await client.call('target.select', { targetId: state!.play!.target.targetId });
    await client.call('camera.get', args());
  }, () => !!state?.play && state?.targetBinding !== 'play');
  toolbar.append(status);
  const render = () => {
    for (const { button, label, icon, available, visible } of buttons) {
      const action = label();
      if (button.getAttribute('aria-label') !== action) {
        button.setAttribute('aria-label', action);
        button.title = action;
        button.innerHTML = iconMarkup(icon());
        button.setAttribute('data-action', `scene.${action.toLowerCase()}`);
      }
      button.style.display = visible() ? '' : 'none';
      const disabled = pending.has(action) || (pending.size > 0 && action !== 'Stop') || !available();
      if (button.disabled !== disabled) button.disabled = disabled;
    }
    const target = state?.targetBinding ?? 'scene';
    if (surface.dataset.forgeaxToolTarget !== target) surface.dataset.forgeaxToolTarget = target;
    const nextStatus = errorText || (pending.has('Stop') ? 'Stopping…'
      : pending.has('Play') ? (playStage || 'Preparing Play…')
      : state?.play?.phase === 'starting' ? 'Preparing Play…' : '');
    status.hidden = !nextStatus;
    if (status.textContent !== nextStatus) status.textContent = nextStatus;
  };
  const reader = createWorkspaceStateReader(client);
  const unsubscribe = reader.subscribe(() => { if (!disposed) { state = reader.getSnapshot(); render(); } });
  render();
  return { surface,
    dispose() { disposed = true; playRequest?.abort(); unsubscribe(); toolbar.remove(); surface.remove(); } };
}
