import type { UiAsset, UiInstance } from '@forgeax/engine/ui';
import localization from '../../../templates/game-3d/assets/guide.ui.i18n.json';
import { createGuideUi } from '../../../templates/game-3d/assets/ui/guide-controller.ts';
import { VASE_CHANNEL, VASE_DEFAULTS, type VaseState } from '../../../templates/game-3d/assets/runtime-vase/vase-program.ts';

/** UI-owner diagnostic using the real authored view/behavior and a borrowed channel.
 * Its generated state is a fixture and makes no 3D presentation claim. */
export async function installGuideUiFixture(
  root: HTMLElement,
  asset: UiAsset,
  channel: Pick<MessageChannel, 'port1' | 'port2'>,
  onGenerate: (values: Readonly<Record<string, number>>) => void,
) {
  const setState = (state: Partial<VaseState>) => channel.port2.postMessage({
    channel: VASE_CHANNEL, kind: 'state',
    state: { guid: 'ui-diagnostic-vase', busy: false, values: VASE_DEFAULTS, vertexCount: 1216, ...state },
  });
  const receive = (event: MessageEvent) => {
    if (event.data?.channel !== VASE_CHANNEL) return;
    if (event.data.kind === 'inspect') setState({});
    if (event.data.kind === 'generate') {
      setState({ busy: true });
      onGenerate(event.data.values);
    }
  };
  channel.port2.addEventListener('message', receive);
  channel.port2.start();
  let ui: UiInstance;
  try {
    ui = await createGuideUi({ ...asset, localization: asset.localization ?? localization }, {
      uiRoot: root, port: channel.port1,
      controlMode: { read: () => 'touch', subscribe: () => () => {} },
    });
  } catch (cause) { channel.port2.removeEventListener('message', receive); throw cause; }
  return {
    host: ui.host, setState,
    dispose() {
      ui.dispose();
      channel.port2.removeEventListener('message', receive);
    },
  };
}
