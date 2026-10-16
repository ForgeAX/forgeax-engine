import { it } from 'vitest';
import { bundleStressCases, runRenderBundleStressCase } from './render-bundle-stress.fixture';

it.each(
  bundleStressCases,
)('keeps Browser bundle pixels and replay equivalent under %s', async (scenario) => {
  await runRenderBundleStressCase(scenario);
}, 180_000);
