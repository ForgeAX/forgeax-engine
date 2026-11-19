import { VASE_CHANNEL, type VaseState } from '../shared/vase-protocol.ts';

const PRESETS = [
  { height: 2.4, radius: 0.75, sides: 32 },
  { height: 3.4, radius: 0.5, sides: 12 },
  { height: 1.6, radius: 1.1, sides: 48 },
];
/** A request without a state reply (vase plugin removed or busy elsewhere) must not lock the button. */
export const VASE_REPLY_TIMEOUT_MS = 10_000;

function describe(state: VaseState): string {
  const exists = state.vertexCount !== undefined;
  if (state.busy) return 'Generating...';
  if (state.error) return exists ? 'Previous vase kept' : 'Vase unavailable';
  return exists ? `Vase ready (${state.vertexCount} vertices)` : 'No vase yet';
}

/** UI -> engine example: one button posts a message over GameHost.port; the engine replies with state. */
export function installVaseButton(root: ShadowRoot, port: MessagePort) {
  const button = root.querySelector<HTMLButtonElement>('[data-ui-part="vase-button"]');
  const status = root.querySelector<HTMLElement>('[data-ui-part="vase-status"]');
  if (!button || !status) throw new Error('Vase button UI is incomplete');
  let next = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const receive = (event: MessageEvent) => {
    if (event.data?.channel !== VASE_CHANNEL || event.data.kind !== 'state') return;
    const state = event.data.state as VaseState;
    clearTimer();
    button.disabled = state.busy;
    status.textContent = describe(state);
  };
  const click = () => {
    if (button.disabled) return;
    button.disabled = true;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      button.disabled = false;
      status.textContent = 'No reply from the vase; try again';
    }, VASE_REPLY_TIMEOUT_MS);
    port.postMessage({
      channel: VASE_CHANNEL,
      kind: 'generate',
      values: PRESETS[next++ % PRESETS.length],
    });
  };
  button.addEventListener('click', click);
  port.addEventListener('message', receive);
  port.start();
  port.postMessage({ channel: VASE_CHANNEL, kind: 'inspect' });
  return {
    dispose() {
      clearTimer();
      button.removeEventListener('click', click);
      port.removeEventListener('message', receive);
    },
  };
}
