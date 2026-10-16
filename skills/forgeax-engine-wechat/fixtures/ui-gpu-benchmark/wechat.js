import { installWechatStandards } from '@forgeax/engine/platform-wechat/standards';
import { createBenchmarkDriver, describeBenchmarkError } from './driver.js';
import { identity } from '@probe/identity';

let startup = { phase: 'loading', identity };
globalThis.__forgeaxUiBenchmark = { read: () => startup };
Promise.resolve()
  .then(() => {
    installWechatStandards().unwrap();
    return import('./benchmark.js');
  })
  .then(({ nativeUiProbe }) => {
    globalThis.__forgeaxUiBenchmark = createBenchmarkDriver(nativeUiProbe, identity);
    console.info('FORGEAX_UI_BENCHMARK_READY', JSON.stringify(identity));
  })
  .catch((error) => {
    startup = {
      phase: 'failed',
      identity,
      error: describeBenchmarkError(error),
    };
    console.error('FORGEAX_UI_BENCHMARK_STARTUP_FAILED', JSON.stringify(startup));
  });
