import { rhi } from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import {
  FORWARD_RESOLVE_CASES,
  verifyForwardResolvePlacement,
} from './forward-resolve-placement.gpu-fixture';

it.each(
  FORWARD_RESOLVE_CASES,
)('preserves native 4x pixels with $resolves resolves (reader=$reader empty=$empty conditional=$conditional imported=$imported automatic=$automatic)', async (options) => {
  await verifyForwardResolvePlacement(rhi, options);
});
