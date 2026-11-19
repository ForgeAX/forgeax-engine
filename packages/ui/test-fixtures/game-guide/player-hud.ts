import { PLAYER_STATE_CHANNEL, type PlayerHudState } from './protocol.ts';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Presentation-only readout of engine-owned player state received over the host port. */
export function installPlayerHud(root: ShadowRoot, port: MessagePort, t: Translate) {
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-ui-part="${name}"]`);
  const height = part('hud-height'), speed = part('hud-speed'), ground = part('hud-ground');
  let last: PlayerHudState | undefined;
  const render = () => {
    if (!last || !height || !speed || !ground) return;
    height.textContent = t('hud.height', { value: last.height.toFixed(1) });
    speed.textContent = t('hud.speed', { value: last.speed.toFixed(1) });
    ground.textContent = t(last.grounded ? 'hud.ground' : 'hud.air');
  };
  const receive = (event: MessageEvent) => {
    if (event.data?.channel !== PLAYER_STATE_CHANNEL) return;
    last = event.data.state as PlayerHudState;
    render();
  };
  port.addEventListener('message', receive);
  port.start();
  return { localize: render, dispose: () => port.removeEventListener('message', receive) };
}
