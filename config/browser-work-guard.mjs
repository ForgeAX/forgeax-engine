import { afterAll } from 'vitest';
import { requireNativeBrowserAdapter } from '../scripts/ci/browser-native-admission.mjs';
import budgets from '../scripts/ci/browser-work-budgets.json' with { type: 'json' };
import { checkBrowserWorkBudget, countBrowserWork } from '../scripts/test/browser-work.mjs';

if (import.meta.env.FORGEAX_BROWSER_GPU === 'native') {
  if (!navigator.gpu) throw new Error('Browser native GPU admission requires WebGPU');
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (...args) => {
    const adapter = await requestAdapter(...args);
    const identity = requireNativeBrowserAdapter(adapter);
    console.info(`[browser-native-admission] ${JSON.stringify(identity)}`);
    return adapter;
  };
}

const work = countBrowserWork();
// biome-ignore lint/correctness/noEmptyPattern: Vitest suite fixture arguments require destructuring.
afterAll(({}, suite) => {
  const file = 'filepath' in suite ? suite : suite.file;
  file.meta.browserWork = { ...work.counts };
  work.restore();
  checkBrowserWorkBudget(file.filepath, work.counts, budgets);
});
