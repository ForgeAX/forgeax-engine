import { installWechatStandards } from '@forgeax/engine/platform-wechat/standards';
import { describeBenchmarkError } from './driver.js';
import { identity, sceneName } from '@probe/identity';

globalThis[`__forgeaxUi${sceneName}`] = { read: () => ({ phase: 'loading', identity }) };
Promise.resolve()
  .then(() => {
    installWechatStandards().unwrap();
    return import('./interactive.js');
  })
  .then(({ startInteractiveUi }) => startInteractiveUi())
  .catch((error) => {
    const state = { phase: 'failed', identity, error: describeBenchmarkError(error) };
    globalThis[`__forgeaxUi${sceneName}`] = { read: () => state };
    console.error(`FORGEAX_UI_${sceneName.toUpperCase()}_FAILURE`, JSON.stringify(state));
  });
