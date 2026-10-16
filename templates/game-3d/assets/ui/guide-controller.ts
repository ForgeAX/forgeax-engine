import type { GameHost } from '@forgeax/engine/app';
import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine/ui';
import { bindUiLocalization, createUiLocalization } from '@forgeax/engine/ui/localization';
import { installVaseControls } from './vase-controls.ts';
import { installPlayerControls } from './player-controls.ts';

/** One authored controller for every presentation Host and the UI diagnostic. */
export async function createGuideUi(
  asset: UiAsset,
  host: Pick<GameHost, 'uiRoot' | 'controlMode' | 'port' | 'presentationPort'>,
): Promise<UiInstance> {
  const root = host.uiRoot;
  if (!root) throw new Error('game-3d UI requires GameHost.uiRoot in the presentation realm');
  const localized = await createUiLocalization(asset, { lng: 'en' });
  if (!localized.ok) throw localized.error;
  const i18n = localized.value;
  const mounted = mountUi(asset, {
    root,
    layer: 50,
    onAction: (action) => {
      if (action === 'language-en' || action === 'language-fr') void i18n.changeLanguage(action.slice(9));
    },
  });
  if (!mounted.ok) throw mounted.error;
  const ui = mounted.value;
  const releases: (() => void)[] = [() => ui.dispose()];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const release of releases.reverse()) {
      try { release(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) throw new AggregateError(failures, 'Guide UI disposal failed');
  };
  try {
    const shadow = ui.host.shadowRoot;
    const port = host.presentationPort ?? host.port;
    const playerControls = port && shadow ? installPlayerControls(shadow, port) : undefined;
    if (playerControls) releases.push(() => playerControls.dispose());
    const vaseControls = port && shadow
      ? installVaseControls(shadow, port, (key, options) => i18n.t(key, options)) : undefined;
    if (vaseControls) releases.push(() => vaseControls.dispose());
    else shadow?.querySelector<HTMLButtonElement>('[data-ui-part="vase-controls"] button')?.setAttribute('disabled', '');
    const vaseToggle = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="vase-toggle"]');
    let lastMode: string | undefined;
    let vaseOpen = true;
    const update = () => {
      const mode = host.controlMode?.read() ?? 'pointer';
      const locked = mode === 'pointer-locked';
      if (lastMode !== mode) {
        playerControls?.reset();
        vaseOpen = mode !== 'touch';
        lastMode = mode;
      }
      ui.host.classList.toggle('touch', mode === 'touch');
      ui.host.classList.toggle('controls-ready', playerControls !== undefined);
      ui.host.classList.toggle('vase-open', vaseOpen);
      ui.host.classList.toggle('locked', locked);
      playerControls?.setEnabled(mode === 'touch' && !vaseOpen);
      if (vaseToggle) {
        vaseToggle.setAttribute('aria-expanded', String(vaseOpen));
        vaseToggle.textContent = i18n.t(vaseOpen ? 'closeVase' : 'openVase');
      }
      const label = ui.host.shadowRoot?.querySelector<HTMLElement>('[data-ui-slot="lock"]');
      if (label) label.textContent = i18n.t(locked ? 'lock' : mode === 'touch' ? (playerControls ? 'touch' : 'touchUnavailable') : 'unlock');
      for (const [part, key] of [['guide-title', 'title'], ['guide-controls', mode === 'touch' ? 'touchControls' : 'controls'],
        ['move-label', 'move'], ['look-label', 'look'], ['look-hint', 'lookHint'], ['jump', 'jump'], ['run', 'run'],
        ['vase-description', 'vase.description']]) {
        const node = ui.host.shadowRoot?.querySelector<HTMLElement>(`[data-ui-part="${part}"]`);
        if (node) node.textContent = i18n.t(key);
      }
      shadow?.querySelector('.vase-panel')?.setAttribute('aria-label', i18n.t('vase.label'));
      if (vaseControls) vaseControls.localize();
      else {
        const button = shadow?.querySelector<HTMLButtonElement>('[data-ui-part="vase-controls"] button');
        if (button) button.textContent = i18n.t('vase.generate');
        const status = shadow?.querySelector<HTMLElement>('[data-ui-part="vase-status"]');
        if (status) status.textContent = i18n.t('vase.unavailable');
      }
      ui.host.lang = i18n.resolvedLanguage ?? i18n.language;
    };
    if (vaseToggle) {
      const toggleVase = () => { playerControls?.reset(); vaseOpen = !vaseOpen; update(); };
      vaseToggle.addEventListener('click', toggleVase);
      releases.push(() => vaseToggle.removeEventListener('click', toggleVase));
    }
    if (host.controlMode) releases.push(host.controlMode.subscribe(update));
    releases.push(bindUiLocalization(ui, i18n, update));
    return { host: ui.host, signal: ui.signal, resourceUrl: ui.resourceUrl, dispose };
  } catch (cause) {
    try { dispose(); } catch (cleanupCause) { throw new AggregateError([cause, cleanupCause], 'Guide UI initialization failed'); }
    throw cause;
  }
}
