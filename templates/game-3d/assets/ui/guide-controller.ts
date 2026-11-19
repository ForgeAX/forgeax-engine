import type { GameHost } from '@forgeax/engine/app';
import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine/ui';
import { installPlayerControls } from './player-controls.ts';
import { installPlayerHud } from './player-hud.ts';

export interface GuideUiOptions {
  /**
   * Show the screen-centre crosshair while the pointer is locked. Off by default:
   * the third-person camera frames the player off the screen centre, so a fixed
   * crosshair does not mark what the player faces. Turn it on for aiming games.
   */
  readonly crosshair?: boolean;
}

/** Mounts the guide UI: engine -> HUD over the port, touch controls -> engine. */
export async function createGuideUi(
  asset: UiAsset,
  host: Pick<GameHost, 'uiRoot' | 'controlMode' | 'port' | 'presentationPort'>,
  options: GuideUiOptions = {},
): Promise<UiInstance> {
  const root = host.uiRoot;
  if (!root) throw new Error('game-3d UI requires GameHost.uiRoot in the presentation realm');
  const mounted = mountUi(asset, { root, layer: 50 });
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
    let touch: ReturnType<typeof installPlayerControls> | undefined;
    if (port && shadow) {
      touch = installPlayerControls(shadow, port);
      releases.push(() => touch?.dispose());
      const hud = installPlayerHud(shadow, port);
      releases.push(() => hud.dispose());
    }
    let lastMode: string | undefined;
    const update = () => {
      const mode = host.controlMode?.read() ?? 'pointer';
      const locked = mode === 'pointer-locked';
      if (mode !== lastMode) touch?.reset();
      lastMode = mode;
      ui.host.classList.toggle('touch', mode === 'touch');
      ui.host.classList.toggle('controls-ready', touch !== undefined);
      ui.host.classList.toggle('aim', options.crosshair === true && locked);
      ui.host.classList.toggle('locked', locked);
      touch?.setEnabled(mode === 'touch');
      const hint = shadow?.querySelector<HTMLElement>('[data-ui-slot="hint"]');
      if (hint) {
        hint.textContent = mode === 'touch' ? 'Stick move · drag look · Jump · hold Run'
          : 'Mouse look · WASD move · Space jump · Shift run · T transform · Esc release';
      }
      const label = shadow?.querySelector<HTMLElement>('[data-ui-slot="lock"]');
      if (label) {
        label.textContent = locked ? 'Camera locked · mouse look active'
          : mode === 'touch' ? (touch ? 'Touch: left stick moves, right pad looks' : 'Touch controls unavailable')
          : 'Click to lock camera, or hold right mouse to look';
      }
    };
    update();
    if (host.controlMode) releases.push(host.controlMode.subscribe(update));
    return { host: ui.host, signal: ui.signal, resourceUrl: ui.resourceUrl, dispose };
  } catch (cause) {
    try { dispose(); } catch (cleanupCause) { throw new AggregateError([cause, cleanupCause], 'Guide UI initialization failed'); }
    throw cause;
  }
}
