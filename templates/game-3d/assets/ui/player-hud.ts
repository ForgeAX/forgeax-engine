import { PLAYER_STATE_CHANNEL, type PlayerHudState } from '../shared/player-protocol.ts';

/** Engine -> UI example: a read-only readout of player state received over the host port. */
export function installPlayerHud(root: ShadowRoot, port: MessagePort) {
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-ui-part="${name}"]`);
  const height = part('hud-height'), speed = part('hud-speed'), ground = part('hud-ground');
  const receive = (event: MessageEvent) => {
    if (event.data?.channel !== PLAYER_STATE_CHANNEL || !height || !speed || !ground) return;
    const state = event.data.state as PlayerHudState;
    height.textContent = `Height ${state.height.toFixed(1)} m`;
    speed.textContent = `Speed ${state.speed.toFixed(1)} m/s`;
    ground.textContent = state.grounded ? 'On ground' : 'In air';
  };
  port.addEventListener('message', receive);
  port.start();
  return { dispose: () => port.removeEventListener('message', receive) };
}
