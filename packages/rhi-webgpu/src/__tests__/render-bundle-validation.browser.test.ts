import { it } from 'vitest';
import { runRenderBundleValidation } from './render-bundle-validation.fixture';

it(
  'validates reusable bundles, attachment compatibility, destroyed resources and pass-state reset in Browser WebGPU',
  runRenderBundleValidation,
  60_000,
);
